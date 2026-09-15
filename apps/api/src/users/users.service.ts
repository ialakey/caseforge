import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { type PublicUser, ErrorCode, UserRole, parseTradeUrl } from '@caseforge/shared';
import { generateServerSeed, hashServerSeed } from '@caseforge/shared/node';
import { PrismaService } from '../common/prisma.service';
import { loadConfig } from '../common/config';
import { badRequest, forbidden } from '../common/app-error';
import { SettingsService } from '../common/settings.service';
import { PromoService } from '../promo/promo.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private readonly config = loadConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly promo: PromoService,
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

      await tx.transaction.create({
        data: {
          userId,
          type: 'DEPOSIT',
          amount,
          balanceAfter: updated.balance - (promo?.bonus ?? 0),
          comment: 'Top-up (stub, no real payment)',
        },
      });

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
