import { TICKET_SPACE, type TicketRange, pickByRoll, rangeChance } from './tickets.ts';

/**
 * Contracts.
 *
 * The player throws several items into a contract and gets exactly one back.
 * Unlike an upgrade there is no win and no loss: a contract always returns an
 * item, the only question is which. The outcome table is not authored by hand
 * but derived from the staked value, the same way an upgrade derives its
 * chance from a price ratio. A hand-tuned table would be a second economy
 * living next to the cases with no relation to their maths.
 */

/**
 * The cut the site keeps on a contract.
 *
 * Identical to the cases and the upgrade on purpose: a player moving value
 * between the three modes should not be able to find a cheaper one. The whole
 * construction below exists so that this number, rather than the shape of the
 * pool, is what decides the site's margin.
 */
export const CONTRACT_RTP = 0.9;

/** How many items a contract accepts. */
export const CONTRACT_MIN_ITEMS = 3;
export const CONTRACT_MAX_ITEMS = 10;

/**
 * The reward band, as a multiple of the staked sum.
 *
 * The floor keeps the worst outcome from being a rounding error the player
 * cannot even sell; the ceiling bounds the site's exposure on one contract.
 * Both are multipliers rather than absolute prices, so the band scales with
 * the stake instead of favouring one price bracket.
 */
export const CONTRACT_MIN_MULTIPLIER = 0.1;
export const CONTRACT_MAX_MULTIPLIER = 5;

/**
 * Outcomes in a contract.
 *
 * Twelve is a reel the eye can read; a hundred is a wall of thumbnails in
 * which the player cannot see what they are playing for.
 */
export const CONTRACT_POOL_SIZE = 12;

/**
 * Below this the pool is refused rather than played.
 *
 * A contract over three outcomes is not a contract but a coin flip with extra
 * steps, and it leaves the solver too little room to place the expected value
 * where it belongs.
 */
export const CONTRACT_MIN_POOL = 5;

export interface ContractCandidate {
  itemId: string;
  price: number;
}

export interface ContractOutcome extends TicketRange {
  itemId: string;
  price: number;
  /** Share of the ticket space this outcome owns, 0..1. */
  chance: number;
}

export interface ContractPool {
  outcomes: ContractOutcome[];
  /** Price band the outcomes were drawn from. */
  rewardRange: { min: number; max: number };
  /** Expected reward implied by the final integer ticket ranges. */
  expectedValue: number;
  /** expectedValue / stakeValue — lands on CONTRACT_RTP. */
  rtp: number;
}

export interface ContractRejection {
  ok: false;
  reason: string;
}

export type ContractPoolResult = ({ ok: true } & ContractPool) | ContractRejection;

/** Prices a contract of this size may reward. */
export function contractRewardPriceRange(stakeValue: number): { min: number; max: number } {
  return {
    min: Math.ceil(stakeValue * CONTRACT_MIN_MULTIPLIER),
    max: Math.floor(stakeValue * CONTRACT_MAX_MULTIPLIER),
  };
}

/**
 * Exponential tilt over the pool.
 *
 * Weights follow `exp(-alpha * u)`, where `u` is the outcome's price on a log
 * scale normalised to `[0, 1]` across the pool. Normalising matters: with raw
 * log-prices the same alpha would mean different things for a pool spanning
 * 10x and one spanning 10000x, and the bracket the solver searches could no
 * longer be a constant. On this scale alpha = 0 is a uniform pool, a positive
 * alpha leans on the cheap outcomes and a negative one on the expensive.
 */
function tiltedWeights(logs: readonly number[], span: number, alpha: number): number[] {
  const exponents = logs.map((l) => (-alpha * (l - logs[0]!)) / span);
  // Shift by the maximum before exponentiating: the exponents themselves are
  // meaningless, only their differences are, and the shift keeps exp() away
  // from its overflow end at the extremes of the bracket.
  const peak = Math.max(...exponents);
  const raw = exponents.map((e) => Math.exp(e - peak));
  const total = raw.reduce((sum, r) => sum + r, 0);
  return raw.map((r) => r / total);
}

function tiltedExpectedValue(
  prices: readonly number[],
  logs: readonly number[],
  span: number,
  alpha: number,
): number {
  const weights = tiltedWeights(logs, span, alpha);
  return weights.reduce((sum, w, i) => sum + w * prices[i]!, 0);
}

/**
 * Widest tilt the solver considers.
 *
 * The expected value falls monotonically in alpha — its derivative is minus
 * the variance of the tilted distribution — so a bisection converges provided
 * the bracket straddles the target. This bound is wide enough for any pool the
 * band admits: at alpha = 100 every outcome further than 0.1 in normalised
 * log-price from the cheapest is suppressed by e^-10, leaving an expected
 * value under 1.5x the cheapest outcome, which is itself only 0.1x the stake.
 * The target sits at 0.9x, well above. The upper end brackets by the same
 * argument from the dearest outcome at 5x.
 */
const ALPHA_BOUND = 100;

/** Bisection on a monotonically decreasing function — 80 halvings exhaust the mantissa. */
function solveAlpha(
  prices: readonly number[],
  logs: readonly number[],
  span: number,
  target: number,
): number {
  let low = -ALPHA_BOUND;
  let high = ALPHA_BOUND;
  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2;
    if (tiltedExpectedValue(prices, logs, span, mid) > target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * Turns fractional weights into whole tickets that tile the space exactly.
 *
 * Largest remainder rather than plain rounding: rounding each weight on its
 * own leaves the total off by a few tickets, and a ticket space with a hole in
 * it is a roll that matches no outcome.
 */
function allocateTickets(weights: readonly number[]): number[] {
  const exact = weights.map((w) => w * TICKET_SPACE);
  const counts = exact.map((e) => Math.floor(e));
  let assigned = counts.reduce((sum, c) => sum + c, 0);

  const byRemainder = exact
    .map((e, i) => ({ i, remainder: e - Math.floor(e) }))
    // Ties break on the index, so the allocation does not lean on a sort
    // stability guarantee.
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);

  for (let k = 0; assigned < TICKET_SPACE; k++) {
    counts[byRemainder[k % byRemainder.length]!.i]! += 1;
    assigned += 1;
  }
  return counts;
}

/**
 * Evenly spaced sample that always keeps the first and last element.
 *
 * The ends set the band the player sees, so they are not negotiable; what lies
 * between them is thinned out to keep the reel readable.
 */
function takeSpread<T>(items: readonly T[], size: number): T[] {
  if (items.length <= size) return [...items];
  const step = (items.length - 1) / (size - 1);
  return Array.from({ length: size }, (_, i) => items[Math.round(i * step)]!);
}

/**
 * Builds the outcome table for a stake.
 *
 * Deterministic in its inputs: the same catalogue and the same staked sum
 * always produce the same table, which is what makes a stored contract
 * checkable afterwards rather than merely recorded.
 */
export function buildContractPool(
  candidates: readonly ContractCandidate[],
  stakeValue: number,
): ContractPoolResult {
  if (!Number.isFinite(stakeValue) || stakeValue <= 0) {
    return { ok: false, reason: 'The staked items have no price' };
  }

  const rewardRange = contractRewardPriceRange(stakeValue);
  const target = stakeValue * CONTRACT_RTP;

  const seen = new Set<string>();
  const inBand = candidates
    .filter((c) => {
      if (!Number.isFinite(c.price) || c.price < rewardRange.min || c.price > rewardRange.max) {
        return false;
      }
      if (seen.has(c.itemId)) return false;
      seen.add(c.itemId);
      return true;
    })
    // Sorted by price, ties broken on the id: the caller's ordering must not
    // leak into the outcome table.
    .sort((a, b) => a.price - b.price || (a.itemId < b.itemId ? -1 : 1));

  if (inBand.length < CONTRACT_MIN_POOL) {
    return {
      ok: false,
      reason:
        `Not enough items priced between ${rewardRange.min} and ${rewardRange.max} ` +
        'for a contract of this size.',
    };
  }

  // Sample evenly across the sorted band, keeping both ends. Taking the
  // cheapest N instead would cap the reward below the stake and turn every
  // contract into a guaranteed loss.
  let pool = takeSpread(inBand, CONTRACT_POOL_SIZE);

  // An outcome so unlikely it owns no ticket cannot be won, and drawing it on
  // the reel would be a lie. Drop those and solve again over what is left:
  // a dropped outcome is always the extreme the tilt was straining against, so
  // the pool shrinks and the loop terminates.
  for (;;) {
    const prices = pool.map((c) => c.price);
    const cheapest = prices[0]!;
    const dearest = prices[prices.length - 1]!;

    // The expected value has to sit strictly inside the pool; otherwise no
    // tilt reaches it and the bisection would quietly return a bound.
    if (!(cheapest < target && target < dearest)) {
      return {
        ok: false,
        reason: 'The available items cannot be balanced to the contract payout.',
      };
    }

    const logs = prices.map((p) => Math.log(p));
    const span = logs[logs.length - 1]! - logs[0]!;
    const alpha = solveAlpha(prices, logs, span, target);
    const counts = allocateTickets(tiltedWeights(logs, span, alpha));

    if (counts.every((c) => c > 0)) {
      let cursor = 0;
      const outcomes = pool.map((candidate, i) => {
        const range = { rangeFrom: cursor, rangeTo: cursor + counts[i]! - 1 };
        cursor += counts[i]!;
        return {
          itemId: candidate.itemId,
          price: candidate.price,
          ...range,
          chance: rangeChance(range),
        };
      });

      // Reported from the integer ranges rather than from the solver's
      // weights: the rounded table is what the player actually plays, and a
      // percentage quoted off the pre-rounding maths would be the wrong
      // number, however slightly.
      const expectedValue = outcomes.reduce((sum, o) => sum + o.chance * o.price, 0);

      return { ok: true, outcomes, rewardRange, expectedValue, rtp: expectedValue / stakeValue };
    }

    const survivors = pool.filter((_, i) => counts[i]! > 0);
    if (survivors.length < CONTRACT_MIN_POOL) {
      return {
        ok: false,
        reason: 'The available items cannot be balanced to the contract payout.',
      };
    }
    pool = survivors;
  }
}

/** The outcome a roll lands on. One function for the server and the check page. */
export function pickContractOutcome<T extends TicketRange>(
  outcomes: readonly T[],
  roll: number,
): T {
  return pickByRoll(outcomes, roll);
}

/** Whether a set of staked items is a legal contract at all. */
export function isValidContractSize(count: number): boolean {
  return Number.isInteger(count) && count >= CONTRACT_MIN_ITEMS && count <= CONTRACT_MAX_ITEMS;
}
