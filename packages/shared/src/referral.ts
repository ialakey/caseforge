import { z } from 'zod';

/**
 * Referrals.
 *
 * A player hands out a link, whoever follows it is bound to them on sign-up,
 * and a share of what that person then spends is credited to the inviter. The
 * share accrues into a pending pot rather than landing on the balance as it is
 * earned, and the inviter presses a button to move it across once it is worth
 * moving. That is not a UI flourish: a commission on every opening would
 * otherwise be a ledger entry per opening per inviter, and the ledger is the
 * thing the nightly reconciliation walks. Accruing into `ReferralEarning` rows
 * and paying out in one transaction keeps the money movements proportional to
 * the number of payouts instead of to the number of drops.
 *
 * The binding is permanent and one-way: one inviter per player, set once, never
 * edited. A referral that could be re-pointed later is a support ticket asking
 * to re-point it.
 */

/**
 * Generated codes avoid the characters people mistype when reading a code off
 * a screen — no O/0, no I/1/l. A vanity code chosen by the player is checked
 * against a laxer rule below, because there the player is copying their own
 * spelling rather than transcribing ours.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const REFERRAL_CODE_LENGTH = 8;

/**
 * A code from a caller-supplied byte source.
 *
 * The bytes come from the server's CSPRNG; this module stays free of
 * `node:crypto` so it can also be bundled for the browser. The modulo skew
 * across a 31-character alphabet is irrelevant — this is an identifier, not a
 * roll, and nothing about fairness depends on it.
 */
export function referralCodeFromBytes(bytes: Uint8Array): string {
  if (bytes.length < REFERRAL_CODE_LENGTH) {
    throw new Error(`need at least ${REFERRAL_CODE_LENGTH} bytes for a referral code`);
  }
  let code = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return code;
}

/** Codes are stored upper-cased and matched upper-cased, as promo codes are. */
export function normaliseReferralCode(code: string): string {
  return code.trim().toUpperCase();
}

export const REFERRAL_CODE_REGEX = /^[A-Z0-9][A-Z0-9_-]{2,15}$/;

export const referralCodeSchema = z
  .string()
  .trim()
  .transform(normaliseReferralCode)
  .refine((c) => REFERRAL_CODE_REGEX.test(c), 'code: 3 to 16 characters, letters, digits, - and _');

/** The query parameter an invite link carries. */
export const REFERRAL_QUERY_PARAM = 'ref';

export const claimReferralSchema = z.object({ code: referralCodeSchema });
export const setReferralCodeSchema = z.object({ code: referralCodeSchema });

/** What a commission is charged on. */
export const ReferralEarningKind = {
  /** A share of a top-up the invited player made. */
  DEPOSIT: 'DEPOSIT',
  /** A share of what they wagered — the list price of the cases they opened. */
  WAGER: 'WAGER',
} as const;
export type ReferralEarningKind = (typeof ReferralEarningKind)[keyof typeof ReferralEarningKind];

/**
 * The commission on an amount, in minor units.
 *
 * Rounded down, so the rounding error stays with the site rather than paying
 * out a fraction of a kopeck on every cheap case. A one-kopeck wager at 100 bps
 * therefore earns nothing at all, which is correct: the alternative is a
 * commission worth more than the sum it was charged on.
 */
export function referralCommission(amount: number, rateBps: number): number {
  if (amount <= 0 || rateBps <= 0) return 0;
  return Math.floor((amount * rateBps) / 10_000);
}

export const ReferralRejection = {
  DISABLED: 'DISABLED',
  NOT_FOUND: 'NOT_FOUND',
  /** The player typed their own code. */
  SELF: 'SELF',
  ALREADY_BOUND: 'ALREADY_BOUND',
  /** The account has already played or paid, so it is nobody's new recruit. */
  ACCOUNT_ACTIVE: 'ACCOUNT_ACTIVE',
} as const;
export type ReferralRejection = (typeof ReferralRejection)[keyof typeof ReferralRejection];

export type ReferralBindingCheck = { ok: true } | { ok: false; reason: ReferralRejection };

/**
 * Whether a code may be bound to this account.
 *
 * The interesting rule is the last one. The binding cannot be made during the
 * Steam round trip — the invite is known to the browser, and the browser only
 * gets a turn once the redirect is over — so it is made by a call that arrives
 * moments after sign-in. That leaves the endpoint open to being called at any
 * later point, which is why a code is refused once the account has any activity
 * on it: a player who has already opened a case or topped up is not somebody's
 * fresh recruit, and allowing the claim would let an established account be
 * attributed to whoever asked last.
 */
export function checkReferralBinding(input: {
  enabled: boolean;
  /** The code resolved to a user at all. */
  found: boolean;
  isSelf: boolean;
  alreadyBound: boolean;
  /** The account has opened a case, run a battle or moved money. */
  accountActive: boolean;
}): ReferralBindingCheck {
  if (!input.enabled) return { ok: false, reason: ReferralRejection.DISABLED };
  if (!input.found) return { ok: false, reason: ReferralRejection.NOT_FOUND };
  if (input.isSelf) return { ok: false, reason: ReferralRejection.SELF };
  if (input.alreadyBound) return { ok: false, reason: ReferralRejection.ALREADY_BOUND };
  if (input.accountActive) return { ok: false, reason: ReferralRejection.ACCOUNT_ACTIVE };
  return { ok: true };
}

export type ReferralClaimCheck =
  { ok: true; amount: number } | { ok: false; reason: 'NOTHING' | 'BELOW_MIN'; required: number };

/**
 * Whether the pending pot may be paid out.
 *
 * The floor exists so a payout is worth the ledger entry it costs; it is a
 * setting, so an operator can drop it to zero and let anything be claimed.
 */
export function checkReferralClaim(pending: number, minClaim: number): ReferralClaimCheck {
  if (pending <= 0) return { ok: false, reason: 'NOTHING', required: minClaim };
  if (pending < minClaim) return { ok: false, reason: 'BELOW_MIN', required: minClaim };
  return { ok: true, amount: pending };
}

export interface ReferralEarningView {
  id: string;
  kind: ReferralEarningKind;
  /** The invited player the commission came from. */
  username: string;
  sourceAmount: number;
  rateBps: number;
  amount: number;
  claimedAt: string | null;
  createdAt: string;
}

export interface ReferralInviteeView {
  userId: string;
  username: string;
  avatarUrl: string | null;
  joinedAt: string;
  /** What this player has earned the inviter so far, claimed or not. */
  earned: number;
}

/** The referral page in one response. */
export interface ReferralSummary {
  enabled: boolean;
  code: string;
  /** The live commission rates, so the page quotes what the server will pay. */
  depositBps: number;
  wagerBps: number;
  minClaim: number;

  invited: number;
  /** Accrued and not yet paid out. */
  pending: number;
  /** Paid out to the balance so far. */
  claimed: number;

  /** Who invited this player, when somebody did. */
  invitedBy: { username: string; avatarUrl: string | null } | null;

  invitees: ReferralInviteeView[];
  earnings: ReferralEarningView[];
}

export interface ReferralClaimResult {
  amount: number;
  balanceAfter: number;
}
