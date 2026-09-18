import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import {
  CS2_APP_ID,
  ErrorCode,
  type SteamMarketItem,
  parsePriceOverview,
  parseSearchResponse,
  steamCurrencyCode,
  toSearchQuery,
} from '@caseforge/shared';
import { REDIS_CLIENT } from '../common/redis.module';
import { loadConfig } from '../common/config';

const SEARCH_TTL_SEC = 60 * 60;
const PRICE_TTL_SEC = 30 * 60;
const ITEM_META_TTL_SEC = 24 * 60 * 60;
const COOLDOWN_KEY = 'steam:market:cooldown';

/**
 * Minimum interval between market requests.
 *
 * Steam throttles at roughly 20 requests per minute and answers 429 without
 * explanation, then may hold the ban for several minutes. 3.5 seconds gives
 * about 17 requests per minute, with room to spare.
 */
const MIN_REQUEST_INTERVAL_MS = 3_500;

/** How long to stay silent after a 429. */
const COOLDOWN_AFTER_429_SEC = 300;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

@Injectable()
export class SteamMarketService {
  private readonly logger = new Logger(SteamMarketService.name);
  private readonly config = loadConfig();

  /**
   * The queue serialises Steam requests inside this process.
   * With several API instances the limiter would have to move into Redis —
   * while there is a single instance this is enough.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Market search — the source of images, rarity and a reference price.
   *
   * Two options exist for one reason: importing a catalogue written in another
   * language. `locale` asks Steam to answer in that language, and the response
   * then carries the localised name in `name` while `marketHashName` stays the
   * English key it always is — which is exactly what turns «AWP | Гиперзверь»
   * into `AWP | Hyper Beast` without a dictionary. `start` pages through a
   * weapon with more skins than one response can hold.
   */
  async search(
    query: string,
    count = 20,
    options: { start?: number; locale?: 'english' | 'russian' } = {},
  ): Promise<SteamMarketItem[]> {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];

    const start = Math.max(0, Math.trunc(options.start ?? 0));
    const locale = options.locale ?? 'english';
    const cacheKey = `steam:search:${locale}:${start}:${trimmed.toLowerCase()}:${count}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as SteamMarketItem[];

    const url = new URL('https://steamcommunity.com/market/search/render/');
    url.searchParams.set('appid', String(CS2_APP_ID));
    url.searchParams.set('norender', '1');
    url.searchParams.set('count', String(Math.min(count, 100)));
    url.searchParams.set('start', String(start));
    url.searchParams.set('query', trimmed);
    if (locale !== 'english') url.searchParams.set('l', locale);

    const payload = await this.request(url);
    const items = parseSearchResponse(payload);

    await this.redis.set(cacheKey, JSON.stringify(items), 'EX', SEARCH_TTL_SEC);
    // Cache metadata per item: the import reads it from here, so no separate
    // Steam round trip is needed for each item. Only the English answers go in
    // — a localised one would leave the item named «AWP | Гиперзверь» for every
    // import that follows.
    if (locale === 'english') {
      await Promise.all(
        items.map((item) =>
          this.redis.set(
            this.metaKey(item.marketHashName),
            JSON.stringify(item),
            'EX',
            ITEM_META_TTL_SEC,
          ),
        ),
      );
    }

    return items;
  }

  /**
   * Item metadata: from the search cache, otherwise via a targeted search.
   *
   * Searching by the raw market_hash_name is useless: the "|" and the exterior
   * parentheses return zero results even for items that are definitely listed.
   * So the name is normalised into keywords and the right variant is picked
   * out of the results by exact name match.
   */
  async getItemMeta(marketHashName: string): Promise<SteamMarketItem | null> {
    const cached = await this.redis.get(this.metaKey(marketHashName));
    if (cached) return JSON.parse(cached) as SteamMarketItem;

    const found = await this.search(toSearchQuery(marketHashName), 50);
    return found.find((i) => i.marketHashName === marketHashName) ?? null;
  }

  /**
   * Item price in the project's currency, in minor units.
   *
   * This endpoint rather than search: search always answers in dollars and
   * ignores the `currency` parameter.
   */
  async fetchPrice(marketHashName: string): Promise<number | null> {
    const cacheKey = `steam:price:${this.config.CURRENCY}:${marketHashName}`;
    const cached = await this.redis.get(cacheKey);
    if (cached !== null) return cached === 'null' ? null : Number.parseInt(cached, 10);

    const url = new URL('https://steamcommunity.com/market/priceoverview/');
    url.searchParams.set('appid', String(CS2_APP_ID));
    url.searchParams.set('currency', String(steamCurrencyCode(this.config.CURRENCY)));
    url.searchParams.set('market_hash_name', marketHashName);

    const payload = await this.request(url);
    const price = parsePriceOverview(payload);

    // Cache the negative result too, otherwise an item with no listings would
    // hit Steam on every sync.
    await this.redis.set(cacheKey, price === null ? 'null' : String(price), 'EX', PRICE_TTL_SEC);
    return price;
  }

  /** Seconds left of the post-429 pause; 0 means requests may proceed. */
  async cooldownRemaining(): Promise<number> {
    const ttl = await this.redis.ttl(COOLDOWN_KEY);
    return ttl > 0 ? ttl : 0;
  }

  private metaKey(marketHashName: string): string {
    return `steam:meta:${marketHashName}`;
  }

  private async request(url: URL): Promise<unknown> {
    const cooldown = await this.cooldownRemaining();
    if (cooldown > 0) {
      throw new HttpException(
        { code: ErrorCode.STEAM_RATE_LIMITED, message: `Steam is rate-limiting requests. Retry in ${cooldown}s.` },
        429,
      );
    }

    return this.schedule(async () => {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (response.status === 429) {
        await this.redis.set(COOLDOWN_KEY, '1', 'EX', COOLDOWN_AFTER_429_SEC);
        this.logger.warn(`Steam answered 429, pausing for ${COOLDOWN_AFTER_429_SEC}s`);
        throw new HttpException(
          { code: ErrorCode.STEAM_RATE_LIMITED, message: `Steam rate-limited the request. Pausing ${COOLDOWN_AFTER_429_SEC}s.` },
          429,
        );
      }
      if (!response.ok) {
        throw new HttpException(`Steam Market returned ${response.status}`, 502);
      }

      return response.json();
    });
  }

  private schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - this.lastRequestAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastRequestAt = Date.now();
      return fn();
    });
    // The tail of the queue must not inherit the previous request's rejection.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
