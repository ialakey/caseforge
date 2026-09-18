import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import type { Battle, CaseItem, Item, Prisma, PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import {
  type BattleActionResult,
  type BattleCaseView,
  type BattleDropView,
  type BattleMode,
  type BattlePlayerView,
  type BattleStatus,
  type BattleSummary,
  type BattleTally,
  type BattleView,
  type CaseItemView,
  type CreateBattleInput,
  ErrorCode,
  ItemRarity,
  battleEntryPrice,
  battleStandings,
  expandBattleRounds,
  pickByRoll,
  rangeChance,
  totalBattleRounds,
} from '@caseforge/shared';
import { computeRoll } from '@caseforge/shared/node';
import { PrismaService } from '../common/prisma.service';
import { PRISMA_READ } from '../common/prisma-read';
import { SettingsService } from '../common/settings.service';
import { CasesService } from '../cases/cases.service';
import { DropsService } from '../drops/drops.service';
import { ReferralService } from '../referral/referral.service';
import { badRequest, forbidden, notFound } from '../common/app-error';
import { REDIS_PUBLISHER } from '../common/redis.module';
import { BATTLES_CHANNEL, type BattleEvent } from './battles.events';

/**
 * How long the settling transaction may take.
 *
 * Four seats over thirty rounds is a hundred and twenty openings, a hundred and
 * twenty inventory rows and a seed reservation per player, all in one
 * transaction because a half-played battle has no meaning. The default five
 * seconds is not enough for the largest of those, and the alternative —
 * settling outside a transaction — would mean a battle that could pay some
 * players and not others.
 */
const SETTLE_TIMEOUT_MS = 30_000;
const SETTLE_MAX_WAIT_MS = 10_000;

/** How much of the lobby and of the history a listing returns. */
const LOBBY_LIMIT = 40;
const HISTORY_LIMIT = 12;

type CaseWithItems = Prisma.CaseGetPayload<{
  include: { items: { include: { item: true } } };
}>;

/** One drop, as the settlement produced it. */
interface RolledDrop {
  openingId: string;
  inventoryItemId: string;
  userId: string;
  slot: number;
  serverSeedId: string;
  clientSeedId: string;
  /** 1-based, matching the play order. */
  round: number;
  gameCase: CaseWithItems;
  caseItem: CaseItem & { item: Item };
  itemPrice: number;
  roll: number;
  nonce: number;
}

@Injectable()
export class BattlesService {
  private readonly logger = new Logger(BattlesService.name);

  constructor(
    private readonly prisma: PrismaService,
    /**
     * The lobby only. A single battle is read from the primary on purpose: the
     * player who just took a seat is handed that very battle back, and a
     * replica half a second behind would show them a seat they have paid for
     * and cannot see.
     */
    @Inject(PRISMA_READ) private readonly read: PrismaClient,
    private readonly settings: SettingsService,
    private readonly cases: CasesService,
    private readonly drops: DropsService,
    private readonly referral: ReferralService,
    @Inject(REDIS_PUBLISHER) private readonly publisher: Redis,
  ) {}

  /** The lobby: what can still be joined, and what has just been played. */
  async list(): Promise<{ open: BattleSummary[]; finished: BattleSummary[] }> {
    const [open, finished] = await Promise.all([
      this.read.battle.findMany({
        where: { status: { in: ['WAITING', 'RUNNING'] } },
        orderBy: { createdAt: 'desc' },
        take: LOBBY_LIMIT,
        include: summaryInclude,
      }),
      this.read.battle.findMany({
        where: { status: 'FINISHED' },
        orderBy: { finishedAt: 'desc' },
        take: HISTORY_LIMIT,
        include: summaryInclude,
      }),
    ]);

    return {
      open: open.map((battle) => toSummary(battle)),
      finished: finished.map((battle) => toSummary(battle)),
    };
  }

  /** One battle, with enough detail to play every reel back. */
  async get(battleId: string): Promise<BattleView> {
    const battle = await this.prisma.battle.findUnique({
      where: { id: battleId },
      include: {
        cases: {
          orderBy: { position: 'asc' },
          include: {
            case: {
              include: { items: { include: { item: true }, orderBy: { rangeFrom: 'asc' } } },
            },
          },
        },
        players: { orderBy: { slot: 'asc' }, include: { user: true } },
        openings: {
          orderBy: [{ battleRound: 'asc' }, { createdAt: 'asc' }],
          include: { item: true },
        },
      },
    });
    if (!battle) throw notFound(ErrorCode.BATTLE_UNAVAILABLE, 'Battle not found');

    const slotByUser = new Map(battle.players.map((p) => [p.userId, p.slot]));

    // Chances and ticket ranges come from the case's current contents; the
    // price does not. A drop is worth what it was worth when it dropped, and
    // the reel has to show that number rather than today's.
    const lineByCaseAndItem = new Map<string, CaseItem & { item: Item }>();
    for (const line of battle.cases) {
      for (const caseItem of line.case.items) {
        lineByCaseAndItem.set(`${line.caseId}:${caseItem.itemId}`, caseItem);
      }
    }

    const cases: BattleCaseView[] = battle.cases.map((line) => ({
      count: line.count,
      case: this.cases.toCaseView(line.case),
    }));

    const drops: BattleDropView[] = battle.openings.map((opening) => {
      const caseItem = lineByCaseAndItem.get(`${opening.caseId}:${opening.itemId}`);
      return {
        round: opening.battleRound ?? 0,
        slot: slotByUser.get(opening.userId) ?? 0,
        openingId: opening.id,
        item: {
          // The reel keys tiles by id; when the item has since been taken out
          // of the case there is no CaseItem row left to key by, and the item
          // id is the only identity the drop still has.
          id: caseItem?.id ?? opening.itemId,
          itemId: opening.itemId,
          marketHashName: opening.item.marketHashName,
          imageUrl: opening.item.imageUrl,
          rarity: opening.item.rarity as ItemRarity,
          price: opening.itemPrice,
          chance: caseItem ? rangeChance(caseItem) : 0,
          rangeFrom: caseItem?.rangeFrom ?? 0,
          rangeTo: caseItem?.rangeTo ?? 0,
        } satisfies CaseItemView,
        roll: opening.roll,
        nonce: opening.nonce,
      };
    });

    return {
      ...baseSummary(battle),
      cases,
      order: expandBattleRounds(battle.cases),
      players: battle.players.map(toPlayerView),
      drops,
      startedAt: battle.startedAt?.toISOString() ?? null,
    };
  }

  /**
   * Creates a battle and seats the host in it.
   *
   * The host pays for their seat here and now. A lobby full of unpaid
   * invitations would be free to spam, and the entry price is also what the
   * refund is measured against if the battle never fills.
   */
  async create(userId: string, input: CreateBattleInput): Promise<BattleActionResult> {
    await this.assertPlayable();

    const maxPlayers = this.settings.get<number>('battles.maxPlayers');
    const maxRounds = this.settings.get<number>('battles.maxRounds');
    if (input.slots > maxPlayers) {
      throw badRequest(ErrorCode.BATTLE_SIZE_INVALID, `At most ${maxPlayers} players per battle`);
    }

    const rounds = totalBattleRounds(input.cases);
    if (rounds > maxRounds) {
      throw badRequest(ErrorCode.BATTLE_SIZE_INVALID, `At most ${maxRounds} rounds per battle`);
    }

    const chosen = await this.prisma.case.findMany({
      where: { id: { in: input.cases.map((line) => line.caseId) } },
      include: { items: { select: { id: true } } },
    });
    if (chosen.length !== input.cases.length) {
      throw notFound(ErrorCode.CASE_UNAVAILABLE, 'Some of those cases do not exist');
    }
    for (const gameCase of chosen) {
      if (!gameCase.isActive) {
        throw badRequest(ErrorCode.CASE_UNAVAILABLE, `Case "${gameCase.name}" is unavailable`);
      }
      if (gameCase.items.length === 0) {
        throw badRequest(ErrorCode.CASE_EMPTY, `Case "${gameCase.name}" is empty`);
      }
    }

    const priceById = new Map(chosen.map((c) => [c.id, c.price]));
    const entryPrice = battleEntryPrice(input.cases, (id) => priceById.get(id) ?? 0);

    const { battleId, balanceAfter } = await this.prisma.$transaction(async (tx) => {
      await this.assertNotBanned(tx, userId);

      const battle = await tx.battle.create({
        data: {
          hostId: userId,
          mode: input.mode,
          slots: input.slots,
          rounds,
          entryPrice,
        },
      });

      await tx.battleCase.createMany({
        data: input.cases.map((line, index) => ({
          battleId: battle.id,
          caseId: line.caseId,
          position: index,
          count: line.count,
          // The price is frozen onto the line: a case re-priced while the
          // battle waits must not change what the people in it agreed to.
          price: priceById.get(line.caseId) ?? 0,
        })),
      });

      const seat = await this.takeSeat(tx, battle, userId);
      return { battleId: battle.id, balanceAfter: seat.balanceAfter };
    });

    const battle = await this.get(battleId);
    this.announce({ kind: 'battle', battle: await this.summary(battleId) });
    return { battle, balanceAfter };
  }

  /**
   * Takes a seat in somebody else's battle, and plays it when that was the
   * last one.
   *
   * Everything down to the settlement is one transaction: a seat paid for in a
   * battle that then failed to roll would leave money against nothing. The
   * seat itself is claimed with a conditional UPDATE on the counter rather
   * than by counting the seats first — between a count and an insert two
   * players fired together both see the last seat free and both take it.
   */
  async join(userId: string, battleId: string): Promise<BattleActionResult> {
    await this.assertPlayable();

    const outcome = await this.prisma.$transaction(
      async (tx) => {
        const battle = await tx.battle.findUnique({ where: { id: battleId } });
        if (!battle) throw notFound(ErrorCode.BATTLE_UNAVAILABLE, 'Battle not found');
        if (battle.status !== 'WAITING') {
          throw badRequest(ErrorCode.BATTLE_UNAVAILABLE, 'That battle is no longer open');
        }
        await this.assertNotBanned(tx, userId);

        const seated = await tx.battlePlayer.findUnique({
          where: { battleId_userId: { battleId, userId } },
        });
        if (seated) {
          throw badRequest(ErrorCode.BATTLE_ALREADY_JOINED, 'You are already in this battle');
        }

        const seat = await this.takeSeat(tx, battle, userId);
        const settled = seat.slot >= battle.slots ? await this.settle(tx, battleId) : null;
        return { balanceAfter: seat.balanceAfter, settled };
      },
      { timeout: SETTLE_TIMEOUT_MS, maxWait: SETTLE_MAX_WAIT_MS },
    );

    // The feed and the socket are published outside the transaction: a websocket
    // that is down must not roll back a battle that has already been played.
    if (outcome.settled) this.publishDrops(outcome.settled.drops);

    const battle = await this.get(battleId);
    this.announce({ kind: 'battle', battle: await this.summary(battleId) });
    return { battle, balanceAfter: outcome.balanceAfter };
  }

  /** The host calls their own battle off while it is still waiting. */
  async cancel(userId: string, battleId: string): Promise<BattleView> {
    const battle = await this.prisma.battle.findUnique({ where: { id: battleId } });
    if (!battle) throw notFound(ErrorCode.BATTLE_UNAVAILABLE, 'Battle not found');
    if (battle.hostId !== userId) {
      throw forbidden(ErrorCode.BATTLE_NOT_CANCELLABLE, 'Only the host can call a battle off');
    }

    const cancelled = await this.cancelAndRefund(battleId, 'Cancelled by the host');
    if (!cancelled) {
      throw badRequest(ErrorCode.BATTLE_NOT_CANCELLABLE, 'That battle can no longer be cancelled');
    }

    const view = await this.get(battleId);
    this.announce({ kind: 'battle', battle: await this.summary(battleId) });
    return view;
  }

  /**
   * Refunds battles nobody joined.
   *
   * A battle waiting for a second player holds the host's money, and the host
   * may well have closed the tab. The sweeper is what makes the lobby safe to
   * post into: the worst case for a host is a wait, not a loss. With battles
   * switched off it clears the lobby outright, which is what an operator
   * flipping that switch during an incident is asking for.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async sweepStale(): Promise<void> {
    await this.settings.ensureFresh();
    const enabled = this.settings.get<boolean>('battles.enabled');
    const waitMinutes = this.settings.get<number>('battles.waitMinutes');
    const cutoff = enabled ? new Date(Date.now() - waitMinutes * 60_000) : new Date();

    const stale = await this.prisma.battle.findMany({
      where: { status: 'WAITING', createdAt: { lt: cutoff } },
      select: { id: true },
    });

    for (const { id } of stale) {
      try {
        const cancelled = await this.cancelAndRefund(
          id,
          enabled ? 'Nobody joined in time' : 'Case battles were switched off',
        );
        if (cancelled) {
          this.logger.log(`Battle ${id} expired and was refunded`);
          this.announce({ kind: 'battle', battle: await this.summary(id) });
        }
      } catch (err) {
        // One battle that will not cancel must not stop the rest being swept.
        this.logger.error(`Could not sweep battle ${id}: ${String(err)}`);
      }
    }
  }

  /**
   * Moves a waiting battle to CANCELLED and gives every seat its money back.
   *
   * Returns false when the battle was not in a cancellable state — a battle
   * that filled a moment ago is being played, and the transition is claimed
   * with a conditional UPDATE precisely so that the refund cannot race the
   * settlement.
   */
  private async cancelAndRefund(battleId: string, reason: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.battle.updateMany({
        where: { id: battleId, status: 'WAITING' },
        data: { status: 'CANCELLED', cancelReason: reason, finishedAt: new Date() },
      });
      if (claimed.count === 0) return false;

      const battle = await tx.battle.findUniqueOrThrow({ where: { id: battleId } });
      const players = await tx.battlePlayer.findMany({ where: { battleId } });

      for (const player of players) {
        const updated = await tx.user.update({
          where: { id: player.userId },
          data: { balance: { increment: battle.entryPrice } },
          select: { balance: true },
        });
        await tx.transaction.create({
          data: {
            userId: player.userId,
            type: 'BATTLE_REFUND',
            amount: battle.entryPrice,
            balanceAfter: updated.balance,
            referenceId: battleId,
            comment: `Case battle cancelled: ${reason}`,
          },
        });
        // The balance moved without the player asking, so it is pushed rather
        // than waiting for their next page load.
        this.announce({ kind: 'balance', userId: player.userId, balance: updated.balance });
      }

      // The seats were wagers, and the wagers have been given back. Leaving the
      // commission accrued would make create-and-cancel a free way to pay an
      // inviter.
      await this.referral.reverseWager(tx, battleId);
      return true;
    });
  }

  /**
   * Charges a player for a seat and gives them one.
   *
   * The debit is a conditional UPDATE, the same as an opening's: checking the
   * balance and changing it have to be one operation or two concurrent joins
   * drive it negative. Both it and the seat claim are inside the caller's
   * transaction, so a full battle rolls the debit back rather than refunding it.
   */
  private async takeSeat(
    tx: Prisma.TransactionClient,
    battle: Pick<Battle, 'id' | 'entryPrice' | 'rounds'>,
    userId: string,
  ): Promise<{ slot: number; balanceAfter: number }> {
    const debited = await tx.$executeRaw`
      UPDATE users
      SET balance = balance - ${battle.entryPrice}
      WHERE id = CAST(${userId} AS uuid) AND balance >= ${battle.entryPrice}
    `;
    if (debited === 0) throw badRequest(ErrorCode.INSUFFICIENT_FUNDS, 'Not enough balance');

    // RETURNING hands back the incremented counter, which is this player's
    // 1-based seat number. No rows means the last seat went to somebody else.
    const seatRows = await tx.$queryRaw<Array<{ filledSlots: number }>>`
      UPDATE battles
      SET "filledSlots" = "filledSlots" + 1
      WHERE id = CAST(${battle.id} AS uuid)
        AND status = 'WAITING'
        AND "filledSlots" < slots
      RETURNING "filledSlots"
    `;
    const slot = seatRows[0]?.filledSlots;
    if (slot === undefined) throw badRequest(ErrorCode.BATTLE_FULL, 'That battle is already full');

    await tx.battlePlayer.create({ data: { battleId: battle.id, userId, slot } });

    const balanceAfter = await readBalance(tx, userId);
    await tx.transaction.create({
      data: {
        userId,
        type: 'BATTLE_ENTRY',
        amount: -battle.entryPrice,
        balanceAfter,
        referenceId: battle.id,
        comment: `Case battle, ${battle.rounds} rounds`,
      },
    });

    // The seat is the wager: it is the whole of what this player spends on the
    // battle, and the openings it pays for must not be counted a second time.
    await this.referral.accrueWager(tx, userId, battle.entryPrice, battle.id);

    return { slot, balanceAfter };
  }

  /**
   * Plays the battle out.
   *
   * Every drop is an ordinary case opening: the roll comes from the opening
   * player's own seed pair and their own nonce block, exactly as a solo opening
   * does, so nothing here is a second source of randomness and every drop stays
   * verifiable by the person who rolled it. What the battle adds is the
   * comparison at the end, and that is arithmetic over drops already recorded.
   *
   * The items are then created in the winner's inventory while still pointing
   * at the openings that produced them — which is how "who rolled it" and "who
   * owns it" can be different people without either fact being lost.
   */
  private async settle(
    tx: Prisma.TransactionClient,
    battleId: string,
  ): Promise<{ drops: RolledDrop[] } | null> {
    // Claim the transition first: a battle can only be played once, and this is
    // what stops a retry or a concurrent sweeper from playing it twice.
    const claimed = await tx.battle.updateMany({
      where: { id: battleId, status: 'WAITING' },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    if (claimed.count === 0) return null;

    const battle = await tx.battle.findUniqueOrThrow({
      where: { id: battleId },
      include: {
        cases: { orderBy: { position: 'asc' } },
        players: { orderBy: { slot: 'asc' } },
      },
    });

    const order = expandBattleRounds(battle.cases);
    const cases = await tx.case.findMany({
      where: { id: { in: [...new Set(order)] } },
      include: { items: { include: { item: true }, orderBy: { rangeFrom: 'asc' } } },
    });
    const caseById = new Map(cases.map((c) => [c.id, c]));

    const drops: RolledDrop[] = [];

    // Seeds are reserved in a fixed order across players. Two battles filling
    // at the same instant can share a player, and a consistent order is what
    // keeps their two transactions from taking each other's row locks the wrong
    // way round.
    const seating = [...battle.players].sort((a, b) => a.userId.localeCompare(b.userId));

    for (const player of seating) {
      // One UPDATE reserves the player's whole block. Incrementing round by
      // round would let a concurrent opening or upgrade slot into the middle
      // and take a number out of it.
      const seedRows = await tx.$queryRaw<Array<{ id: string; seed: string; nonce: number }>>`
        UPDATE server_seeds
        SET nonce = nonce + ${battle.rounds}
        WHERE "userId" = CAST(${player.userId} AS uuid) AND "isActive" = true
        RETURNING id, seed, nonce
      `;
      const serverSeed = seedRows[0];
      if (!serverSeed) {
        throw badRequest(
          ErrorCode.NO_ACTIVE_SEED,
          'A player in this battle has no active server seed',
        );
      }

      const clientSeed = await tx.clientSeed.findFirst({
        where: { userId: player.userId, isActive: true },
      });
      if (!clientSeed) {
        throw badRequest(
          ErrorCode.NO_ACTIVE_SEED,
          'A player in this battle has no active client seed',
        );
      }

      const firstNonce = serverSeed.nonce - battle.rounds + 1;

      for (const [index, caseId] of order.entries()) {
        const gameCase = caseById.get(caseId);
        if (!gameCase || gameCase.items.length === 0) {
          // Unreachable through the API: creating a battle checks every case.
          // Reachable by an operator emptying a case while a battle waits.
          throw badRequest(ErrorCode.CASE_EMPTY, 'A case in this battle is empty');
        }

        const nonce = firstNonce + index;
        const roll = computeRoll(serverSeed.seed, clientSeed.seed, nonce);
        const won = pickByRoll(gameCase.items, roll);

        drops.push({
          openingId: randomUUID(),
          inventoryItemId: randomUUID(),
          userId: player.userId,
          slot: player.slot,
          serverSeedId: serverSeed.id,
          clientSeedId: clientSeed.id,
          round: index + 1,
          gameCase,
          caseItem: won,
          itemPrice: CasesService.resolvePrice(won.item),
          roll,
          nonce,
        });
      }
    }

    // Ids are generated above so the openings and the inventory rows can each
    // go in with one statement: a hundred and twenty individual creates would
    // be a hundred and twenty round trips inside a transaction holding locks.
    await tx.caseOpening.createMany({
      data: drops.map((drop) => ({
        id: drop.openingId,
        userId: drop.userId,
        caseId: drop.gameCase.id,
        itemId: drop.caseItem.itemId,
        serverSeedId: drop.serverSeedId,
        clientSeedId: drop.clientSeedId,
        nonce: drop.nonce,
        roll: drop.roll,
        casePrice: drop.gameCase.price,
        itemPrice: drop.itemPrice,
        battleId,
        battleRound: drop.round,
      })),
    });

    const tallies: BattleTally[] = battle.players.map((player) => ({
      slot: player.slot,
      drops: drops.filter((drop) => drop.slot === player.slot).map((drop) => drop.itemPrice),
    }));
    const standings = battleStandings(tallies, battle.mode as BattleMode);
    const winner = standings[0]!;
    const winnerPlayer = battle.players.find((player) => player.slot === winner.slot)!;
    const totalValue = drops.reduce((sum, drop) => sum + drop.itemPrice, 0);

    // Every item goes to the winner, still pointing at the opening that rolled
    // it. The opening's own `userId` stays whoever rolled it, and that gap
    // between roller and owner is precisely what a battle is.
    await tx.inventoryItem.createMany({
      data: drops.map((drop) => ({
        id: drop.inventoryItemId,
        userId: winnerPlayer.userId,
        itemId: drop.caseItem.itemId,
        acquiredPrice: drop.itemPrice,
        openingId: drop.openingId,
      })),
    });

    for (const standing of standings) {
      await tx.battlePlayer.updateMany({
        where: { battleId, slot: standing.slot },
        data: { totalValue: standing.total, isWinner: standing.slot === winner.slot },
      });
    }

    await tx.battle.update({
      where: { id: battleId },
      data: {
        status: 'FINISHED',
        totalValue,
        winnerId: winnerPlayer.userId,
        finishedAt: new Date(),
      },
    });

    return { drops };
  }

  /** The summary shape, re-read for broadcasting. */
  private async summary(battleId: string): Promise<BattleSummary> {
    const battle = await this.prisma.battle.findUniqueOrThrow({
      where: { id: battleId },
      include: summaryInclude,
    });
    return toSummary(battle);
  }

  private publishDrops(drops: RolledDrop[]): void {
    for (const drop of drops) {
      this.drops
        .publish({
          openingId: drop.openingId,
          userId: drop.userId,
          caseName: drop.gameCase.name,
          caseSlug: drop.gameCase.slug,
          item: drop.caseItem.item,
          price: drop.itemPrice,
        })
        .catch((err) => this.logger.error(`Could not publish a battle drop: ${String(err)}`));
    }
  }

  /**
   * Through Redis rather than straight into a socket: there are several API
   * instances, and a seat taken on one of them has to disappear from the lobby
   * everybody else is looking at.
   */
  private announce(event: BattleEvent): void {
    this.publisher
      .publish(BATTLES_CHANNEL, JSON.stringify(event))
      .catch((err) => this.logger.error(`Could not announce a battle event: ${String(err)}`));
  }

  private async assertPlayable(): Promise<void> {
    await this.settings.ensureFresh();
    if (this.settings.get<boolean>('site.maintenance')) {
      throw badRequest(ErrorCode.MAINTENANCE, 'The site is in maintenance mode');
    }
    if (!this.settings.get<boolean>('battles.enabled')) {
      throw badRequest(ErrorCode.BATTLE_DISABLED, 'Case battles are switched off');
    }
  }

  private async assertNotBanned(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { isBanned: true, banReason: true },
    });
    if (!user) throw notFound(ErrorCode.ACCOUNT_BANNED, 'User not found');
    if (user.isBanned) {
      throw forbidden(ErrorCode.ACCOUNT_BANNED, user.banReason ?? 'Account is banned');
    }
  }
}

const summaryInclude = {
  cases: { orderBy: { position: 'asc' }, include: { case: true } },
  players: { orderBy: { slot: 'asc' }, include: { user: true } },
} satisfies Prisma.BattleInclude;

type BattleWithSummary = Prisma.BattleGetPayload<{ include: typeof summaryInclude }>;

function baseSummary(battle: Battle & { players: Array<{ slot: number; isWinner: boolean }> }) {
  return {
    id: battle.id,
    mode: battle.mode as BattleMode,
    status: battle.status as BattleStatus,
    slots: battle.slots,
    filledSlots: battle.filledSlots,
    rounds: battle.rounds,
    entryPrice: battle.entryPrice,
    totalValue: battle.totalValue,
    winnerSlot: battle.players.find((player) => player.isWinner)?.slot ?? null,
    createdAt: battle.createdAt.toISOString(),
    finishedAt: battle.finishedAt?.toISOString() ?? null,
  };
}

function toSummary(battle: BattleWithSummary): BattleSummary {
  return {
    ...baseSummary(battle),
    cases: battle.cases.map((line) => ({
      caseId: line.caseId,
      slug: line.case.slug,
      name: line.case.name,
      nameEn: line.case.nameEn,
      imageUrl: line.case.imageUrl,
      // The line's own frozen price, not the catalogue's current one: it is
      // what `entryPrice` was summed from.
      price: line.price,
      count: line.count,
    })),
    players: battle.players.map(toPlayerView),
  };
}

function toPlayerView(player: {
  slot: number;
  userId: string;
  totalValue: number;
  isWinner: boolean;
  user: { username: string; avatarUrl: string | null };
}): BattlePlayerView {
  return {
    slot: player.slot,
    userId: player.userId,
    username: player.user.username,
    avatarUrl: player.user.avatarUrl,
    totalValue: player.totalValue,
    isWinner: player.isWinner,
  };
}

async function readBalance(tx: Prisma.TransactionClient, userId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ balance: number }>>`
    SELECT balance FROM users WHERE id = CAST(${userId} AS uuid)
  `;
  return rows[0]?.balance ?? 0;
}
