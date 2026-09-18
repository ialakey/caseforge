import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import {
  ErrorCode,
  ItemRarity,
  parseExterior,
  parseSteamRarity,
  steamImageUrl,
} from '@caseforge/shared';
import { badRequest } from '../common/app-error';
import { REDIS_CLIENT } from '../common/redis.module';

/** CS2: appId 730, inventory context 2. */
const CS2_APP_ID = 730;
const CS2_CONTEXT_ID = 2;

/**
 * How long a read of somebody's inventory is reused.
 *
 * Short, because the page it feeds is one a player refreshes after changing
 * something in Steam — and long enough that opening the deposit page twice in a
 * minute is one request rather than two. Steam has no rate limit published for
 * this endpoint and enforces one anyway.
 */
const CACHE_TTL_SEC = 60;

/** One item as it sits in a player's Steam inventory. */
export interface InventoryAsset {
  assetId: string;
  marketHashName: string;
  name: string;
  imageUrl: string | null;
  rarity: ItemRarity;
  exterior: string | null;
  /** Steam's own answer about whether this can be traded at all right now. */
  tradable: boolean;
}

/** The shape Steam answers with; only the parts this service reads. */
interface SteamInventoryResponse {
  success?: number;
  assets?: Array<{ assetid: string; classid: string; instanceid: string }>;
  descriptions?: Array<{
    classid: string;
    instanceid: string;
    market_hash_name?: string;
    name?: string;
    icon_url?: string;
    type?: string;
    tradable?: number;
  }>;
}

/**
 * Reads a player's own CS2 inventory.
 *
 * Separate from `SteamMarketService` because it is a different endpoint with
 * different failure modes: the market throttles, while this one is mostly a
 * question of whether the player has made their inventory public. The two
 * share nothing but a hostname.
 *
 * This is the only source of asset ids, and asset ids are the only thing a
 * trade offer can be built from — so a deposit is only ever as fresh as this
 * read. An id that has moved since produces an offer Steam refuses, which is
 * the correct outcome and why the cache is measured in seconds.
 */
@Injectable()
export class SteamInventoryService {
  private readonly logger = new Logger(SteamInventoryService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Everything tradable-looking in the player's CS2 inventory.
   *
   * A private inventory and a rate-limited one are both reported as
   * `INVENTORY_UNAVAILABLE`: from here they are indistinguishable, and the
   * advice — make it public and try again — is the same either way.
   */
  async load(steamId64: string): Promise<InventoryAsset[]> {
    const cacheKey = `steam:inventory:${steamId64}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as InventoryAsset[];
    } catch (err) {
      this.logger.warn(`Inventory cache unavailable: ${String(err)}`);
    }

    const url = new URL(
      `https://steamcommunity.com/inventory/${steamId64}/${CS2_APP_ID}/${CS2_CONTEXT_ID}`,
    );
    url.searchParams.set('l', 'english');
    // Steam caps the page anyway; asking for more than one page of a large
    // inventory is not worth the extra request for a deposit picker.
    url.searchParams.set('count', '2000');

    let payload: SteamInventoryResponse;
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw badRequest(
          ErrorCode.INVENTORY_UNAVAILABLE,
          response.status === 403
            ? 'Your Steam inventory is private — make it public and try again'
            : `Steam answered ${response.status} for your inventory`,
        );
      }
      payload = (await response.json()) as SteamInventoryResponse;
    } catch (err) {
      // A thrown app error passes through; anything else is a network problem
      // and says so rather than leaking a fetch stack to the player.
      if (err && typeof err === 'object' && 'code' in err) throw err;
      throw badRequest(
        ErrorCode.INVENTORY_UNAVAILABLE,
        'Could not reach Steam to read your inventory',
      );
    }

    const assets = this.parse(payload);

    try {
      await this.redis.set(cacheKey, JSON.stringify(assets), 'EX', CACHE_TTL_SEC);
    } catch {
      // A cache that will not store is a slower page, not a broken one.
    }
    return assets;
  }

  /** Drops the cached read, so a player who just fixed something sees it. */
  async invalidate(steamId64: string): Promise<void> {
    try {
      await this.redis.del(`steam:inventory:${steamId64}`);
    } catch {
      // Nothing to do: the entry expires on its own in a minute.
    }
  }

  /**
   * Joins Steam's two parallel lists into one.
   *
   * The response keeps assets and their descriptions apart — assets carry the
   * ids, descriptions carry the names and images — joined on
   * `classid:instanceid`. Several assets share one description, which is what
   * makes five identical cases five rows with one name.
   */
  private parse(payload: SteamInventoryResponse): InventoryAsset[] {
    if (!Array.isArray(payload.assets) || !Array.isArray(payload.descriptions)) return [];

    const byKey = new Map(
      payload.descriptions.map((d) => [`${d.classid}:${d.instanceid}`, d] as const),
    );

    const out: InventoryAsset[] = [];
    for (const asset of payload.assets) {
      const description = byKey.get(`${asset.classid}:${asset.instanceid}`);
      const marketHashName = description?.market_hash_name;
      if (!description || !marketHashName) continue;

      out.push({
        assetId: asset.assetid,
        marketHashName,
        name: description.name ?? marketHashName,
        imageUrl: description.icon_url ? steamImageUrl(description.icon_url) : null,
        rarity: parseSteamRarity(description.type),
        exterior: parseExterior(marketHashName),
        // Steam reports this as 0 or 1. Absent is treated as untradable: the
        // safe reading of a missing flag is the one that does not build an
        // offer Steam will refuse.
        tradable: description.tradable === 1,
      });
    }
    return out;
  }
}
