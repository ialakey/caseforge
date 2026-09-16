import { z } from 'zod';
import { BASE_CURRENCY, type Minor } from './money.ts';

/**
 * market.csgo.com as the delivery channel.
 *
 * The alternative is a farm of Steam accounts that physically hold every skin
 * the site might ever have to hand out. That model has to be funded up front,
 * kept logged in, kept under the 1000-slot inventory cap, and it still fails
 * the moment a player wins something no bot happens to own.
 *
 * This one keeps no inventory at all. A withdrawal turns into a purchase: a
 * market account buys that exact skin from whoever is selling it cheapest and
 * names the player's trade link as the recipient, so the item never passes
 * through our hands. What the site carries is a price, not a warehouse.
 *
 * The parts that must not be guessed at are all here — units, stages and the
 * price ceiling — because every one of them is a way to lose real money by
 * being wrong by a factor of a hundred.
 */

export const MARKET_API_URL = 'https://market.csgo.com/api/v2';

/** Which channel hands items to the player. */
export const WITHDRAWAL_PROVIDERS = ['MARKET', 'BOTS'] as const;
export type WithdrawalProvider = (typeof WITHDRAWAL_PROVIDERS)[number];

/**
 * The market deletes an API key that goes over five requests a second, so the
 * client serialises its calls and never issues them faster than this.
 */
export const MARKET_MIN_REQUEST_INTERVAL_MS = 260;

/**
 * Trade stages the market reports for a purchase.
 *
 * Only these three are documented. Anything else is read as "still in flight"
 * rather than as a failure: an unfamiliar stage must not make the site write
 * off a purchase that is going to be delivered anyway.
 */
export const MarketStage = {
  NEW: 1,
  ITEM_GIVEN: 2,
  TIMED_OUT: 5,
} as const;

export type MarketOutcome = 'PENDING' | 'DELIVERED' | 'FAILED';

export function classifyStage(stage: number | null | undefined): MarketOutcome {
  if (stage === MarketStage.ITEM_GIVEN) return 'DELIVERED';
  if (stage === MarketStage.TIMED_OUT) return 'FAILED';
  return 'PENDING';
}

/**
 * How many market price units make up one unit of the currency.
 *
 * Not a typo: the market quotes roubles in kopecks but dollars and euros in
 * thousandths. Deriving this from the site's own minor units would overpay a
 * dollar account ten times over on every purchase.
 */
const MARKET_UNITS_PER_MAJOR: Record<string, number> = { RUB: 100, USD: 1000, EUR: 1000 };

/** The site stores money in minor units, always a hundred to the unit. */
const SITE_UNITS_PER_MAJOR = 100;

export function marketUnitsPerMajor(currency: string): number | null {
  return MARKET_UNITS_PER_MAJOR[currency.toUpperCase()] ?? null;
}

/**
 * Whether a market account can settle for this site at all.
 *
 * Cross-currency buying would need a settlement rate, and the only rate the
 * site has is a display one that is explicitly not allowed to price anything
 * (see FxService). Rather than invent one, an account in the wrong currency is
 * refused outright: a withdrawal that does not happen is recoverable, one
 * priced off a display rate is not.
 */
export function marketCurrencyProblem(currency: string | null | undefined): string | null {
  if (!currency) return 'The market account did not report a currency';
  const normalised = currency.toUpperCase();
  if (!marketUnitsPerMajor(normalised)) return `Unsupported market currency ${normalised}`;
  if (normalised !== BASE_CURRENCY) {
    return `The market account settles in ${normalised} but the site settles in ${BASE_CURRENCY}`;
  }
  return null;
}

/** Site minor units into the integer the market's `price` parameter expects. */
export function toMarketPrice(minor: Minor, currency: string): number {
  const units = marketUnitsPerMajor(currency) ?? SITE_UNITS_PER_MAJOR;
  return Math.round((minor * units) / SITE_UNITS_PER_MAJOR);
}

/** A market `price` back into site minor units. */
export function fromMarketPrice(price: number, currency: string): Minor {
  const units = marketUnitsPerMajor(currency) ?? SITE_UNITS_PER_MAJOR;
  return Math.round((price * SITE_UNITS_PER_MAJOR) / units);
}

/**
 * `money` and `paid` come back as floats in whole currency units, unlike every
 * other amount the API returns. Rounding here rather than at each call site is
 * the difference between a balance of 12 345 kopecks and one of 123.
 */
export function fromMarketMajor(amount: number): Minor {
  return Math.round(amount * SITE_UNITS_PER_MAJOR);
}

/**
 * The most the site will pay to deliver one item.
 *
 * The player was credited a price when the item dropped; the market charges
 * whatever it charges today. The gap between the two is the operator's to set,
 * and the cap is what stops a thin market — one seller, asking triple — from
 * turning a 200 rouble withdrawal into a 600 rouble one. Past the cap the
 * request fails and the item returns to the inventory, which is a refusal
 * rather than a loss.
 */
export function maxPayable(itemPrice: Minor, overpayBps: number): Minor {
  return Math.floor((itemPrice * (10_000 + overpayBps)) / 10_000);
}

/**
 * An account as the pool sees it when deciding who buys the next item.
 *
 * Deliberately not the database row: the choice depends on four facts and
 * nothing else, which is what makes it testable without a market or a schema.
 */
export interface MarketAccountCandidate {
  id: string;
  /** Only ONLINE accounts buy; the rest are out of rotation. */
  status: string;
  /** Last known balance in settlement minor units, null if never read. */
  balance: number | null;
  currency: string | null;
  /** When this account last had a request sent to it. */
  lastUsedAt: number;
}

/**
 * Which account should buy the next item.
 *
 * Two constraints pull in opposite directions. The money one is obvious: an
 * account that cannot cover the price will simply be refused, so it is skipped.
 * The other is the reason several accounts exist at all — the market deletes a
 * key that exceeds five requests a second, and a purchase is several requests,
 * so load has to be spread rather than concentrated on whichever account
 * happens to be richest. Hence least-recently-used among those that can afford
 * it: the balance decides who *may* buy, the clock decides who *does*.
 *
 * A null balance means the account has never been read. It is treated as usable
 * rather than skipped, because refusing to try an account we know nothing about
 * would make a fresh pool permanently idle.
 */
export function pickAccount(
  accounts: readonly MarketAccountCandidate[],
  price: number,
): MarketAccountCandidate | null {
  let best: MarketAccountCandidate | null = null;

  for (const account of accounts) {
    if (account.status !== 'ONLINE') continue;
    if (marketCurrencyProblem(account.currency)) continue;
    if (account.balance !== null && account.balance < price) continue;
    if (!best || account.lastUsedAt < best.lastUsedAt) best = account;
  }

  return best;
}

/**
 * Why no account could take a purchase, in words an operator can act on.
 *
 * "No account available" is true and useless; an operator needs to know whether
 * to add a key, re-enable one, or top one up.
 */
export function explainNoAccount(
  accounts: readonly MarketAccountCandidate[],
  price: number,
): string {
  if (accounts.length === 0) return 'No market account is registered';

  const online = accounts.filter((a) => a.status === 'ONLINE');
  if (online.length === 0) {
    return `No market account is online (${accounts.length} registered)`;
  }

  const wrongCurrency = online.filter((a) => marketCurrencyProblem(a.currency));
  if (wrongCurrency.length === online.length) {
    return (
      marketCurrencyProblem(online[0]!.currency) ?? 'Every account settles in another currency'
    );
  }

  return `No market account has the ${price} this purchase needs`;
}

export interface MarketOffer {
  price: number;
  count: number;
  class: number | null;
  instance: number | null;
}

/**
 * The cheapest offer the site is willing to take.
 *
 * `search-item-by-hash-name` is not documented as sorted, and an entry with
 * `count: 0` is a listing that has already gone.
 */
export function pickOffer(offers: MarketOffer[], maxPrice: number): MarketOffer | null {
  let best: MarketOffer | null = null;
  for (const offer of offers) {
    if (offer.count <= 0) continue;
    if (offer.price > maxPrice) continue;
    if (!best || offer.price < best.price) best = offer;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Response shapes.
//
// Parsed rather than cast: this is a third-party API spending real money, and
// the failure mode of trusting it is buying at a price that was never in the
// payload. Numeric fields are coerced because the market returns several of
// them as strings depending on the endpoint.
// ---------------------------------------------------------------------------

const envelope = {
  success: z.coerce.boolean().optional(),
  error: z.string().optional(),
  code: z.coerce.number().optional(),
};

export const marketTestSchema = z.object({
  ...envelope,
  status: z
    .object({
      user_token: z.coerce.boolean().optional(),
      trade_check: z.coerce.boolean().optional(),
      site_online: z.coerce.boolean().optional(),
      site_notmpban: z.coerce.boolean().optional(),
      steam_web_api_key: z.coerce.boolean().optional(),
    })
    .optional(),
});
export type MarketTestResponse = z.infer<typeof marketTestSchema>;

export const marketMoneySchema = z.object({
  ...envelope,
  money: z.coerce.number().optional(),
  money_settlement: z.coerce.number().optional(),
  currency: z.string().optional(),
});
export type MarketMoneyResponse = z.infer<typeof marketMoneySchema>;

export const marketSearchSchema = z.object({
  ...envelope,
  currency: z.string().optional(),
  data: z
    .array(
      z.object({
        market_hash_name: z.string().optional(),
        price: z.coerce.number(),
        count: z.coerce.number().optional(),
        class: z.coerce.number().optional(),
        instance: z.coerce.number().optional(),
      }),
    )
    .optional(),
});

export const marketBuySchema = z.object({
  ...envelope,
  id: z.coerce.string().optional(),
});

export const marketBuyInfoSchema = z.object({
  item_id: z.coerce.string().optional(),
  market_hash_name: z.string().optional(),
  time: z.coerce.number().optional(),
  paid: z.coerce.number().optional(),
  stage: z.coerce.number().optional(),
  trade_id: z.coerce.string().nullish(),
  bot_id: z.coerce.string().nullish(),
  for: z.coerce.string().nullish(),
  causer: z.string().nullish(),
  cancellation_reason: z.string().nullish(),
  currency: z.string().optional(),
});
export type MarketBuyInfo = z.infer<typeof marketBuyInfoSchema>;

export const marketBuyListSchema = z.object({
  ...envelope,
  data: z.record(z.string(), marketBuyInfoSchema).optional(),
});

/** The market's own wording for a cancellation, as a line support can read. */
export function describeCancellation(info: MarketBuyInfo): string {
  const reason = info.cancellation_reason ?? 'unknown';
  const causer = info.causer ? ` (${info.causer})` : '';
  return `The market cancelled the trade: ${reason}${causer}`;
}
