import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  BATTLE_MAX_ROUNDS,
  BattleMode,
  battleEntryPrice,
  battleStandings,
  createBattleSchema,
  expandBattleRounds,
  resolveBattleWinner,
  totalBattleRounds,
} from './battle.ts';

const CASE_A = '11111111-1111-4111-8111-111111111111';
const CASE_B = '22222222-2222-4222-8222-222222222222';

test('rounds expand in the order the host lined them up', () => {
  const lines = [
    { caseId: CASE_A, count: 2 },
    { caseId: CASE_B, count: 1 },
  ];
  assert.equal(totalBattleRounds(lines), 3);
  assert.deepEqual(expandBattleRounds(lines), [CASE_A, CASE_A, CASE_B]);
});

test('a seat costs the full list price of every round', () => {
  const prices: Record<string, number> = { [CASE_A]: 250_00, [CASE_B]: 1_000_00 };
  const entry = battleEntryPrice(
    [
      { caseId: CASE_A, count: 3 },
      { caseId: CASE_B, count: 1 },
    ],
    (id) => prices[id] ?? 0,
  );
  // Nobody is charged less for playing against somebody else: the pot moves
  // between the players, the site's margin per case is untouched.
  assert.equal(entry, 3 * 250_00 + 1_000_00);
});

test('the biggest total wins a standard battle', () => {
  const standings = battleStandings(
    [
      { slot: 1, drops: [100_00, 50_00] },
      { slot: 2, drops: [400_00, 10_00] },
      { slot: 3, drops: [200_00, 200_00] },
    ],
    BattleMode.STANDARD,
  );

  assert.deepEqual(
    standings.map((s) => s.slot),
    [2, 3, 1],
  );
  assert.deepEqual(
    standings.map((s) => s.rank),
    [1, 2, 3],
  );
  assert.equal(standings[0]!.total, 410_00);
});

test('the smallest total wins a crazy battle', () => {
  const winner = resolveBattleWinner(
    [
      { slot: 1, drops: [100_00, 50_00] },
      { slot: 2, drops: [400_00, 10_00] },
      { slot: 3, drops: [1_00, 2_00] },
    ],
    BattleMode.CRAZY,
  );
  assert.equal(winner.slot, 3);
  assert.equal(winner.total, 3_00);
});

test('a tied total is broken by the single best drop', () => {
  // Both seats are worth 300; the one that landed a 250 beats the one whose
  // best was 150. The rule runs off drops already on the record, so the
  // outcome stays reproducible from the stored rolls.
  const winner = resolveBattleWinner(
    [
      { slot: 1, drops: [150_00, 150_00] },
      { slot: 2, drops: [250_00, 50_00] },
    ],
    BattleMode.STANDARD,
  );
  assert.equal(winner.slot, 2);
  assert.equal(winner.tiebreak, 250_00);
});

test('crazy mode breaks a tie on the single worst drop', () => {
  const winner = resolveBattleWinner(
    [
      { slot: 1, drops: [150_00, 150_00] },
      { slot: 2, drops: [250_00, 50_00] },
    ],
    BattleMode.CRAZY,
  );
  assert.equal(winner.slot, 2);
  assert.equal(winner.tiebreak, 50_00);
});

test('identical drops are settled by the earlier seat', () => {
  const winner = resolveBattleWinner(
    [
      { slot: 2, drops: [100_00] },
      { slot: 1, drops: [100_00] },
    ],
    BattleMode.STANDARD,
  );
  assert.equal(winner.slot, 1);
});

test('a battle with no drops at all still has a winner', () => {
  // Reachable only through a case whose every item is priced at zero, but the
  // settlement path must not throw on it: the items still have to go somewhere.
  const winner = resolveBattleWinner(
    [
      { slot: 1, drops: [] },
      { slot: 2, drops: [] },
    ],
    BattleMode.STANDARD,
  );
  assert.equal(winner.slot, 1);
  assert.equal(winner.total, 0);
});

test('the create schema refuses a case listed twice', () => {
  const parsed = createBattleSchema.safeParse({
    slots: 2,
    cases: [
      { caseId: CASE_A, count: 1 },
      { caseId: CASE_A, count: 1 },
    ],
  });
  assert.equal(parsed.success, false);
});

test('the create schema caps the total number of rounds', () => {
  const tooMany = createBattleSchema.safeParse({
    slots: 2,
    cases: [
      { caseId: CASE_A, count: BATTLE_MAX_ROUNDS },
      { caseId: CASE_B, count: 1 },
    ],
  });
  assert.equal(tooMany.success, false);

  const exact = createBattleSchema.safeParse({
    slots: 2,
    cases: [{ caseId: CASE_A, count: BATTLE_MAX_ROUNDS }],
  });
  assert.equal(exact.success, true);
});

test('the create schema defaults to a two-seat standard battle', () => {
  const parsed = createBattleSchema.parse({ cases: [{ caseId: CASE_A, count: 1 }] });
  assert.equal(parsed.slots, 2);
  assert.equal(parsed.mode, BattleMode.STANDARD);
});
