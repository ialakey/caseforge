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
const FEED_KEY = 'drops:recent';
const FEED_KEEP = 50;

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

  private async recentFromDatabase(limit: number): Promise<LiveDrop[]> {
    const openings = await this.read.caseOpening.findMany({
      where: { item: { rarity: { in: [...FEED_RARITIES] } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: true, item: true, case: true },
    });

    return openings.map((o) => ({
      openingId: o.id,
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
