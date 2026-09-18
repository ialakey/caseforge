import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import type { SiteStats } from '@caseforge/shared';
import { PRISMA_READ } from './prisma-read';
import { REDIS_CLIENT } from './redis.module';

/**
 * How long the counters are reused.
 *
 * They are six full-table counts on the busiest page of the site. A minute of
 * staleness on "1 614 579 486 cases opened" is invisible; running the counts
 * per visitor is not.
 */
const CACHE_KEY = 'stats:site';
const CACHE_TTL_SEC = 60;

/**
 * Presence, as a heartbeat per API instance.
 *
 * One process cannot answer "how many people are online" on its own — it only
 * knows its own sockets, and the site is meant to run several instances. So
 * each writes its own count under its own key with a short expiry, and the
 * total is the sum of whatever is still alive. An instance that dies stops
 * being counted a few seconds later without anybody cleaning up after it.
 */
const PRESENCE_PREFIX = 'stats:online:';
const PRESENCE_TTL_SEC = 45;

@Injectable()
export class SiteStatsService {
  private readonly logger = new Logger(SiteStatsService.name);

  /** This process, for as long as it lives. Not persisted anywhere. */
  private readonly instanceId = randomUUID();

  constructor(
    // A report's worth of counting belongs on the replica: nobody is reading
    // their own write here, and a minute-old number is the point of the cache.
    @Inject(PRISMA_READ) private readonly read: PrismaClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Publishes this instance's socket count. Called by the gateway. */
  async reportPresence(connected: number): Promise<void> {
    try {
      await this.redis.set(
        `${PRESENCE_PREFIX}${this.instanceId}`,
        String(connected),
        'EX',
        PRESENCE_TTL_SEC,
      );
    } catch {
      // Presence is decoration; a Redis blip costs the counter, not the page.
    }
  }

  async get(): Promise<SiteStats> {
    // Presence is read fresh even when the rest is cached: "online" is the one
    // number a visitor might watch, and a minute-old one reads as broken.
    const online = await this.online();

    try {
      const cached = await this.redis.get(CACHE_KEY);
      if (cached) return { ...(JSON.parse(cached) as Omit<SiteStats, 'online'>), online };
    } catch (err) {
      this.logger.warn(`Stats cache unavailable: ${String(err)}`);
    }

    const [casesOpened, contracts, upgrades, battles, users] = await Promise.all([
      this.read.caseOpening.count(),
      this.read.contract.count(),
      this.read.upgrade.count(),
      // Only finished ones: a battle still waiting for players has not
      // happened yet, and counting it would make an empty lobby inflate the
      // number every time somebody opened one.
      this.read.battle.count({ where: { status: 'FINISHED' } }),
      this.read.user.count(),
    ]);

    const counted = { casesOpened, contracts, upgrades, battles, users };
    try {
      await this.redis.set(CACHE_KEY, JSON.stringify(counted), 'EX', CACHE_TTL_SEC);
    } catch {
      // A cache that will not store is a slower page, not a broken one.
    }

    return { ...counted, online };
  }

  /** The sum of every instance still reporting. */
  private async online(): Promise<number> {
    try {
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await this.redis.scan(
          cursor,
          'MATCH',
          `${PRESENCE_PREFIX}*`,
          'COUNT',
          100,
        );
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0');

      if (keys.length === 0) return 0;
      const values = await this.redis.mget(keys);
      return values.reduce((sum, v) => sum + (Number(v) || 0), 0);
    } catch {
      return 0;
    }
  }
}
