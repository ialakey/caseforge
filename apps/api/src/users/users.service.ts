import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  type ItemRarity,
  type PlayerStats,
  type PublicProfileView,
  type PublicUser,
  ErrorCode,
  UserRole,
  parseTradeUrl,
} from '@caseforge/shared';
import { generateServerSeed, hashServerSeed } from '@caseforge/shared/node';
import { PrismaService } from '../common/prisma.service';
import { loadConfig } from '../common/config';
import { badRequest, forbidden } from '../common/app-error';
import { SettingsService } from '../common/settings.service';
import { PromoService } from '../promo/promo.service';
import { ReferralService } from '../referral/referral.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private readonly config = loadConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly promo: PromoService,
    private readonly referral: ReferralService,
  ) {}

  /**
   * Stub top-up: credits the entered amount with no payment at all.
   *
   * It exists so the gameplay loop can be exercised before a payment provider
   * is wired in. A real top-up looks different: an invoice is created at the
   * PSP, the player is sent to its page, and the balance changes only on a
   * successful-payment webhook — idempotently, keyed by the payment id.
   *
   * The credit goes through Transaction like every other money movement,
   * otherwise the nightly reconciliation would flag a mismatch straight away.
   */
  async deposit(userId: string, amount: number, promoCode?: string | null) {
    // Two switches have to agree: the environment decides whether the stub
    // exists at all in this deployment, and the setting lets an operator turn
    // it off without one.
    await this.settings.ensureFresh();
    if (!this.config.ENABLE_STUB_DEPOSITS || !this.settings.get<boolean>('deposits.enabled')) {
      throw forbidden(ErrorCode.DEPOSITS_DISABLED, 'Top-ups are disabled');
    }

    const min = this.settings.get<number>('deposits.min');
    const max = this.settings.get<number>('deposits.max');
    if (amount < min || amount > max) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, `A top-up must be between ${min} and ${max}`);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { isBanned: true, banReason: true },
      });
      if (!user) throw new NotFoundException('User not found');
      if (user.isBanned)
        throw forbidden(ErrorCode.ACCOUNT_BANNED, user.banReason ?? 'Account is banned');

      // The code is redeemed before the money moves, inside the same
      // transaction: a bonus credited against a deposit that then failed would
      // be a promotion nobody paid for.
      const promo = promoCode ? await this.promo.redeem(tx, userId, promoCode, amount) : null;

      const updated = await tx.user.update({
        where: { id: userId },
        data: { balance: { increment: amount + (promo?.bonus ?? 0) } },
        select: { balance: true },
      });

      const entry = await tx.transaction.create({
        data: {
          userId,
          type: 'DEPOSIT',
          amount,
          balanceAfter: updated.balance - (promo?.bonus ?? 0),
          comment: 'Top-up (stub, no real payment)',
        },
      });

      // The inviter's share is charged on what the player paid, not on what
      // the promo code added on top: a promotion the site funded is not
      // turnover, and paying commission on it would mean paying it twice.
      await this.referral.accrueDeposit(tx, userId, amount, entry.id);

      // The bonus is its own ledger row rather than being folded into the
      // deposit: what the player paid and what the promotion gave them are
      // different kinds of money, and a report that cannot tell them apart
      // cannot measure what the promotion cost.
      if (promo && promo.bonus > 0) {
        await tx.transaction.create({
          data: {
            userId,
            type: 'BONUS',
            amount: promo.bonus,
            balanceAfter: updated.balance,
            referenceId: promo.promoCodeId,
            comment: `Promo code ${promo.code}`,
          },
        });
      }

      return { balance: updated.balance, promo };
    });

    this.logger.warn(`STUB TOP-UP: credited ${amount} to user ${userId} with no payment`);
    return result;
  }

  async getProfile(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    return {
      id: user.id,
      steamId64: user.steamId64,
      username: user.username,
      avatarUrl: user.avatarUrl,
      role: user.role as UserRole,
      balance: user.balance,
      tradeUrl: user.tradeUrl,
    };
  }

  /**
   * A player's own record: what they have done, and the best of it.
   *
   * Five independent counts, issued together rather than one endpoint each —
   * they are read at the same moment by the same panel, and five round trips to
   * draw one card is five chances for it to render half-finished.
   *
   * "Best" is by the price recorded at the moment of the drop, not today's.
   * That is what the player actually won; re-pricing it later would mean the
   * number on their proudest card moves without anything having happened.
   */
  async getStats(userId: string): Promise<PlayerStats> {
    const [casesOpened, upgradesWon, upgradesLost, battlesWon, battlesLost, contracts, best] =
      await Promise.all([
        this.prisma.caseOpening.count({ where: { userId } }),
        this.prisma.upgrade.count({ where: { userId, status: 'WON' } }),
        this.prisma.upgrade.count({ where: { userId, status: 'LOST' } }),
        // Only finished battles are counted: a seat in a battle still waiting
        // for players is neither a win nor a loss, and counting it as a loss
        // would make the lobby look like a losing streak.
        this.prisma.battlePlayer.count({
          where: { userId, isWinner: true, battle: { status: 'FINISHED' } },
        }),
        this.prisma.battlePlayer.count({
          where: { userId, isWinner: false, battle: { status: 'FINISHED' } },
        }),
        this.prisma.contract.count({ where: { userId } }),
        this.prisma.caseOpening.findFirst({
          where: { userId },
          orderBy: { itemPrice: 'desc' },
          include: { item: true, case: true },
        }),
      ]);

    return {
      casesOpened,
      upgrades: { won: upgradesWon, lost: upgradesLost },
      battles: { won: battlesWon, lost: battlesLost },
      contracts,
      bestDrop: best
        ? {
            itemName: best.item.name,
            imageUrl: best.item.imageUrl,
            rarity: best.item.rarity as ItemRarity,
            price: best.itemPrice,
            caseName: best.case.name,
            caseSlug: best.case.slug,
            createdAt: best.createdAt.toISOString(),
          }
        : null,
    };
  }

  /**
   * A player as a stranger sees them, or null when there is no such player.
   *
   * The `select` is written out in full rather than taking the row and picking
   * fields off it afterwards: a balance that never leaves Postgres cannot be
   * serialised into a public response by accident later.
   *
   * Drops are the same notable ones the live feed shows — a profile listing
   * every Consumer-grade skin somebody ever unboxed is a wall, and the feed
   * has already decided what counts as worth showing.
   */
  async getPublicProfile(userId: string): Promise<PublicProfileView | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, avatarUrl: true, steamId64: true, createdAt: true },
    });
    if (!user) return null;

    const openings = await this.prisma.caseOpening.findMany({
      where: {
        userId,
        item: { rarity: { in: ['RESTRICTED', 'CLASSIFIED', 'COVERT', 'EXTRAORDINARY'] } },
      },
      orderBy: { createdAt: 'desc' },
      take: 24,
      include: { item: true, case: true },
    });

    return {
      id: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl,
      steamId: user.steamId64,
      createdAt: user.createdAt.toISOString(),
      drops: openings.map((o) => ({
        openingId: o.id,
        userId: user.id,
        username: user.username,
        avatarUrl: user.avatarUrl,
        caseName: o.case.name,
        caseSlug: o.case.slug,
        itemName: o.item.name,
        itemImageUrl: o.item.imageUrl,
        rarity: o.item.rarity as ItemRarity,
        price: o.itemPrice,
        createdAt: o.createdAt.toISOString(),
      })),
    };
  }

  async setTradeUrl(userId: string, tradeUrl: string): Promise<{ tradeUrl: string }> {
    const parsed = parseTradeUrl(tradeUrl);
    if (!parsed) throw badRequest(ErrorCode.TRADE_URL_INVALID, 'Invalid Steam trade URL');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { steamId64: true },
    });
    if (!user) throw new NotFoundException('User not found');

    // `partner` in a trade URL is the accountId — the low 32 bits of the
    // SteamID64. The check rejects other people's links: without it a
    // withdrawal would go to somebody else.
    const accountId = (BigInt(user.steamId64) - 76561197960265728n).toString();
    if (parsed.partner !== accountId) {
      throw badRequest(
        ErrorCode.TRADE_URL_FOREIGN,
        'That trade URL belongs to a different Steam account',
      );
    }

    await this.prisma.user.update({ where: { id: userId }, data: { tradeUrl } });
    return { tradeUrl };
  }

  /** Current provably fair state: active hash, client seed, counter. */
  async getSeeds(userId: string) {
    const [server, client] = await Promise.all([
      this.prisma.serverSeed.findFirst({ where: { userId, isActive: true } }),
      this.prisma.clientSeed.findFirst({ where: { userId, isActive: true } }),
    ]);
    if (!server || !client) throw new NotFoundException('Seeds are not initialised');

    return {
      // The active seed value is never returned — that would defeat the scheme.
      serverSeedHash: server.seedHash,
      clientSeed: client.seed,
      nonce: server.nonce,
    };
  }

  async setClientSeed(userId: string, clientSeed: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.clientSeed.updateMany({
        where: { userId, isActive: true },
        data: { isActive: null },
      });
      await tx.clientSeed.create({ data: { userId, seed: clientSeed, isActive: true } });
    });
    return this.getSeeds(userId);
  }

  /**
   * Rotates the server seed: the old one is revealed in full, the new one is
   * published as a hash only. That reveal is what makes past openings verifiable.
   */
  async rotateServerSeed(userId: string) {
    const revealed = await this.prisma.$transaction(async (tx) => {
      const current = await tx.serverSeed.findFirst({ where: { userId, isActive: true } });
      if (!current) throw new NotFoundException('No active server seed found');

      await tx.serverSeed.update({
        where: { id: current.id },
        data: { isActive: null, revealedAt: new Date() },
      });

      const next = generateServerSeed();
      await tx.serverSeed.create({
        data: { userId, seed: next, seedHash: hashServerSeed(next), isActive: true },
      });

      return current;
    });

    return {
      revealedServerSeed: revealed.seed,
      revealedServerSeedHash: revealed.seedHash,
      finalNonce: revealed.nonce,
    };
  }

  /** The player's opening history with everything needed to verify by hand. */
  async getOpenings(userId: string, page: number, perPage: number) {
    const [total, openings] = await Promise.all([
      this.prisma.caseOpening.count({ where: { userId } }),
      this.prisma.caseOpening.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        include: { item: true, case: true, serverSeed: true, clientSeed: true },
      }),
    ]);

    return {
      total,
      page,
      perPage,
      items: openings.map((o) => ({
        id: o.id,
        caseName: o.case.name,
        itemName: o.item.name,
        itemImageUrl: o.item.imageUrl,
        rarity: o.item.rarity,
        casePrice: o.casePrice,
        itemPrice: o.itemPrice,
        roll: o.roll,
        nonce: o.nonce,
        clientSeed: o.clientSeed.seed,
        serverSeedHash: o.serverSeed.seedHash,
        // The seed becomes visible only after rotation — before that only the hash can be checked.
        serverSeed: o.serverSeed.isActive === null ? o.serverSeed.seed : null,
        createdAt: o.createdAt.toISOString(),
      })),
    };
  }

  async getTransactions(userId: string, page: number, perPage: number) {
    const [total, rows] = await Promise.all([
      this.prisma.transaction.count({ where: { userId } }),
      this.prisma.transaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
    ]);
    return { total, page, perPage, items: rows };
  }
}
