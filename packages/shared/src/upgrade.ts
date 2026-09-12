import { TICKET_SPACE } from './tickets.ts';

/**
 * Item upgrade.
 *
 * The player stakes their skin against a pricier one: win and they get the
 * expensive item, lose and they forfeit their own. The chance is not set by
 * hand but derived from the price ratio — otherwise the upgrade becomes a
 * separate game with maths unrelated to the rest of the site's economy.
 */

/**
 * The cut the site keeps on an upgrade.
 *
 * The fair chance is the price ratio: staking an item worth 100 against one
 * worth 1000, the player should win 10% of the time — that makes the expected
 * value equal to the stake. Multiplying by 0.9 gives the site the same 10%
 * margin the cases run on and keeps the upgrade in one economy with them.
 */
export const UPGRADE_RTP = 0.9;

/** Hopeless and near-certain stakes are both rejected. */
export const UPGRADE_MIN_CHANCE = 0.005;
export const UPGRADE_MAX_CHANCE = 0.85;

/**
 * Minimum multiplier.
 *
 * "Upgrading" into an item of the same price is not an improvement but a swap
 * with a fee: the chance would come out at 90% and the player would lose 10%
 * of the value on average for no meaningful gain. Require at least 5% growth.
 */
export const UPGRADE_MIN_MULTIPLIER = 1.05;

export interface UpgradeOdds {
  /** Win probability, 0..1. */
  chance: number;
  /** How many times more expensive the target is. */
  multiplier: number;
  /** Roll threshold: a win when roll < winThreshold. */
  winThreshold: number;
}

export interface UpgradeRejection {
  ok: false;
  reason: string;
}

export type UpgradeOddsResult = ({ ok: true } & UpgradeOdds) | UpgradeRejection;

/**
 * Upgrade odds from prices in minor units.
 *
 * The threshold is expressed in the same tickets as a case opening, so the
 * upgrade is verified exactly the same way: roll = HMAC(serverSeed,
 * clientSeed:nonce), a win when roll < winThreshold.
 */
export function calculateUpgradeOdds(sourceValue: number, targetValue: number): UpgradeOddsResult {
  if (!Number.isFinite(sourceValue) || sourceValue <= 0) {
    return { ok: false, reason: 'The staked item has no price' };
  }
  if (!Number.isFinite(targetValue) || targetValue <= 0) {
    return { ok: false, reason: 'The target item has no price' };
  }

  const multiplier = targetValue / sourceValue;
  if (multiplier < UPGRADE_MIN_MULTIPLIER) {
    return {
      ok: false,
      reason:
        `The target must be at least ${UPGRADE_MIN_MULTIPLIER}x pricier. ` +
        `The current multiplier is ${multiplier.toFixed(2)}.`,
    };
  }

  const fair = sourceValue / targetValue;
  const raw = fair * UPGRADE_RTP;

  // Check the chance before clamping, not after. Clamp it into range first
  // and the comparison always passes — the minimum has already been
  // substituted by the clamp, and an excessive price gap goes unnoticed.
  if (raw < UPGRADE_MIN_CHANCE) {
    return {
      ok: false,
      reason: `Price gap too wide: the chance falls below ${(UPGRADE_MIN_CHANCE * 100).toFixed(1)}%.`,
    };
  }

  // The upper clamp stays: a chance above the cap is a near-certain swap that
  // serves neither the player nor the site.
  const chance = Math.min(UPGRADE_MAX_CHANCE, raw);

  return {
    ok: true,
    chance,
    multiplier,
    // Round down: rounding error must not hand the player an extra ticket,
    // nor take one from the site.
    winThreshold: Math.floor(chance * TICKET_SPACE),
  };
}

/** Whether the roll wins. One function for the server and the verification page. */
export function isUpgradeWin(roll: number, winThreshold: number): boolean {
  return roll < winThreshold;
}

/**
 * Price range of targets an upgrade is possible against at all.
 * Used to keep unreachable options out of the player's list.
 */
export function upgradeTargetPriceRange(sourceValue: number): { min: number; max: number } {
  return {
    min: Math.ceil(sourceValue * UPGRADE_MIN_MULTIPLIER),
    // Below the minimum chance the upgrade is refused; hence the price cap.
    max: Math.floor((sourceValue * UPGRADE_RTP) / UPGRADE_MIN_CHANCE),
  };
}
