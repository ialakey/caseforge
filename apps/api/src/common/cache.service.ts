import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.module';

/**
 * A small read-through cache in Redis, for reads that are identical for
 * everybody.
 *
 * The catalogue is the case that makes it worth having: `GET /api/cases` joins
 * every case to its items and every item to the catalogue, and at peak it is
 * the most requested endpoint on the site while its answer changes a few times
 * an hour. Caching it converts thousands of identical joins per second into one
 * per TTL.
 *
 * Invalidation is by **version counter**, not by deleting keys. A namespace has
 * a counter in Redis, the counter is part of every key in it, and bumping the
 * counter orphans the whole namespace at once — no `SCAN` over the keyspace, no
 * partial deletion, and every API instance sees the bump because the counter
 * lives in Redis rather than in a process. The orphans expire on their own TTL.
 *
 * Nothing here is allowed to fail loudly: a cache that can take the site down
 * when Redis blinks is worse than no cache. Every path falls through to the
 * database.
 */

/** Cache namespaces. One per thing that is invalidated as a unit. */
export const CacheNamespace = {
  /** Cases and their contents: prices, chances, images. */
  CATALOGUE: 'catalogue',
} as const;
export type CacheNamespace = (typeof CacheNamespace)[keyof typeof CacheNamespace];

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Returns the cached value, or produces it and caches it.
   *
   * Deliberately without a lock. Two instances that miss at the same moment
   * both run the query and both write the same answer, which costs one extra
   * query per TTL; a lock would cost a round trip on every hit and a stall on
   * every holder that dies mid-flight.
   */
  async wrap<T>(
    namespace: CacheNamespace,
    key: string,
    ttlSeconds: number,
    produce: () => Promise<T>,
  ): Promise<T> {
    const full = await this.key(namespace, key);

    if (full !== null) {
      try {
        const hit = await this.redis.get(full);
        if (hit !== null) return JSON.parse(hit) as T;
      } catch (err) {
        this.logger.warn(`Cache read failed for ${full}: ${String(err)}`);
      }
    }

    const value = await produce();

    if (full !== null) {
      try {
        await this.redis.set(full, JSON.stringify(value), 'EX', ttlSeconds);
      } catch (err) {
        this.logger.warn(`Cache write failed for ${full}: ${String(err)}`);
      }
    }
    return value;
  }

  /**
   * Orphans everything in a namespace.
   *
   * Called after a write that changes what the cached reads would say — a case
   * edited in the back office, a price sync, an RTP recalculation.
   */
  async invalidate(namespace: CacheNamespace): Promise<void> {
    try {
      await this.redis.incr(versionKey(namespace));
    } catch (err) {
      // The stale answer now lives out its TTL. Logged rather than thrown: the
      // write that triggered this has already happened and must not be undone
      // by a cache that could not be told about it.
      this.logger.warn(`Could not invalidate ${namespace}: ${String(err)}`);
    }
  }

  /** The versioned key, or null when Redis cannot be reached at all. */
  private async key(namespace: CacheNamespace, key: string): Promise<string | null> {
    try {
      const version = (await this.redis.get(versionKey(namespace))) ?? '1';
      return `cache:${namespace}:${version}:${key}`;
    } catch (err) {
      this.logger.warn(`Cache unavailable, serving ${namespace}:${key} from the database`);
      return null;
    }
  }
}

function versionKey(namespace: CacheNamespace): string {
  return `cache:version:${namespace}`;
}
