import { type TicketRange, pickByRoll, rangeChance } from './tickets.ts';
import { distributeRanges } from './balancing.ts';

/**
 * The daily bonus wheel.
 *
 * Once a day the player spins for one of a fixed set of prizes. The wheel is
 * not a separate game with maths of its own: it is a ticket table exactly like
 * a case, rolled from the same seed pair and the same shared nonce counter, so
 * a spin is checked the way a drop is and needs no fairness page of its own.
 *
 * The prizes are heterogeneous — money, a discount, a free opening, a skin —
 * which is the one place in this project where a table really is authored by
 * hand rather than solved. What a solver would need is a single number to
 * optimise, and there is none: the point of the wheel is the variety, not the
 * return. What is bounded instead is the cost, and there is a test for it.
 */

export const BonusKind = {
  /** Straight credit to the balance, in minor units. */
  BALANCE: 'BALANCE',
  /** A cut off the next opening, in basis points. */
  DISCOUNT: 'DISCOUNT',
  /** One free opening of a case priced at or below the ceiling. */
  FREE_CASE: 'FREE_CASE',
  /** A skin priced at or below the ceiling, granted straight away. */
  FREE_ITEM: 'FREE_ITEM',
} as const;
export type BonusKind = (typeof BonusKind)[keyof typeof BonusKind];

/**
 * Rewards that are settled the moment the wheel stops, as opposed to the ones
 * that sit on the account until the player spends them.
 */
export const INSTANT_KINDS: readonly BonusKind[] = [BonusKind.BALANCE, BonusKind.FREE_ITEM];

/** Rewards that are redeemed later, against a case opening. */
export const VOUCHER_KINDS: readonly BonusKind[] = [BonusKind.DISCOUNT, BonusKind.FREE_CASE];

export function isVoucher(kind: BonusKind): boolean {
  return VOUCHER_KINDS.includes(kind);
}

export interface WheelSegment {
  /**
   * Stable identity of the slice. Stored on the spin rather than the index,
   * because reordering the wheel later must not re-label what somebody won
   * last month.
   */
  key: string;
  kind: BonusKind;
  /** Probability of landing here, 0..1. The shares sum to exactly 1. */
  share: number;
  /**
   * Meaning follows the kind: minor units for BALANCE, basis points for
   * DISCOUNT, and a price ceiling for FREE_CASE and FREE_ITEM.
   */
  value: number;
}

/**
 * The wheel.
 *
 * Ordered cheap-to-dear rather than by probability: the slices are drawn in
 * this order, and a wheel whose good slices cluster on one side reads as
 * rigged even when it is not.
 */
export const WHEEL_SEGMENTS: readonly WheelSegment[] = [
  { key: 'balance-10', kind: BonusKind.BALANCE, share: 0.3, value: 10_00 },
  { key: 'discount-10', kind: BonusKind.DISCOUNT, share: 0.2, value: 1000 },
  { key: 'balance-50', kind: BonusKind.BALANCE, share: 0.14, value: 50_00 },
  { key: 'discount-25', kind: BonusKind.DISCOUNT, share: 0.14, value: 2500 },
  { key: 'discount-50', kind: BonusKind.DISCOUNT, share: 0.08, value: 5000 },
  { key: 'free-case', kind: BonusKind.FREE_CASE, share: 0.06, value: 300_00 },
  { key: 'balance-250', kind: BonusKind.BALANCE, share: 0.05, value: 250_00 },
  { key: 'free-item', kind: BonusKind.FREE_ITEM, share: 0.03, value: 200_00 },
];

export type WheelSlice = WheelSegment & TicketRange & { chance: number };

/**
 * The wheel as ticket ranges.
 *
 * Computed once from the constant table, so every player spins the same wheel
 * and a past spin stays checkable against it. The ranges tile
 * `[0, TICKET_SPACE - 1]` with no gap, the same invariant a case has to satisfy.
 */
export const WHEEL: readonly WheelSlice[] = (() => {
  const ranges = distributeRanges(WHEEL_SEGMENTS.map((s) => s.share));
  return WHEEL_SEGMENTS.map((segment, i) => ({
    ...segment,
    ...ranges[i]!,
    chance: rangeChance(ranges[i]!),
  }));
})();

/** The slice a roll lands on. One function for the server and the check page. */
export function pickWheelSlice(roll: number): WheelSlice {
  return pickByRoll(WHEEL, roll);
}

export function findWheelSlice(key: string): WheelSlice | null {
  return WHEEL.find((s) => s.key === key) ?? null;
}

/**
 * How long between spins.
 *
 * A rolling day rather than a calendar one. A calendar reset hands whoever
 * lives in the right timezone two spins a few hours apart, and turns midnight
 * into a load spike for no reason anybody asked for.
 */
export const BONUS_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function nextSpinAt(lastSpinAt: Date | string | null): Date | null {
  if (lastSpinAt === null) return null;
  const last = typeof lastSpinAt === 'string' ? new Date(lastSpinAt) : lastSpinAt;
  return new Date(last.getTime() + BONUS_COOLDOWN_MS);
}

export function canSpin(lastSpinAt: Date | string | null, now: Date = new Date()): boolean {
  const next = nextSpinAt(lastSpinAt);
  return next === null || now.getTime() >= next.getTime();
}

/**
 * What a voucher saves on a given basket, in minor units.
 *
 * Returns 0 when it does not apply at all, which is what lets the caller pick
 * between several vouchers by simply taking the largest number.
 */
export function voucherSaving(
  kind: BonusKind,
  value: number,
  casePrice: number,
  count: number,
): number {
  if (kind === BonusKind.FREE_CASE) {
    // One opening out of the batch, and only if the case is within the ceiling.
    return casePrice <= value ? casePrice : 0;
  }
  if (kind === BonusKind.DISCOUNT) {
    // Rounded down, so the rounding error is the site's and never the player's
    // — the alternative hands out a fraction of a kopeck on every discount.
    return Math.floor((casePrice * count * value) / 10_000);
  }
  return 0;
}

/**
 * Worst-case cost of one spin, in minor units, ignoring the discounts.
 *
 * Discounts are excluded on purpose: they cost a share of what the player
 * chooses to spend afterwards rather than a fixed sum, so they belong to the
 * case margin rather than to the wheel's own budget.
 */
export function wheelGrantCost(): number {
  return WHEEL.reduce(
    (sum, slice) => (slice.kind === BonusKind.DISCOUNT ? sum : sum + slice.chance * slice.value),
    0,
  );
}
