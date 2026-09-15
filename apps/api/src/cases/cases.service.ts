import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Case, CaseItem, Item, Prisma } from '@prisma/client';
import Redis from 'ioredis';
import {
  type CaseView,
  type OpenCaseBatchResult,
  type OpenCaseResult,
  ErrorCode,
  ItemRarity,
  MAX_CASES_PER_OPEN,
  TICKET_SPACE,
  calculateRtp,
  pickByRoll,
  rangeChance,
  resolveItemPrice,
} from '@caseforge/shared';
import { computeRoll } from '@caseforge/shared/node';
import { PrismaService } from '../common/prisma.service';
import { badRequest, forbidden, notFound } from '../common/app-error';
import { REDIS_CLIENT } from '../common/redis.module';
import { DropsService } from '../drops/drops.service';
import { BonusService } from '../bonus/bonus.service';

/**
 * Openings allowed per window. Counted in cases rather than requests: one
 * "x10" button press is ten openings, and script protection must see it that way.
 */
const OPEN_RATE_LIMIT = 60;
const OPEN_RATE_WINDOW_SEC = 10;

type CaseWithItems = Case & { items: (CaseItem & { item: Item })[] };

@Injectable()
export class CasesService {
  private readonly logger = new Logger(CasesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly drops: DropsService,
    private readonly bonus: BonusService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Effective item price: a manual override beats the market price. */
  static resolvePrice(item: Pick<Item, 'marketPrice' | 'priceOverride'>): number {
    return resolveItemPrice(item);
  }

  async listCases(): Promise<CaseView[]> {
    const cases = await this.prisma.case.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { items: { include: { item: true }, orderBy: { rangeFrom: 'asc' } } },
    });
    return cases.map((c) => this.toCaseView(c));
  }

  async getCaseBySlug(slug: string): Promise<CaseView> {
    const found = await this.prisma.case.findUnique({
      where: { slug },
      include: { items: { include: { item: true }, orderBy: { rangeFrom: 'asc' } } },
    });
    if (!found) throw new NotFoundException('Case not found');
    return this.toCaseView(found);
  }

  /**
   * Opens between one and MAX_CASES_PER_OPEN cases at once.
   *
   * The whole batch runs in one transaction: either every case is paid for and
   * every item granted, or nothing happens at all. Both the debit and the
   * nonce reservation are atomic UPDATEs rather than read-then-write —
   * otherwise two concurrent openings drive the balance negative, and a reused
   * nonce breaks verifiability.
   */
  async openCase(userId: string, caseId: string, count = 1): Promise<OpenCaseBatchResult> {
    if (!Number.isInteger(count) || count < 1 || count > MAX_CASES_PER_OPEN) {
      throw badRequest(
        ErrorCode.BATCH_SIZE_INVALID,
        `Between 1 and ${MAX_CASES_PER_OPEN} cases may be opened at once`,
      );
    }
    await this.enforceRateLimit(userId, count);

    const gameCase = await this.prisma.case.findUnique({
      where: { id: caseId },
      include: { items: { include: { item: true }, orderBy: { rangeFrom: 'asc' } } },
    });
    if (!gameCase) throw notFound(ErrorCode.CASE_UNAVAILABLE, 'Case not found');
    if (!gameCase.isActive) throw badRequest(ErrorCode.CASE_UNAVAILABLE, 'Case unavailable');
    if (gameCase.items.length === 0) throw badRequest(ErrorCode.CASE_EMPTY, 'Case is empty');

    const listPrice = gameCase.price * count;

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { isBanned: true, banReason: true },
      });
      if (!user) throw notFound(ErrorCode.ACCOUNT_BANNED, 'User not found');
      if (user.isBanned)
        throw forbidden(ErrorCode.ACCOUNT_BANNED, user.banReason ?? 'Account is banned');

      // A wheel voucher is spent here, inside the same transaction as the
      // debit. Resolving it earlier would let a concurrent opening spend it in
      // between and charge this one the discounted price for nothing.
      const bonusApplied = await this.bonus.applyBest(tx, userId, gameCase.price, count);
      const totalPrice = Math.max(0, listPrice - (bonusApplied?.saving ?? 0));

      // Conditional debit: zero affected rows means there was not enough money.
      // Checking the balance and changing it is one atomic operation here.
      const debited = await tx.$executeRaw`
        UPDATE users
        SET balance = balance - ${totalPrice}
        WHERE id = CAST(${userId} AS uuid) AND balance >= ${totalPrice}
      `;
      if (debited === 0) throw badRequest(ErrorCode.INSUFFICIENT_FUNDS, 'Not enough balance');

      // Reserve the whole nonce block in a single UPDATE. Incrementing one at
      // a time in a loop is not an option: a concurrent upgrade or opening
      // would slot into the middle and take a number out of our batch.
      const seedRows = await tx.$queryRaw<
        Array<{ id: string; seed: string; seedHash: string; nonce: number }>
      >`
        UPDATE server_seeds
        SET nonce = nonce + ${count}
        WHERE "userId" = CAST(${userId} AS uuid) AND "isActive" = true
        RETURNING id, seed, "seedHash", nonce
      `;
      const serverSeed = seedRows[0];
      if (!serverSeed) {
        throw badRequest(ErrorCode.NO_ACTIVE_SEED, 'No active server seed — sign in again');
      }

      const clientSeed = await tx.clientSeed.findFirst({ where: { userId, isActive: true } });
      if (!clientSeed) throw badRequest(ErrorCode.NO_ACTIVE_SEED, 'No active client seed');

      // RETURNING hands back the already-incremented value, so our block is
      // the last `count` numbers before it.
      const firstNonce = serverSeed.nonce - count + 1;

      const drops: Array<{
        openingId: string;
        caseItem: CaseItem & { item: Item };
        itemPrice: number;
        roll: number;
        nonce: number;
        inventoryItemId: string;
      }> = [];

      for (let i = 0; i < count; i++) {
        const nonce = firstNonce + i;
        const roll = computeRoll(serverSeed.seed, clientSeed.seed, nonce);
        const won = pickByRoll(gameCase.items, roll);
        const itemPrice = CasesService.resolvePrice(won.item);

        const opening = await tx.caseOpening.create({
          data: {
            userId,
            caseId: gameCase.id,
            itemId: won.itemId,
            serverSeedId: serverSeed.id,
            clientSeedId: clientSeed.id,
            nonce,
            roll,
            casePrice: gameCase.price,
            itemPrice,
          },
        });

        const inventoryItem = await tx.inventoryItem.create({
          data: { userId, itemId: won.itemId, acquiredPrice: itemPrice, openingId: opening.id },
        });

        drops.push({
          openingId: opening.id,
          caseItem: won,
          itemPrice,
          roll,
          nonce,
          inventoryItemId: inventoryItem.id,
        });
      }

      const balanceRows = await tx.$queryRaw<Array<{ balance: number }>>`
        SELECT balance FROM users WHERE id = CAST(${userId} AS uuid)
      `;
      const balanceAfter = balanceRows[0]?.balance ?? 0;

      // One ledger entry per batch: ten rows for a single click would only
      // clutter the history, and reconciliation looks at the sum anyway.
      await tx.transaction.create({
        data: {
          userId,
          type: 'CASE_OPEN',
          amount: -totalPrice,
          balanceAfter,
          referenceId: drops[0]!.openingId,
          comment:
            count === 1
              ? `Opened case "${gameCase.name}"`
              : `Opened case "${gameCase.name}" x${count}`,
        },
      });

      return {
        drops,
        balanceAfter,
        totalPrice,
        bonusApplied,
        serverSeedHash: serverSeed.seedHash,
        clientSeed: clientSeed.seed,
      };
    });

    // Publishing to the feed happens outside the transaction: a websocket
    // failure must not roll back openings that already happened.
    for (const drop of result.drops) {
      this.drops
        .publish({
          openingId: drop.openingId,
          userId,
          caseName: gameCase.name,
          caseSlug: gameCase.slug,
          item: drop.caseItem.item,
          price: drop.itemPrice,
        })
        .catch((err) => this.logger.error(`Could not publish the drop: ${String(err)}`));
    }

    const openings: OpenCaseResult[] = result.drops.map((drop) => ({
      openingId: drop.openingId,
      item: this.toCaseItemView(drop.caseItem),
      inventoryItemId: drop.inventoryItemId,
      roll: drop.roll,
      nonce: drop.nonce,
      serverSeedHash: result.serverSeedHash,
      clientSeed: result.clientSeed,
    }));

    return {
      openings,
      balanceAfter: result.balanceAfter,
      totalSpent: result.totalPrice,
      totalWon: result.drops.reduce((sum, d) => sum + d.itemPrice, 0),
      bonusApplied: result.bonusApplied
        ? {
            segmentKey: result.bonusApplied.segmentKey,
            kind: result.bonusApplied.kind,
            value: result.bonusApplied.value,
            saving: result.bonusApplied.saving,
          }
        : null,
    };
  }

  /** Recomputes RTP: called by the cron job and by the admin panel after an edit. */
  async recalculateRtp(caseId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const db = tx ?? this.prisma;
    const gameCase = await db.case.findUnique({
      where: { id: caseId },
      include: { items: { include: { item: true } } },
    });
    if (!gameCase) throw new NotFoundException('Case not found');

    const rtp = calculateRtp(
      gameCase.items.map((ci) => ({
        rangeFrom: ci.rangeFrom,
        rangeTo: ci.rangeTo,
        price: CasesService.resolvePrice(ci.item),
      })),
      gameCase.price,
    );

    await db.case.update({
      where: { id: caseId },
      data: { rtpCached: rtp, rtpCalculatedAt: new Date() },
    });
    return rtp;
  }

  private async enforceRateLimit(userId: string, count: number): Promise<void> {
    const key = `ratelimit:open:${userId}`;
    const used = await this.redis.incrby(key, count);
    if (used === count) await this.redis.expire(key, OPEN_RATE_WINDOW_SEC);
    if (used > OPEN_RATE_LIMIT) {
      throw badRequest(ErrorCode.RATE_LIMITED, 'Too fast. Wait a couple of seconds.');
    }
  }

  private toCaseView(source: CaseWithItems): CaseView {
    return {
      id: source.id,
      slug: source.slug,
      name: source.name,
      nameEn: source.nameEn,
      price: source.price,
      imageUrl: source.imageUrl,
      isActive: source.isActive,
      items: source.items.map((ci) => this.toCaseItemView(ci)),
    };
  }

  private toCaseItemView(caseItem: CaseItem & { item: Item }) {
    return {
      id: caseItem.id,
      itemId: caseItem.itemId,
      marketHashName: caseItem.item.marketHashName,
      imageUrl: caseItem.item.imageUrl,
      rarity: caseItem.item.rarity as ItemRarity,
      price: CasesService.resolvePrice(caseItem.item),
      chance: rangeChance(caseItem),
      rangeFrom: caseItem.rangeFrom,
      rangeTo: caseItem.rangeTo,
    };
  }
}

export { TICKET_SPACE };
