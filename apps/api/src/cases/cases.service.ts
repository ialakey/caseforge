import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  Case,
  CaseCategory,
  CaseItem,
  Item,
  Prisma,
  PrismaClient,
} from '@prisma/client';
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
import { PRISMA_READ } from '../common/prisma-read';
import { CacheNamespace, CacheService } from '../common/cache.service';
import { badRequest, forbidden, notFound } from '../common/app-error';
import { REDIS_CLIENT } from '../common/redis.module';
import { DropsService } from '../drops/drops.service';
import { BonusService } from '../bonus/bonus.service';
import { ReferralService } from '../referral/referral.service';
import { SettingsService } from '../common/settings.service';

/**
 * The rate limit is counted in cases rather than requests: one "x10" button
 * press is ten openings, and script protection must see it that way. Both the
 * allowance and the window are settings, so an operator can tighten them
 * during an incident without a deploy.
 */

/**
 * How long the catalogue may be stale.
 *
 * The catalogue is the most requested read on the site and it changes when an
 * operator saves a case or the hourly price sync runs — both of which
 * invalidate it explicitly, so this TTL is not the freshness guarantee but the
 * backstop for a bump that never arrived. A minute of staleness on a chance or
 * a price is invisible to a player; a minute of identical joins at peak is not.
 */
const CATALOGUE_TTL_SEC = 60;

type CaseWithItems = Case & {
  items: (CaseItem & { item: Item })[];
  category?: CaseCategory | null;
};

@Injectable()
export class CasesService {
  private readonly logger = new Logger(CasesService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Reads only, and only ones a few seconds of replication lag cannot spoil:
    // the catalogue an operator edits, not the balance a player just spent.
    @Inject(PRISMA_READ) private readonly read: PrismaClient,
    private readonly cache: CacheService,
    private readonly drops: DropsService,
    private readonly bonus: BonusService,
    private readonly referral: ReferralService,
    private readonly settings: SettingsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Effective item price: a manual override beats the market price. */
  static resolvePrice(item: Pick<Item, 'marketPrice' | 'priceOverride'>): number {
    return resolveItemPrice(item);
  }

  async listCases(): Promise<CaseView[]> {
    return this.cache.wrap(CacheNamespace.CATALOGUE, 'list', CATALOGUE_TTL_SEC, async () => {
      const cases = await this.read.case.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        include: {
          items: { include: { item: true }, orderBy: { rangeFrom: 'asc' } },
          category: true,
        },
      });
      return cases.map((c) => this.toCaseView(c));
    });
  }

  async getCaseBySlug(slug: string): Promise<CaseView> {
    const cached = await this.cache.wrap<CaseView | null>(
      CacheNamespace.CATALOGUE,
      `slug:${slug}`,
      CATALOGUE_TTL_SEC,
      async () => {
        const found = await this.read.case.findUnique({
          where: { slug },
          include: {
            items: { include: { item: true }, orderBy: { rangeFrom: 'asc' } },
            category: true,
          },
        });
        return found ? this.toCaseView(found) : null;
      },
    );
    // A miss is cached too, and on purpose: a crawler walking made-up slugs
    // would otherwise be a database query per request.
    if (!cached) throw new NotFoundException('Case not found');
    return cached;
  }

  /**
   * Drops the cached catalogue.
   *
   * Called by whoever changed what it says: a case saved in the back office,
   * an RTP recalculation, the price sync. The opening path deliberately does
   * not use the cache at all — it reads the case inside its own transaction,
   * because a stale price there would be a stale amount of money.
   */
  async invalidateCatalogue(): Promise<void> {
    await this.cache.invalidate(CacheNamespace.CATALOGUE);
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
    if (await this.settings.read<boolean>('site.maintenance')) {
      throw badRequest(ErrorCode.MAINTENANCE, 'The site is in maintenance mode');
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

      // A referral commission on what was actually charged, accrued in the
      // same transaction as the debit. It costs one indexed lookup per
      // opening, and only for players somebody invited.
      await this.referral.accrueWager(tx, userId, totalPrice, drops[0]!.openingId);

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
    await this.invalidateCatalogue();
    return rtp;
  }

  private async enforceRateLimit(userId: string, count: number): Promise<void> {
    await this.settings.ensureFresh();
    const allowance = this.settings.get<number>('limits.openPerWindow');
    const windowSec = this.settings.get<number>('limits.openWindowSec');

    const key = `ratelimit:open:${userId}`;
    const used = await this.redis.incrby(key, count);
    if (used === count) await this.redis.expire(key, windowSec);
    if (used > allowance) {
      throw badRequest(ErrorCode.RATE_LIMITED, 'Too fast. Wait a couple of seconds.');
    }
  }

  /**
   * Public because a case battle renders the same catalogue view: the reel it
   * draws is the case's contents, and a second mapper for the same shape is
   * how the two views start to disagree about a chance.
   */
  toCaseView(source: CaseWithItems): CaseView {
    return {
      id: source.id,
      slug: source.slug,
      name: source.name,
      nameEn: source.nameEn,
      description: source.description,
      descriptionEn: source.descriptionEn,
      price: source.price,
      imageUrl: source.imageUrl,
      isActive: source.isActive,
      category: source.category
        ? {
            id: source.category.id,
            slug: source.category.slug,
            name: source.category.name,
            nameEn: source.category.nameEn,
            sortOrder: source.category.sortOrder,
          }
        : null,
      items: source.items.map((ci) => this.toCaseItemView(ci)),
    };
  }

  toCaseItemView(caseItem: CaseItem & { item: Item }) {
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
