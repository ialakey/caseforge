/**
 * The ticket space and everything derived from it.
 *
 * This module deliberately depends on no cryptography: both the server and
 * the browser bundle import it, and `node:crypto` does not bundle for the
 * browser.
 */

/**
 * Size of the ticket space. Every item in a case owns a range of tickets, and
 * the ranges of all items in a case must cover `[0, TICKET_SPACE - 1]` with no
 * gaps and no overlaps.
 *
 * The value is fixed forever: changing it would make every past opening
 * impossible to verify.
 */
export const TICKET_SPACE = 1_000_000;

export interface TicketRange {
  rangeFrom: number;
  rangeTo: number;
}

/** Finds the item whose ticket range covers the roll. */
export function pickByRoll<T extends TicketRange>(items: readonly T[], roll: number): T {
  const hit = items.find((i) => roll >= i.rangeFrom && roll <= i.rangeTo);
  if (!hit) {
    // Unreachable with valid ranges — reaching it means a case was saved
    // bypassing validation.
    throw new Error(`no item covers roll ${roll}; case ticket ranges are corrupted`);
  }
  return hit;
}

export interface RangeValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * A case's ranges must tile `[0, TICKET_SPACE - 1]` continuously.
 * Called every time a case is saved from the admin panel.
 */
export function validateTicketRanges(items: readonly TicketRange[]): RangeValidationResult {
  const errors: string[] = [];
  if (items.length === 0) {
    return { valid: false, errors: ['case must contain at least one item'] };
  }

  for (const [idx, item] of items.entries()) {
    if (!Number.isInteger(item.rangeFrom) || !Number.isInteger(item.rangeTo)) {
      errors.push(`item #${idx}: range bounds must be integers`);
    } else if (item.rangeFrom > item.rangeTo) {
      errors.push(`item #${idx}: rangeFrom ${item.rangeFrom} > rangeTo ${item.rangeTo}`);
    } else if (item.rangeFrom < 0 || item.rangeTo >= TICKET_SPACE) {
      errors.push(`item #${idx}: range must lie within [0, ${TICKET_SPACE - 1}]`);
    }
  }
  if (errors.length > 0) return { valid: false, errors };

  const sorted = [...items].sort((a, b) => a.rangeFrom - b.rangeFrom);
  let cursor = 0;
  for (const item of sorted) {
    if (item.rangeFrom > cursor) {
      errors.push(`gap in ticket ranges: [${cursor}, ${item.rangeFrom - 1}] is not covered`);
    } else if (item.rangeFrom < cursor) {
      errors.push(
        `overlap in ticket ranges at ${item.rangeFrom} (previous range ends at ${cursor - 1})`,
      );
    }
    cursor = item.rangeTo + 1;
  }
  if (cursor !== TICKET_SPACE) {
    errors.push(`ranges cover ${cursor} of ${TICKET_SPACE} tickets`);
  }

  return { valid: errors.length === 0, errors };
}

/** Share of tickets owned by an item: 0..1. */
export function rangeChance(item: TicketRange): number {
  return (item.rangeTo - item.rangeFrom + 1) / TICKET_SPACE;
}

/**
 * RTP of a case: expected return as a fraction of the case price.
 * All prices are integers in minor units.
 */
export function calculateRtp(
  items: readonly (TicketRange & { price: number })[],
  casePrice: number,
): number {
  if (casePrice <= 0) return 0;
  const expected = items.reduce((sum, i) => sum + rangeChance(i) * i.price, 0);
  return expected / casePrice;
}

/**
 * Roll derived from a ready HMAC digest.
 *
 * Modulo bias: 2^32 is not divisible by 1,000,000, so the first 967,296
 * tickets are marginally more likely. The skew is around 0.02%, identical for
 * everyone and far below the granularity of prices, so rejection sampling is
 * not used — keeping the check easy to reproduce by hand matters more.
 */
export function rollFromHmac(hmacHex: string): number {
  return parseInt(hmacHex.slice(0, 8), 16) % TICKET_SPACE;
}
