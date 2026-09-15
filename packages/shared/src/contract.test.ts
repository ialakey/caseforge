import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { TICKET_SPACE, validateTicketRanges } from './tickets.ts';
import {
  CONTRACT_MAX_ITEMS,
  CONTRACT_MAX_MULTIPLIER,
  CONTRACT_MIN_ITEMS,
  CONTRACT_MIN_MULTIPLIER,
  CONTRACT_POOL_SIZE,
  CONTRACT_RTP,
  buildContractPool,
  contractRewardPriceRange,
  isValidContractSize,
  pickContractOutcome,
  type ContractCandidate,
} from './contract.ts';

/**
 * A stand-in catalogue: prices spread geometrically, the way a real skin
 * catalogue is — many cheap items, a few very expensive ones. The span is
 * deliberately as wide as the real one, from a one-rouble skin to a knife: a
 * catalogue whose ceiling sits below 5x the stake squeezes the reward band and
 * the pool would no longer exercise the case these tests are about.
 */
function catalogue(count = 600, from = 1_00, to = 1_000_000_00): ContractCandidate[] {
  const step = Math.log(to / from) / (count - 1);
  return Array.from({ length: count }, (_, i) => ({
    itemId: `item-${i}`,
    price: Math.round(from * Math.exp(i * step)),
  }));
}

test('the expected value of a contract equals the stake times RTP', () => {
  // This is the whole point of the solver: whatever the pool looks like, the
  // player gets CONTRACT_RTP of what they staked back on average — the same
  // margin as the cases and the upgrade.
  for (const stake of [500_00, 1_000_00, 4_200_00, 25_000_00]) {
    const pool = buildContractPool(catalogue(), stake);
    assert.equal(pool.ok, true, `stake ${stake}`);
    if (!pool.ok) continue;
    assert.ok(
      Math.abs(pool.rtp - CONTRACT_RTP) < 1e-4,
      `stake ${stake}: rtp ${pool.rtp.toFixed(6)}`,
    );
  }
});

test('the ticket ranges tile the space with no gap and no overlap', () => {
  // The same invariant a case has to satisfy, checked with the same function:
  // a hole in the space is a roll that matches no outcome.
  const pool = buildContractPool(catalogue(), 4_200_00);
  assert.equal(pool.ok, true);
  if (!pool.ok) return;

  const validation = validateTicketRanges(pool.outcomes);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.valid, true);
});

test('every outcome on the reel can actually be won', () => {
  // An outcome owning no ticket would be drawn on the reel and be unreachable.
  for (const stake of [300_00, 2_000_00, 50_000_00]) {
    const pool = buildContractPool(catalogue(), stake);
    assert.equal(pool.ok, true);
    if (!pool.ok) continue;
    for (const outcome of pool.outcomes) {
      assert.ok(outcome.chance > 0, `${outcome.itemId} owns no tickets`);
      assert.ok(outcome.rangeTo >= outcome.rangeFrom);
    }
  }
});

test('the rewards stay inside the advertised band', () => {
  const stake = 4_200_00;
  const pool = buildContractPool(catalogue(), stake);
  assert.equal(pool.ok, true);
  if (!pool.ok) return;

  assert.equal(pool.rewardRange.min, Math.ceil(stake * CONTRACT_MIN_MULTIPLIER));
  assert.equal(pool.rewardRange.max, Math.floor(stake * CONTRACT_MAX_MULTIPLIER));
  for (const outcome of pool.outcomes) {
    assert.ok(
      outcome.price >= pool.rewardRange.min && outcome.price <= pool.rewardRange.max,
      `${outcome.price} outside [${pool.rewardRange.min}, ${pool.rewardRange.max}]`,
    );
  }
});

test('a contract can pay out more than it cost, and usually does not', () => {
  // A contract nobody can ever win at is not a game; a contract usually won is
  // not a margin. Both halves matter, so both are asserted.
  const stake = 4_200_00;
  const pool = buildContractPool(catalogue(), stake);
  assert.equal(pool.ok, true);
  if (!pool.ok) return;

  const profitable = pool.outcomes.filter((o) => o.price > stake);
  assert.ok(profitable.length > 0, 'no outcome beats the stake');

  const chanceOfProfit = profitable.reduce((sum, o) => sum + o.chance, 0);
  assert.ok(chanceOfProfit < 0.5, `profit chance ${chanceOfProfit}`);
  assert.ok(chanceOfProfit > 0, 'profit is unreachable');
});

test('cheap outcomes are the likely ones', () => {
  // The tilt has to lean on the cheap end — if the pool came out uniform the
  // solver did nothing and the RTP would be an accident of the catalogue.
  const pool = buildContractPool(catalogue(), 4_200_00);
  assert.equal(pool.ok, true);
  if (!pool.ok) return;

  const sorted = [...pool.outcomes].sort((a, b) => a.price - b.price);
  assert.ok(
    sorted[0]!.chance > sorted[sorted.length - 1]!.chance,
    'the cheapest outcome is not the most likely',
  );
});

test('the pool is capped so the reel stays readable', () => {
  const pool = buildContractPool(catalogue(2000), 4_200_00);
  assert.equal(pool.ok, true);
  if (!pool.ok) return;
  assert.ok(pool.outcomes.length <= CONTRACT_POOL_SIZE, `${pool.outcomes.length} outcomes`);
});

test('the outcome table does not depend on the order the candidates arrive in', () => {
  // The table is stored and checked afterwards, so it has to be a function of
  // the catalogue and the stake alone.
  const items = catalogue();
  const shuffled = [...items].reverse();

  const a = buildContractPool(items, 4_200_00);
  const b = buildContractPool(shuffled, 4_200_00);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.deepEqual(a.outcomes, b.outcomes);
});

test('a thin catalogue is refused rather than played on bad odds', () => {
  const thin = [
    { itemId: 'a', price: 100_00 },
    { itemId: 'b', price: 110_00 },
    { itemId: 'c', price: 120_00 },
  ];
  const pool = buildContractPool(thin, 1_000_00);
  assert.equal(pool.ok, false);
});

test('a catalogue with nothing above the payout is refused', () => {
  // Every item sits below 0.9x the stake: no tilt can lift the expected value
  // to the target, and quietly paying less would be a hidden margin change.
  const stake = 1_000_00;
  const cheapOnly = Array.from({ length: 40 }, (_, i) => ({
    itemId: `c-${i}`,
    price: 100_00 + i * 100,
  }));
  const pool = buildContractPool(cheapOnly, stake);
  assert.equal(pool.ok, false);
  if (pool.ok) return;
  assert.match(pool.reason, /balanced/);
});

test('a stake with no price is refused, not treated as free', () => {
  assert.equal(buildContractPool(catalogue(), 0).ok, false);
  assert.equal(buildContractPool(catalogue(), -1).ok, false);
  assert.equal(buildContractPool(catalogue(), Number.NaN).ok, false);
});

test('a duplicate item cannot occupy two outcomes', () => {
  const duplicated = catalogue().flatMap((c) => [c, { ...c }]);
  const pool = buildContractPool(duplicated, 4_200_00);
  assert.equal(pool.ok, true);
  if (!pool.ok) return;
  const ids = pool.outcomes.map((o) => o.itemId);
  assert.equal(new Set(ids).size, ids.length);
});

test('a sweep of the ticket space returns the advertised RTP', () => {
  // The end-to-end check: roll every ticket, pay out what the table says, and
  // compare the takings with the margin the site thinks it is charging.
  const stake = 4_200_00;
  const pool = buildContractPool(catalogue(), stake);
  assert.equal(pool.ok, true);
  if (!pool.ok) return;

  const samples = 100_000;
  let paid = 0;
  for (let i = 0; i < samples; i++) {
    const roll = Math.floor((i * TICKET_SPACE) / samples);
    paid += pickContractOutcome(pool.outcomes, roll).price;
  }
  const realised = paid / samples / stake;
  assert.ok(Math.abs(realised - CONTRACT_RTP) < 0.01, `realised RTP ${realised.toFixed(4)}`);
});

test('the reward band agrees with the pool it produces', () => {
  const stake = 800_00;
  const { min, max } = contractRewardPriceRange(stake);
  assert.equal(min, 80_00);
  assert.equal(max, 4_000_00);
});

test('only a legal number of items makes a contract', () => {
  assert.equal(isValidContractSize(CONTRACT_MIN_ITEMS), true);
  assert.equal(isValidContractSize(CONTRACT_MAX_ITEMS), true);
  assert.equal(isValidContractSize(CONTRACT_MIN_ITEMS - 1), false);
  assert.equal(isValidContractSize(CONTRACT_MAX_ITEMS + 1), false);
  assert.equal(isValidContractSize(3.5), false);
});
