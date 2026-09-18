/**
 * Machine-readable codes for errors the player is meant to see.
 *
 * The API answers with both a `code` and an English `message`. The interface
 * translates the code and falls back to the message when it meets a code it
 * does not know — that way a new server-side error is still readable instead
 * of showing an empty string, and adding a translation later needs no API
 * change.
 */
export const ErrorCode = {
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  RATE_LIMITED: 'RATE_LIMITED',
  CASE_UNAVAILABLE: 'CASE_UNAVAILABLE',
  CASE_EMPTY: 'CASE_EMPTY',
  /** A free case whose top-up requirement the player has not met. */
  FREE_CASE_DEPOSIT_REQUIRED: 'FREE_CASE_DEPOSIT_REQUIRED',
  /** A free case already opened its allowance of times in the last 24 hours. */
  FREE_CASE_COOLDOWN: 'FREE_CASE_COOLDOWN',
  /** Depositing skins is switched off. */
  ITEM_DEPOSITS_DISABLED: 'ITEM_DEPOSITS_DISABLED',
  /** Steam would not show the player's inventory — private, or rate-limited. */
  INVENTORY_UNAVAILABLE: 'INVENTORY_UNAVAILABLE',
  /** The selection is worth less than the minimum, or holds nothing depositable. */
  DEPOSIT_TOO_SMALL: 'DEPOSIT_TOO_SMALL',
  /** A request is already in flight; one at a time keeps the asset ids honest. */
  DEPOSIT_IN_PROGRESS: 'DEPOSIT_IN_PROGRESS',
  /** No farm bot is online and has room for the items. */
  NO_BOT_AVAILABLE: 'NO_BOT_AVAILABLE',
  /** The giveaway is not open for entries. */
  GIVEAWAY_CLOSED: 'GIVEAWAY_CLOSED',
  /** Not enough topped up since the giveaway opened. */
  GIVEAWAY_DEPOSIT_REQUIRED: 'GIVEAWAY_DEPOSIT_REQUIRED',
  /** Already entered; one entry per player is the whole point. */
  GIVEAWAY_ALREADY_ENTERED: 'GIVEAWAY_ALREADY_ENTERED',
  /** Identity checks are not in use on this deployment. */
  KYC_DISABLED: 'KYC_DISABLED',
  /** The date of birth given is under eighteen. */
  KYC_UNDERAGE: 'KYC_UNDERAGE',
  /** A withdrawal past the threshold without a verified identity. */
  KYC_REQUIRED: 'KYC_REQUIRED',
  BATCH_SIZE_INVALID: 'BATCH_SIZE_INVALID',
  ACCOUNT_BANNED: 'ACCOUNT_BANNED',
  NO_ACTIVE_SEED: 'NO_ACTIVE_SEED',

  ITEM_UNAVAILABLE: 'ITEM_UNAVAILABLE',
  ITEM_ALREADY_SOLD: 'ITEM_ALREADY_SOLD',
  ITEMS_CHANGED: 'ITEMS_CHANGED',

  TRADE_URL_INVALID: 'TRADE_URL_INVALID',
  TRADE_URL_FOREIGN: 'TRADE_URL_FOREIGN',
  TRADE_URL_MISSING: 'TRADE_URL_MISSING',

  WITHDRAWAL_NOT_CANCELLABLE: 'WITHDRAWAL_NOT_CANCELLABLE',

  UPGRADE_REJECTED: 'UPGRADE_REJECTED',
  UPGRADE_TARGET_MISSING: 'UPGRADE_TARGET_MISSING',

  MAINTENANCE: 'MAINTENANCE',
  BONUS_ON_COOLDOWN: 'BONUS_ON_COOLDOWN',
  BONUS_DISABLED: 'BONUS_DISABLED',
  PROMO_INVALID: 'PROMO_INVALID',

  CONTRACT_REJECTED: 'CONTRACT_REJECTED',
  CONTRACT_SIZE_INVALID: 'CONTRACT_SIZE_INVALID',
  CONTRACT_POOL_EMPTY: 'CONTRACT_POOL_EMPTY',

  BATTLE_DISABLED: 'BATTLE_DISABLED',
  BATTLE_UNAVAILABLE: 'BATTLE_UNAVAILABLE',
  BATTLE_FULL: 'BATTLE_FULL',
  BATTLE_ALREADY_JOINED: 'BATTLE_ALREADY_JOINED',
  BATTLE_NOT_CANCELLABLE: 'BATTLE_NOT_CANCELLABLE',
  BATTLE_SIZE_INVALID: 'BATTLE_SIZE_INVALID',

  REFERRAL_DISABLED: 'REFERRAL_DISABLED',
  REFERRAL_CODE_INVALID: 'REFERRAL_CODE_INVALID',
  REFERRAL_CODE_TAKEN: 'REFERRAL_CODE_TAKEN',
  REFERRAL_SELF: 'REFERRAL_SELF',
  REFERRAL_ALREADY_BOUND: 'REFERRAL_ALREADY_BOUND',
  REFERRAL_ACCOUNT_ACTIVE: 'REFERRAL_ACCOUNT_ACTIVE',
  REFERRAL_NOTHING_TO_CLAIM: 'REFERRAL_NOTHING_TO_CLAIM',
  REFERRAL_BELOW_MIN_CLAIM: 'REFERRAL_BELOW_MIN_CLAIM',

  DEPOSITS_DISABLED: 'DEPOSITS_DISABLED',

  VALIDATION_FAILED: 'VALIDATION_FAILED',
  STEAM_RATE_LIMITED: 'STEAM_RATE_LIMITED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Shape of an error body returned by the API. */
export interface ApiErrorBody {
  code?: ErrorCode | string;
  message: string;
  /** Extra detail some errors carry, e.g. failing validation issues. */
  issues?: string[];
}
