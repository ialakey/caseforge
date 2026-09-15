import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { TICKET_SPACE, validateTicketRanges } from './tickets.ts';
import {
  BONUS_COOLDOWN_MS,
  BonusKind,
  WHEEL,
  WHEEL_SEGMENTS,
  canSpin,
  findWheelSlice,
  isVoucher,
  nextSpinAt,
  pickWheelSlice,
  voucherSaving,
  wheelGrantCost,
} from './bonus.ts';

test('the shares sum to exactly one', () => {
  const total = WHEEL_SEGMENTS.reduce((sum, s) => sum + s.share, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `shares sum to ${total}`);
});

test('the wheel tiles the ticket space with no gap and no overlap', () => {
  // The same invariant a case has to satisfy, checked with the same function:
  // a hole in the space is a roll that matches no slice.
  const validation = validateTicketRanges(WHEEL);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.valid, true);
});

test('every slice can actually be landed on', () => {
  for (const slice of WHEEL) {
    assert.ok(slice.chance > 0, `${slice.key} owns no tickets`);
    assert.ok(slice.rangeTo >= slice.rangeFrom, `${slice.key} has an inverted range`);
  }
});

test('slice keys are unique', () => {
  const keys = WHEEL.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('a roll lands on the slice that owns it', () => {
  for (const slice of WHEEL) {
    assert.equal(pickWheelSlice(slice.rangeFrom).key, slice.key, `${slice.key} lower bound`);
    assert.equal(pickWheelSlice(slice.rangeTo).key, slice.key, `${slice.key} upper bound`);
  }
  assert.equal(pickWheelSlice(0).key, WHEEL[0]!.key);
  assert.equal(pickWheelSlice(TICKET_SPACE - 1).key, WHEEL[WHEEL.length - 1]!.key);
});

test('the realised distribution over a sweep matches the advertised chances', () => {
  const samples = 200_000;
  const hits = new Map(WHEEL.map((s) => [s.key, 0]));
  for (let i = 0; i < samples; i++) {
    // Rolls are uniform across the ticket space, so sweep it uniformly.
    const roll = Math.floor((i * TICKET_SPACE) / samples);
    hits.set(pickWheelSlice(roll).key, hits.get(pickWheelSlice(roll).key)! + 1);
  }
  for (const slice of WHEEL) {
    const realised = hits.get(slice.key)! / samples;
    assert.ok(
      Math.abs(realised - slice.chance) < 0.002,
      `${slice.key}: realised ${realised.toFixed(4)} against ${slice.chance.toFixed(4)}`,
    );
  }
});

test('the wheel cannot cost more than a bounded amount per spin', () => {
  // The wheel is a daily giveaway, so what matters is not its return but its
  // ceiling. If a slice is ever re-tuned, this is the number to look at.
  const cost = wheelGrantCost();
  assert.ok(cost > 0, 'the wheel gives nothing away');
  assert.ok(cost <= 60_00, `a spin costs up to ${cost} minor units`);
});

test('instant rewards and vouchers are told apart', () => {
  assert.equal(isVoucher(BonusKind.DISCOUNT), true);
  assert.equal(isVoucher(BonusKind.FREE_CASE), true);
  assert.equal(isVoucher(BonusKind.BALANCE), false);
  assert.equal(isVoucher(BonusKind.FREE_ITEM), false);
});

test('a free case applies only within its ceiling', () => {
  const ceiling = 300_00;
  assert.equal(voucherSaving(BonusKind.FREE_CASE, ceiling, 100_00, 1), 100_00);
  assert.equal(voucherSaving(BonusKind.FREE_CASE, ceiling, ceiling, 1), ceiling);
  assert.equal(voucherSaving(BonusKind.FREE_CASE, ceiling, ceiling + 1, 1), 0);
  // It covers one opening out of the batch, not the whole batch.
  assert.equal(voucherSaving(BonusKind.FREE_CASE, ceiling, 100_00, 10), 100_00);
});

test('a discount takes its share of the whole batch', () => {
  // 25% off ten cases at 100.
  assert.equal(voucherSaving(BonusKind.DISCOUNT, 2500, 100_00, 10), 250_00);
  assert.equal(voucherSaving(BonusKind.DISCOUNT, 5000, 100_00, 1), 50_00);
});

test('discount rounding never favours the player', () => {
  // 10% of 99 is 9.9 tickets of a kopeck; the player must get 9, not 10.
  assert.equal(voucherSaving(BonusKind.DISCOUNT, 1000, 99, 1), 9);
  for (const price of [1, 7, 33, 99, 12345]) {
    const saving = voucherSaving(BonusKind.DISCOUNT, 3333, price, 1);
    assert.ok(saving <= (price * 3333) / 10_000, `saving ${saving} exceeds the exact share`);
  }
});

test('a discount never makes an opening free', () => {
  // Every discount on the wheel leaves something to pay, so the debit stays a
  // debit and the ledger keeps a non-zero row.
  for (const slice of WHEEL.filter((s) => s.kind === BonusKind.DISCOUNT)) {
    assert.ok(slice.value < 10_000, `${slice.key} is ${slice.value} bps, i.e. free or worse`);
  }
});

test('the cooldown is a rolling day', () => {
  const now = new Date('2026-09-15T12:00:00Z');
  assert.equal(canSpin(null, now), true, 'a player who never span may spin');

  const justNow = new Date(now.getTime() - 1000);
  assert.equal(canSpin(justNow, now), false);

  const aDayAgo = new Date(now.getTime() - BONUS_COOLDOWN_MS);
  assert.equal(canSpin(aDayAgo, now), true, 'exactly a day later is allowed');

  const almost = new Date(now.getTime() - BONUS_COOLDOWN_MS + 1);
  assert.equal(canSpin(almost, now), false, 'a millisecond short is not');
});

test('the next spin is a day after the last', () => {
  const last = new Date('2026-09-15T12:00:00Z');
  assert.equal(nextSpinAt(last)?.toISOString(), '2026-09-16T12:00:00.000Z');
  assert.equal(nextSpinAt(null), null);
  // Accepts the string form the API hands back.
  assert.equal(nextSpinAt(last.toISOString())?.getTime(), nextSpinAt(last)?.getTime());
});

test('a slice can be found by the key stored on a spin', () => {
  for (const slice of WHEEL) {
    assert.equal(findWheelSlice(slice.key)?.kind, slice.kind);
  }
  assert.equal(findWheelSlice('no-such-slice'), null);
});
