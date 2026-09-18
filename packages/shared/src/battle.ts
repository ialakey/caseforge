import { z } from 'zod';
import type { CaseItemView, CaseView } from './types.ts';

/**
 * Case battles.
 *
 * Several players buy the same list of cases and open it side by side; the
 * items everybody dropped go to one of them. Nothing about the roll is new —
 * every drop in a battle is an ordinary case opening, rolled from the opening
 * player's own seed pair and their own nonce, so a battle drop is verified with
 * exactly the same arithmetic as a solo one. What a battle adds is only the
 * question of who keeps the items, and that is a comparison of sums rather than
 * a second source of randomness.
 *
 * The consequence worth stating: the site's margin does not change. Each player
 * pays the full list price, so the expected return of a battle is the weighted
 * RTP of the cases in it, and the pot merely moves between the players.
 */

export const BattleStatus = {
  /** Created and paid for by the host, waiting for the remaining seats. */
  WAITING: 'WAITING',
  /** Full; the rounds are being rolled. A very short state. */
  RUNNING: 'RUNNING',
  FINISHED: 'FINISHED',
  /** Abandoned before it filled — every seat is refunded. */
  CANCELLED: 'CANCELLED',
} as const;
export type BattleStatus = (typeof BattleStatus)[keyof typeof BattleStatus];

export const BattleMode = {
  /** The biggest total takes everything. */
  STANDARD: 'STANDARD',
  /** The smallest total takes everything — the same cases, the opposite goal. */
  CRAZY: 'CRAZY',
} as const;
export type BattleMode = (typeof BattleMode)[keyof typeof BattleMode];

export const BATTLE_MODES = [BattleMode.STANDARD, BattleMode.CRAZY] as const;

export const BATTLE_MIN_PLAYERS = 2;
export const BATTLE_MAX_PLAYERS = 4;
export const BATTLE_PLAYER_PRESETS = [2, 3, 4] as const;

/**
 * Rounds per battle, and how many distinct cases may be lined up.
 *
 * Thirty rounds across four players is a hundred and twenty openings settled in
 * one transaction, which is already the largest write the site makes. The cap on
 * distinct cases is a separate limit because the interface sends the contents of
 * every case in the battle: ten lines is a payload a phone can still load.
 */
export const BATTLE_MAX_ROUNDS = 30;
export const BATTLE_MAX_CASE_LINES = 10;

export const battleCaseLineSchema = z.object({
  caseId: z.string().uuid(),
  count: z.number().int().min(1).max(BATTLE_MAX_ROUNDS),
});

export const createBattleSchema = z.object({
  mode: z.enum(BATTLE_MODES).default(BattleMode.STANDARD),
  slots: z.number().int().min(BATTLE_MIN_PLAYERS).max(BATTLE_MAX_PLAYERS).default(2),
  cases: z
    .array(battleCaseLineSchema)
    .min(1)
    .max(BATTLE_MAX_CASE_LINES)
    // A repeated case id is not a second line but the same line twice, and the
    // two would disagree about how many rounds it is worth.
    .refine(
      (lines) => new Set(lines.map((l) => l.caseId)).size === lines.length,
      'a case may only appear once; use its count instead',
    )
    .refine(
      (lines) => totalBattleRounds(lines) <= BATTLE_MAX_ROUNDS,
      `a battle is capped at ${BATTLE_MAX_ROUNDS} rounds`,
    ),
});
export type CreateBattleInput = z.infer<typeof createBattleSchema>;

export interface BattleCaseLine {
  caseId: string;
  count: number;
}

export function totalBattleRounds(lines: readonly BattleCaseLine[]): number {
  return lines.reduce((sum, line) => sum + line.count, 0);
}

/**
 * The rounds in play order: one case per round, each line expanded in place.
 *
 * The order is the host's, kept as submitted rather than sorted. It is visible
 * in the lobby before anyone pays, and a battle whose rounds were silently
 * reordered would be a different battle from the one people joined.
 */
export function expandBattleRounds(lines: readonly BattleCaseLine[]): string[] {
  const order: string[] = [];
  for (const line of lines) {
    for (let i = 0; i < line.count; i++) order.push(line.caseId);
  }
  return order;
}

/**
 * What one seat costs: the full list price of every round.
 *
 * Every player pays it, so a battle collects `slots` times this sum. Nobody
 * gets a discount for playing against somebody else — the pot is redistributed
 * between the players, not funded by the site.
 */
export function battleEntryPrice(
  lines: readonly BattleCaseLine[],
  priceOf: (caseId: string) => number,
): number {
  return lines.reduce((sum, line) => sum + priceOf(line.caseId) * line.count, 0);
}

export interface BattleTally {
  slot: number;
  /** Every item this seat dropped, priced as it was at the moment it dropped. */
  drops: readonly number[];
}

export interface BattleStanding {
  slot: number;
  total: number;
  /**
   * The single drop the tiebreak turns on: the best one in STANDARD, the worst
   * in CRAZY. Kept on the standing so an interface can explain a tie rather
   * than leaving the loser to wonder.
   */
  tiebreak: number;
  /** 1 for the winner. */
  rank: number;
}

/**
 * The final table, winner first.
 *
 * Ties are real: two seats opening the same cases can land on the same total,
 * and with cheap cases it happens often enough to need a rule rather than a
 * coin flip. The rule is sudden death on the single best drop — in CRAZY, on
 * the single worst — and, if even that matches, the earlier seat wins. Both
 * steps are functions of drops that are already on the record, so the outcome
 * stays reproducible from the stored rolls; a fresh random draw would not be.
 */
export function battleStandings(
  tallies: readonly BattleTally[],
  mode: BattleMode,
): BattleStanding[] {
  const lowWins = mode === BattleMode.CRAZY;

  const scored = tallies.map((tally) => ({
    slot: tally.slot,
    total: tally.drops.reduce((sum, price) => sum + price, 0),
    tiebreak:
      tally.drops.length === 0 ? 0 : lowWins ? Math.min(...tally.drops) : Math.max(...tally.drops),
  }));

  scored.sort((a, b) => {
    const byTotal = lowWins ? a.total - b.total : b.total - a.total;
    if (byTotal !== 0) return byTotal;
    const byTiebreak = lowWins ? a.tiebreak - b.tiebreak : b.tiebreak - a.tiebreak;
    if (byTiebreak !== 0) return byTiebreak;
    return a.slot - b.slot;
  });

  return scored.map((score, index) => ({ ...score, rank: index + 1 }));
}

/** The winning seat. Throws on an empty battle, which cannot be settled at all. */
export function resolveBattleWinner(
  tallies: readonly BattleTally[],
  mode: BattleMode,
): BattleStanding {
  const standings = battleStandings(tallies, mode);
  const winner = standings[0];
  if (!winner) throw new Error('a battle with no players cannot be settled');
  return winner;
}

/** A case in a battle, with its contents so the reel can be drawn from them. */
export interface BattleCaseView {
  count: number;
  case: CaseView;
}

export interface BattlePlayerView {
  slot: number;
  userId: string;
  username: string;
  avatarUrl: string | null;
  /** Running total once the battle has been played; 0 while it waits. */
  totalValue: number;
  isWinner: boolean;
}

export interface BattleDropView {
  /** 1-based, matching the order in `BattleView.order`. */
  round: number;
  slot: number;
  openingId: string;
  item: CaseItemView;
  roll: number;
  nonce: number;
}

/** A battle as the lobby lists it: no case contents, so the list stays small. */
export interface BattleSummary {
  id: string;
  mode: BattleMode;
  status: BattleStatus;
  slots: number;
  filledSlots: number;
  rounds: number;
  entryPrice: number;
  totalValue: number | null;
  winnerSlot: number | null;
  cases: Array<{
    caseId: string;
    slug: string;
    name: string;
    nameEn: string | null;
    imageUrl: string | null;
    price: number;
    count: number;
  }>;
  players: BattlePlayerView[];
  createdAt: string;
  finishedAt: string | null;
}

/** Everything needed to play a battle back, reel by reel. */
export interface BattleView extends Omit<BattleSummary, 'cases'> {
  cases: BattleCaseView[];
  /** The case id opened in each round, in play order. */
  order: string[];
  drops: BattleDropView[];
  startedAt: string | null;
}

/** What creating or joining a battle returns: the battle, and the new balance. */
export interface BattleActionResult {
  battle: BattleView;
  balanceAfter: number;
}
