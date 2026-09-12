import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { TICKET_SPACE } from './tickets.ts';
import {
  UPGRADE_MAX_CHANCE,
  UPGRADE_MIN_CHANCE,
  UPGRADE_RTP,
  calculateUpgradeOdds,
  isUpgradeWin,
  upgradeTargetPriceRange,
} from './upgrade.ts';

test('the chance equals the price ratio net of the site margin', () => {
  // 100 against 1000: fair chance 10%, with a 10% margin -> 9%.
  const odds = calculateUpgradeOdds(100_00, 1000_00);
  assert.equal(odds.ok, true);
  if (!odds.ok) return;
  assert.ok(Math.abs(odds.chance - 0.09) < 1e-9, `chance ${odds.chance}`);
  assert.ok(Math.abs(odds.multiplier - 10) < 1e-9);
});

test('the expected value of an upgrade equals the stake times RTP', () => {
  // This is the point of the formula: on average the player gets UPGRADE_RTP
  // of what they staked back, exactly as with cases.
  for (const [src, dst] of [
    [500, 2_000],
    [1_000, 15_000],
    [30_000, 100_000],
  ]) {
    const odds = calculateUpgradeOdds(src, dst);
    assert.equal(odds.ok, true);
    if (!odds.ok) continue;
    const expectedReturn = odds.chance * dst;
    assert.ok(
      Math.abs(expectedReturn / src - UPGRADE_RTP) < 1e-9,
      `${src}->${dst}: return ${(expectedReturn / src).toFixed(4)}`,
    );
  }
});

test('the win threshold is expressed in the same tickets as a case opening', () => {
  const odds = calculateUpgradeOdds(100_00, 1000_00);
  assert.equal(odds.ok, true);
  if (!odds.ok) return;
  assert.equal(odds.winThreshold, Math.floor(0.09 * TICKET_SPACE));
  assert.ok(odds.winThreshold < TICKET_SPACE);
});

test('a target that is too close is rejected', () => {
  // Swapping an item for one of the same price is a fee, not an upgrade.
  const odds = calculateUpgradeOdds(1000_00, 1020_00);
  assert.equal(odds.ok, false);
  if (odds.ok) return;
  assert.match(odds.reason, /at least/);
});

test('a target cheaper than the stake is rejected', () => {
  const odds = calculateUpgradeOdds(1000_00, 500_00);
  assert.equal(odds.ok, false);
});

test('an unreachable price gap is rejected', () => {
  // A one-rouble item against a million-rouble knife: below the minimum chance.
  const odds = calculateUpgradeOdds(1_00, 10_000_000_00);
  assert.equal(odds.ok, false);
  if (odds.ok) return;
  assert.match(odds.reason, /Price gap/);
});

test('the chance never exceeds the cap', () => {
  const odds = calculateUpgradeOdds(1000_00, 1060_00);
  assert.equal(odds.ok, true);
  if (!odds.ok) return;
  assert.ok(odds.chance <= UPGRADE_MAX_CHANCE, `chance ${odds.chance}`);
});

test('an item without a price is rejected, not treated as free', () => {
  assert.equal(calculateUpgradeOdds(0, 1000).ok, false);
  assert.equal(calculateUpgradeOdds(1000, 0).ok, false);
  assert.equal(calculateUpgradeOdds(Number.NaN, 1000).ok, false);
});

test('a win is decided by the threshold', () => {
  assert.equal(isUpgradeWin(0, 90_000), true);
  assert.equal(isUpgradeWin(89_999, 90_000), true);
  // The boundary does not win: otherwise the threshold would grant one extra ticket.
  assert.equal(isUpgradeWin(90_000, 90_000), false);
  assert.equal(isUpgradeWin(999_999, 90_000), false);
});

test('the win rate over a sweep matches the advertised chance', () => {
  const odds = calculateUpgradeOdds(100_00, 400_00);
  assert.equal(odds.ok, true);
  if (!odds.ok) return;

  let wins = 0;
  const runs = 200_000;
  for (let roll = 0; roll < runs; roll++) {
    // Rolls are uniform across the ticket space, so sweep it uniformly.
    const scaled = Math.floor((roll * TICKET_SPACE) / runs);
    if (isUpgradeWin(scaled, odds.winThreshold)) wins += 1;
  }
  assert.ok(
    Math.abs(wins / runs - odds.chance) < 0.001,
    `rate ${wins / runs} against the advertised ${odds.chance}`,
  );
});

test('the available target range agrees with the odds calculation', () => {
  const source = 500_00;
  const { min, max } = upgradeTargetPriceRange(source);

  assert.equal(calculateUpgradeOdds(source, min).ok, true, 'lower bound is reachable');
  assert.equal(calculateUpgradeOdds(source, max).ok, true, 'upper bound is reachable');
  assert.equal(calculateUpgradeOdds(source, min - 1).ok, false, 'below the bound is unreachable');
  assert.equal(calculateUpgradeOdds(source, max * 2).ok, false, 'above the bound is unreachable');
});

test('the minimum chance never puts the site at a loss', () => {
  // At the clamp boundaries the formula stops being exact; check that the
  // clamped chance never rises above the fair one.
  for (const [src, dst] of [
    [100, 106],
    [100, 1_000_000],
    [1, 200],
  ]) {
    const odds = calculateUpgradeOdds(src, dst);
    if (!odds.ok) continue;
    const fair = src / dst;
    assert.ok(
      odds.chance <= fair + 1e-9,
      `${src}->${dst}: chance ${odds.chance} exceeds the fair ${fair}`,
    );
  }
  assert.ok(UPGRADE_MIN_CHANCE > 0);
});
