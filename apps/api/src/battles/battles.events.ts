import type { BattleSummary } from '@caseforge/shared';

/** Redis channel the API instances announce battle changes on. */
export const BATTLES_CHANNEL = 'battles:events';

/**
 * What travels on that channel.
 *
 * Two kinds, because a battle changes two different things: the lobby everybody
 * is looking at, and — when a battle is refunded — one player's balance. The
 * second is addressed to a personal room, so it cannot simply be broadcast
 * with the first.
 */
export type BattleEvent =
  { kind: 'battle'; battle: BattleSummary } | { kind: 'balance'; userId: string; balance: number };
