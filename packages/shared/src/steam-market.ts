import { ItemRarity } from './types.ts';

/**
 * Parsing of Steam Community Market responses.
 *
 * Pure functions with no network calls: a price parsed wrongly slips quietly
 * into the case economy, so every parser here is covered by tests.
 */

/** CS2 on Steam. */
export const CS2_APP_ID = 730;

/** Steam currency codes. */
export const STEAM_CURRENCIES: Record<string, number> = {
  USD: 1,
  GBP: 2,
  EUR: 3,
  CHF: 4,
  RUB: 5,
  PLN: 6,
  BRL: 7,
  JPY: 8,
  NOK: 9,
  IDR: 10,
  MYR: 11,
  PHP: 12,
  SGD: 13,
  THB: 14,
  VND: 15,
  KRW: 16,
  TRY: 17,
  UAH: 18,
  MXN: 19,
  CAD: 20,
  AUD: 21,
  NZD: 22,
  CNY: 23,
  INR: 24,
  KZT: 37,
};

export function steamCurrencyCode(currency: string): number {
  return STEAM_CURRENCIES[currency.toUpperCase()] ?? STEAM_CURRENCIES.USD!;
}

/**
 * Steam price text to minor units.
 *
 * Steam formats prices per the currency locale: "$86.96", "3225,06 руб.",
 * "1.234,56€", "₩ 12,500". The decimal separator is identified by position:
 * it is the last separator followed by exactly two digits and nothing else.
 * Everything else is a thousands separator.
 *
 * Returns null when the string holds no number: silently returning 0 is not an
 * option, it would make the item free.
 */
export function parseSteamPrice(text: string | null | undefined): number | null {
  if (!text) return null;

  // Trailing separators are trimmed separately: in "3225,06 руб." the period
  // from the currency abbreviation otherwise sticks to the number and breaks
  // the fractional part.
  const digitsAndSeparators = text.replace(/[^\d.,]/g, '').replace(/^[.,]+|[.,]+$/g, '');
  if (!/\d/.test(digitsAndSeparators)) return null;

  const decimalMatch = /^(.*)([.,])(\d{2})$/.exec(digitsAndSeparators);

  if (decimalMatch) {
    const whole = decimalMatch[1]!.replace(/[.,]/g, '');
    const fraction = decimalMatch[3]!;
    if (whole === '') return Number.parseInt(fraction, 10);
    return Number.parseInt(whole, 10) * 100 + Number.parseInt(fraction, 10);
  }

  // No fractional part — either a currency without minor units (KRW, JPY,
  // IDR) or a round amount. Treat every separator as a thousands separator.
  const whole = digitsAndSeparators.replace(/[.,]/g, '');
  return Number.parseInt(whole, 10) * 100;
}

/**
 * Rarity from the asset_description.type field.
 *
 * Steam encodes rarity as a word inside the type string: "Classified Rifle",
 * "★ Covert Knife", "StatTrak™ Mil-Spec Grade SMG". Knives and gloves carry a
 * star and are always the top tier on case sites, so the star is checked
 * before the worded grade.
 */
export function parseSteamRarity(type: string | null | undefined): ItemRarity {
  if (!type) return ItemRarity.CONSUMER;

  if (type.includes('★')) return ItemRarity.EXTRAORDINARY;

  const lowered = type.toLowerCase();

  // Order matters: top tiers first, otherwise a broader word would swallow
  // "Extraordinary".
  if (lowered.includes('contraband')) return ItemRarity.EXTRAORDINARY;
  if (lowered.includes('extraordinary')) return ItemRarity.EXTRAORDINARY;
  if (lowered.includes('covert')) return ItemRarity.COVERT;
  if (lowered.includes('classified') || lowered.includes('exotic')) return ItemRarity.CLASSIFIED;
  if (lowered.includes('restricted') || lowered.includes('remarkable')) {
    return ItemRarity.RESTRICTED;
  }
  if (lowered.includes('mil-spec') || lowered.includes('high grade')) return ItemRarity.MILSPEC;
  if (lowered.includes('industrial')) return ItemRarity.INDUSTRIAL;

  return ItemRarity.CONSUMER;
}

const EXTERIORS = [
  'Factory New',
  'Minimal Wear',
  'Field-Tested',
  'Well-Worn',
  'Battle-Scarred',
] as const;

/** Exterior from market_hash_name: "AK-47 | Redline (Field-Tested)". */
export function parseExterior(marketHashName: string): string | null {
  const match = /\(([^()]+)\)\s*$/.exec(marketHashName);
  const candidate = match?.[1];
  return candidate && (EXTERIORS as readonly string[]).includes(candidate) ? candidate : null;
}

/** Weapon type — the last word of asset_description.type. */
export function parseWeaponType(type: string | null | undefined): string | null {
  if (!type) return null;
  const words = type.trim().split(/\s+/);
  const last = words[words.length - 1];
  return last && /^[A-Za-z-]+$/.test(last) ? last : null;
}

/**
 * market_hash_name -> a query string for market search.
 *
 * Steam search does not accept the full item name: the "|" character and the
 * exterior parentheses return zero results even for items that are definitely
 * listed. Only plain keywords work, so the name is stripped of punctuation,
 * quality prefixes and exterior.
 *
 * The "★" prefix on knives and gloves is stripped too: search does not want
 * it, yet market_hash_name requires it — without the star Steam does not know
 * the item at all.
 */
export function toSearchQuery(marketHashName: string): string {
  return marketHashName
    .replace(/★/g, ' ')
    .replace(/StatTrak™/gi, ' ')
    .replace(/Souvenir/gi, ' ')
    .replace(/\([^()]*\)\s*$/, ' ')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Full item image URL from icon_url. */
export function steamImageUrl(iconUrl: string, size = '360fx360f'): string {
  return `https://community.cloudflare.steamstatic.com/economy/image/${iconUrl}/${size}`;
}

export interface SteamMarketItem {
  marketHashName: string;
  name: string;
  imageUrl: string | null;
  rarity: ItemRarity;
  weaponType: string | null;
  exterior: string | null;
  /** Reference price from search — always US dollars, in cents. */
  referencePriceUsd: number | null;
  listings: number;
}

interface SteamSearchResult {
  hash_name?: string;
  name?: string;
  sell_price?: number;
  sell_listings?: number;
  asset_description?: {
    icon_url?: string;
    type?: string;
    market_hash_name?: string;
  };
}

/**
 * Parses a market/search/render response.
 *
 * Note: sell_price here is always in dollars — this endpoint ignores the
 * `currency` parameter. The price in the project's currency is fetched
 * separately through priceoverview, so this one is labelled as a reference.
 */
export function parseSearchResponse(payload: unknown): SteamMarketItem[] {
  const results = (payload as { results?: SteamSearchResult[] } | null)?.results;
  if (!Array.isArray(results)) return [];

  const items: SteamMarketItem[] = [];
  for (const entry of results) {
    const marketHashName = entry.hash_name ?? entry.asset_description?.market_hash_name;
    if (!marketHashName) continue;

    const iconUrl = entry.asset_description?.icon_url;
    items.push({
      marketHashName,
      name: entry.name ?? marketHashName,
      imageUrl: iconUrl ? steamImageUrl(iconUrl) : null,
      rarity: parseSteamRarity(entry.asset_description?.type),
      weaponType: parseWeaponType(entry.asset_description?.type),
      exterior: parseExterior(marketHashName),
      referencePriceUsd: typeof entry.sell_price === 'number' ? entry.sell_price : null,
      listings: entry.sell_listings ?? 0,
    });
  }
  return items;
}

/**
 * Parses a priceoverview response.
 *
 * Takes median_price rather than lowest_price: the market minimum jumps around
 * with individual dumped listings, and a case priced off it values the item
 * below what it actually sells for.
 */
export function parsePriceOverview(payload: unknown): number | null {
  const data = payload as
    | { success?: boolean; median_price?: string; lowest_price?: string }
    | null;
  if (!data?.success) return null;
  return parseSteamPrice(data.median_price) ?? parseSteamPrice(data.lowest_price);
}
