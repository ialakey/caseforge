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

  CONTRACT_REJECTED: 'CONTRACT_REJECTED',
  CONTRACT_SIZE_INVALID: 'CONTRACT_SIZE_INVALID',
  CONTRACT_POOL_EMPTY: 'CONTRACT_POOL_EMPTY',

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
