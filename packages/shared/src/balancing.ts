import { TICKET_SPACE, type TicketRange, calculateRtp, rangeChance } from './tickets.ts';

/**
 * Case balancing.
 *
 * The operator's task reads as "spread the odds so the case is fun for the
 * player and profitable for the site". Formally that is one equation with N
 * unknowns — infinitely many solutions — so it needs a model. The one adopted
 * here is the natural one for cases: the pricier the item, the rarer it is.
 */

/**
 * Highest RTP a case is allowed to be saved with.
 * Above 100% the site loses money for certain; 98% leaves room for item prices
 * drifting between recalculations.
 */
export const MAX_ALLOWED_RTP = 0.98;

/** Working corridor: outside it a case is either unprofitable or unattractive. */
export const RTP_CORRIDOR = { min: 0.85, max: 0.95 } as const;

export interface PricedItem {
  /** Price in minor units. */
  price: number;
}

/**
 * Shares -> ticket ranges.
 *
 * Rounding down leaves a remainder of tickets, and it must not go to the last
 * item: in a price-sorted list the last one is the most expensive, and the
 * remainder would quietly raise both the knife's odds and the case's RTP.
 * The remainder goes to the item with the largest share, i.e. the cheapest.
 *
 * Items whose share rounds to zero still get one ticket: a slot in a case with
 * a zero chance is a lie on the showcase.
 */
export function distributeRanges(shares: readonly number[]): TicketRange[] {
  if (shares.length === 0) throw new Error('at least one share is required');
  if (shares.length > TICKET_SPACE) {
    throw new Error(`more items than tickets (${TICKET_SPACE})`);
  }

  const widths = shares.map((s) => Math.max(1, Math.floor(s * TICKET_SPACE)));

  let remainder = TICKET_SPACE - widths.reduce((a, b) => a + b, 0);
  if (remainder > 0) {
    let widest = 0;
    for (let i = 1; i < widths.length; i++) {
      if (widths[i]! > widths[widest]!) widest = i;
    }
    widths[widest]! += remainder;
  } else {
    // Clamping up to one ticket may have overrun the budget — take the
    // shortfall from the widest ranges, they can afford it.
    while (remainder < 0) {
      let widest = 0;
      for (let i = 1; i < widths.length; i++) {
        if (widths[i]! > widths[widest]!) widest = i;
      }
      if (widths[widest]! <= 1) throw new Error('too many items for the ticket space');
      const take = Math.min(-remainder, widths[widest]! - 1);
      widths[widest]! -= take;
      remainder += take;
    }
  }

  const ranges: TicketRange[] = [];
  let cursor = 0;
  for (const width of widths) {
    ranges.push({ rangeFrom: cursor, rangeTo: cursor + width - 1 });
    cursor += width;
  }
  return ranges;
}

/** Expected drop value for the given shares, in minor units. */
export function expectedValue(items: readonly (PricedItem & TicketRange)[]): number {
  return items.reduce((sum, i) => sum + rangeChance(i) * i.price, 0);
}

/**
 * Case price for a desired RTP: assemble the loot table first, then set the
 * price — not the other way round.
 */
export function suggestCasePrice(
  items: readonly (PricedItem & TicketRange)[],
  targetRtp: number,
): number {
  if (targetRtp <= 0) throw new Error('targetRtp must be greater than zero');
  return Math.round(expectedValue(items) / targetRtp);
}

export interface AutoBalanceResult {
  ranges: TicketRange[];
  /** Actual RTP after rounding to whole tickets — this is the real number. */
  actualRtp: number;
  /** Rarity curve exponent: 0 means uniform, higher makes pricey items rarer. */
  exponent: number;
}

export interface AutoBalanceFailure {
  ok: false;
  reason: string;
  /** Achievable RTP bounds at this case price — a hint about what to change. */
  minRtp: number;
  maxRtp: number;
}

export type AutoBalanceOutcome = ({ ok: true } & AutoBalanceResult) | AutoBalanceFailure;

/**
 * Solves for odds that hit a target RTP.
 *
 * Model: an item's weight is inversely proportional to its price raised to k,
 * `w_i = price_i^(-k)`. At k = 0 every item is equally likely; as k grows the
 * cheap ones crowd out the expensive ones. Expected return decreases
 * monotonically in k, so k is found by binary search.
 *
 * The achievable RTP range is bounded by the cheapest and priciest item: no
 * distribution can return less than the cheapest item or more than the
 * priciest one.
 */
export function autoBalance(
  items: readonly PricedItem[],
  casePrice: number,
  targetRtp: number,
): AutoBalanceOutcome {
  if (items.length === 0) {
    return { ok: false, reason: 'The case has no items', minRtp: 0, maxRtp: 0 };
  }
  if (casePrice <= 0) {
    return { ok: false, reason: 'Case price must be greater than zero', minRtp: 0, maxRtp: 0 };
  }
  if (items.some((i) => i.price <= 0)) {
    return {
      ok: false,
      reason: 'Every item needs a price — sync prices from Steam first',
      minRtp: 0,
      maxRtp: 0,
    };
  }

  const prices = items.map((i) => i.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);

  const minRtp = minPrice / casePrice;
  const maxRtp = maxPrice / casePrice;

  if (targetRtp < minRtp || targetRtp > maxRtp) {
    const cheapest = (minPrice / 100).toFixed(2);
    const priciest = (maxPrice / 100).toFixed(2);
    return {
      ok: false,
      reason:
        `At a case price of ${(casePrice / 100).toFixed(2)} the achievable RTP is ` +
        `${(minRtp * 100).toFixed(1)}% to ${(maxRtp * 100).toFixed(1)}% ` +
        `(items from ${cheapest} to ${priciest}). ` +
        (targetRtp < minRtp
          ? 'The target is below that — raise the case price or add a cheaper item.'
          : 'The target is above that — lower the case price or add a pricier item.'),
      minRtp,
      maxRtp,
    };
  }

  const targetEv = casePrice * targetRtp;
  const evAt = (k: number): number => {
    // Normalise prices by the minimum: price^(-k) overflows a double for
    // large prices and k, while normalising leaves the weight ratios intact.
    const weights = prices.map((p) => Math.pow(p / minPrice, -k));
    const total = weights.reduce((a, b) => a + b, 0);
    return prices.reduce((sum, p, i) => sum + (weights[i]! / total) * p, 0);
  };

  // evAt decreases monotonically in k: k = -60 pins everything to the
  // priciest item, k = 60 to the cheapest. Bounds chosen with slack.
  let lo = -60;
  let hi = 60;
  for (let iter = 0; iter < 200; iter++) {
    const mid = (lo + hi) / 2;
    if (evAt(mid) > targetEv) lo = mid;
    else hi = mid;
  }
  const exponent = (lo + hi) / 2;

  const weights = prices.map((p) => Math.pow(p / minPrice, -exponent));
  const total = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((w) => w / total);

  const ranges = distributeRanges(shares);
  const actualRtp = calculateRtp(
    ranges.map((r, i) => ({ ...r, price: prices[i]! })),
    casePrice,
  );

  return { ok: true, ranges, actualRtp, exponent };
}

export interface RtpVerdict {
  rtp: number;
  /** The case may be saved. */
  allowed: boolean;
  /** The case sits inside the working corridor. */
  healthy: boolean;
  message: string;
}

/** One reading of RTP, shared by the admin panel and server-side validation. */
export function judgeRtp(rtp: number): RtpVerdict {
  const percent = (rtp * 100).toFixed(2);

  if (rtp > MAX_ALLOWED_RTP) {
    return {
      rtp,
      allowed: false,
      healthy: false,
      message:
        `RTP ${percent}% — the site loses money over time. ` +
        `The cap is ${(MAX_ALLOWED_RTP * 100).toFixed(0)}%: raise the case price ` +
        `or lower the odds on expensive items.`,
    };
  }
  if (rtp > RTP_CORRIDOR.max) {
    return {
      rtp,
      allowed: true,
      healthy: false,
      message: `RTP ${percent}% — above the working corridor, the margin is razor thin.`,
    };
  }
  if (rtp < RTP_CORRIDOR.min) {
    return {
      rtp,
      allowed: true,
      healthy: false,
      message: `RTP ${percent}% — below the working corridor, such a case sells poorly.`,
    };
  }
  return { rtp, allowed: true, healthy: true, message: `RTP ${percent}% — inside the working corridor.` };
}
