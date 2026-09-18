import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Item, PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { type LiveDrop, ItemRarity } from '@caseforge/shared';
import { PRISMA_READ } from '../common/prisma-read';
import { REDIS_CLIENT, REDIS_PUBLISHER } from '../common/redis.module';

export const DROPS_CHANNEL = 'drops:live';

/**
 * The feed's own backlog.
 *
 * Every socket that connects asks for the recent drops, and answering that
 * from Postgres is a four-table join per connection — at peak, and especially
 * during the reconnect storm after a deploy, that is the most pointless load on
 * the database on the whole site: thousands of clients asking the same question
 * about rows that never change. The feed is therefore kept as a list in Redis,
 * written as drops happen, and the database is only read to warm it.
 */
/**
 * The backlog key carries a version.
 *
 * Entries are stored as serialised `LiveDrop`s, so the key is a cache of a
 * shape, not just of data. When a field is added — `userId`, for the profile
 * links — every entry already in Redis is missing it, and a deploy would serve
 * that older shape until the list happened to cycle out. Bumping the suffix
 * makes the new code start a fresh list, warmed from the database, and the old
 * one expires on its own with no migration to run.
 */
const FEED_KEY = 'drops:recent:v2';
const FEED_KEEP = 50;

/**
 * The priciest drop of the last day, cached.
 *
 * It is a scan over a day of openings, and the strip asks for it on every page
 * load of the whole site — so it is computed at most once a minute. A minute
 * of staleness on a "best of the day" card is invisible; the scan on every
 * request would not be.
 */
const BEST_KEY = 'drops:best24h';
const BEST_TTL_SEC = 60;
const BEST_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Not every drop reaches the global feed: at peak that is tens of thousands of
 * events per second, of which a handful interest anyone. Rarity is the filter.
 */
const FEED_RARITIES = new Set<ItemRarity>([
  ItemRarity.RESTRICTED,
  ItemRarity.CLASSIFIED,
  ItemRarity.COVERT,
  ItemRarity.EXTRAORDINARY,
]);

export interface PublishDropInput {
  openingId: string;
  userId: string;
  caseName: string;
  caseSlug: string;
  item: Item;
  price: number;
}

@Injectable()
export class DropsService {
  private readonly logger = new Logger(DropsService.name);

  constructor(
    // The feed is exactly what a replica is for: nobody is reading their own
    // write here, and a drop arriving a second late is invisible.
    @Inject(PRISMA_READ) private readonly read: PrismaClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(REDIS_PUBLISHER) private readonly publisher: Redis,
  ) {}

  async publish(input: PublishDropInput): Promise<void> {
    if (!FEED_RARITIES.has(input.item.rarity as ItemRarity)) return;

    const user = await this.read.user.findUnique({
      where: { id: input.userId },
      select: { username: true, avatarUrl: true },
    });

    const drop: LiveDrop = {
      openingId: input.openingId,
      userId: input.userId,
      username: user?.username ?? 'Player',
      avatarUrl: user?.avatarUrl ?? null,
      caseName: input.caseName,
      caseSlug: input.caseSlug,
      itemName: input.item.name,
      itemImageUrl: input.item.imageUrl,
      rarity: input.item.rarity as ItemRarity,
      price: input.price,
      createdAt: new Date().toISOString(),
    };

    const payload = JSON.stringify(drop);

    // The backlog is updated in the same breath as the broadcast, and trimmed
    // in the same pipeline: a list that only ever grows is a slow leak of
    // memory that nothing reads.
    try {
      await this.redis
        .multi()
        .lpush(FEED_KEY, payload)
        .ltrim(FEED_KEY, 0, FEED_KEEP - 1)
        .exec();
    } catch (err) {
      // A backlog that could not be written is a cold cache later, not a lost
      // drop: the broadcast below is what the connected clients see.
      this.logger.warn(`Could not record the drop in the feed backlog: ${String(err)}`);
    }

    // Through Redis rather than straight into the socket: there are several
    // API instances and the feed must be the same one for everybody.
    await this.publisher.publish(DROPS_CHANNEL, payload);
  }

  /**
   * Recent notable drops, so the feed is not empty on page load.
   *
   * Served from the Redis backlog, and only read from the database when the
   * backlog cannot answer — a cold Redis, or a site whose last notable drop
   * predates it.
   */
  async recent(limit = 20): Promise<LiveDrop[]> {
    try {
      const cached = await this.redis.lrange(FEED_KEY, 0, limit - 1);
      if (cached.length >= limit) return cached.map((row) => JSON.parse(row) as LiveDrop);
    } catch (err) {
      this.logger.warn(`Feed backlog unavailable, reading the database: ${String(err)}`);
    }

    const drops = await this.recentFromDatabase(Math.max(limit, FEED_KEEP));
    await this.warmBacklog(drops);
    return drops.slice(0, limit);
  }

  /**
   * The priciest notable drop of the last day, or null on a quiet day.
   *
   * Null rather than a fallback to "the best ever": a card headed "drop of the
   * day" showing something from three months ago is a lie the strip tells on
   * every page, and an absent card says the same thing honestly.
   */
  async bestOfDay(): Promise<LiveDrop | null> {
    try {
      const cached = await this.redis.get(BEST_KEY);
      // The empty string is a cached "nothing today" — without it a quiet day
      // means the scan runs on every single request, which is exactly the load
      // the cache exists to prevent.
      if (cached !== null) return cached === '' ? null : (JSON.parse(cached) as LiveDrop);
    } catch (err) {
      this.logger.warn(`Best-drop cache unavailable, reading the database: ${String(err)}`);
    }

    const opening = await this.read.caseOpening.findFirst({
      where: {
        createdAt: { gte: new Date(Date.now() - BEST_WINDOW_MS) },
        item: { rarity: { in: [...FEED_RARITIES] } },
      },
      // By the price recorded at the moment of opening, not by today's price:
      // that is what the player actually won, and it does not move under the
      // card when the item is re-priced.
      orderBy: { itemPrice: 'desc' },
      include: { user: true, item: true, case: true },
    });

    const best: LiveDrop | null = opening
      ? {
          openingId: opening.id,
          userId: opening.userId,
          username: opening.user.username,
          avatarUrl: opening.user.avatarUrl,
          caseName: opening.case.name,
          caseSlug: opening.case.slug,
          itemName: opening.item.name,
          itemImageUrl: opening.item.imageUrl,
          rarity: opening.item.rarity as ItemRarity,
          price: opening.itemPrice,
          createdAt: opening.createdAt.toISOString(),
        }
      : null;

    try {
      await this.redis.set(BEST_KEY, best ? JSON.stringify(best) : '', 'EX', BEST_TTL_SEC);
    } catch {
      // A cache that refuses to store is a slower page, not a broken one.
    }
    return best;
  }

  private async recentFromDatabase(limit: number): Promise<LiveDrop[]> {
    const openings = await this.read.caseOpening.findMany({
      where: { item: { rarity: { in: [...FEED_RARITIES] } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: true, item: true, case: true },
    });

    return openings.map((o) => ({
      openingId: o.id,
      userId: o.userId,
      username: o.user.username,
      avatarUrl: o.user.avatarUrl,
      caseName: o.case.name,
      caseSlug: o.case.slug,
      itemName: o.item.name,
      itemImageUrl: o.item.imageUrl,
      rarity: o.item.rarity as ItemRarity,
      price: o.itemPrice,
      createdAt: o.createdAt.toISOString(),
    }));
  }

  /**
   * Replaces the backlog with what the database said.
   *
   * Replaced rather than appended: the list is ordered newest first, and
   * pushing a database page onto whatever was already there would interleave
   * two orderings. Two instances warming at once write the same answer.
   */
  private async warmBacklog(drops: LiveDrop[]): Promise<void> {
    if (drops.length === 0) return;
    try {
      await this.redis
        .multi()
        .del(FEED_KEY)
        .rpush(FEED_KEY, ...drops.map((drop) => JSON.stringify(drop)))
        .exec();
    } catch (err) {
      this.logger.warn(`Could not warm the feed backlog: ${String(err)}`);
    }
  }
}
