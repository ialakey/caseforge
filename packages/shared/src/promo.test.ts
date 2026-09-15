import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  PromoKind,
  PromoRejection,
  checkPromoCode,
  normalisePromoCode,
  promoBonus,
  promoCodeSchema,
  upsertPromoCodeSchema,
} from './promo.ts';

const base = {
  kind: PromoKind.PERCENT,
  value: 1000,
  minDeposit: 0,
  maxBonus: null,
  maxUses: null,
  usedCount: 0,
  perUserLimit: 1,
  isActive: true,
  startsAt: null,
  expiresAt: null,
};

test('a percentage code is a share of the deposit', () => {
  assert.equal(promoBonus({ kind: PromoKind.PERCENT, value: 1000, maxBonus: null }, 500_00), 50_00);
  assert.equal(
    promoBonus({ kind: PromoKind.PERCENT, value: 2500, maxBonus: null }, 400_00),
    100_00,
  );
});

test('a fixed code pays the same regardless of the deposit', () => {
  const rules = { kind: PromoKind.FIXED, value: 100_00, maxBonus: null };
  assert.equal(promoBonus(rules, 100_00), 100_00);
  assert.equal(promoBonus(rules, 10_000_00), 100_00);
});

test('the cap applies to a percentage code', () => {
  const rules = { kind: PromoKind.PERCENT, value: 5000, maxBonus: 200_00 };
  assert.equal(promoBonus(rules, 100_00), 50_00, 'under the cap it is the plain share');
  assert.equal(promoBonus(rules, 10_000_00), 200_00, 'over it, the cap');
});

test('rounding never favours the player', () => {
  // 10% of 99 is 9.9 minor units; the player must get 9.
  assert.equal(promoBonus({ kind: PromoKind.PERCENT, value: 1000, maxBonus: null }, 99), 9);
  for (const amount of [1, 7, 33, 99, 12345, 999_99]) {
    const bonus = promoBonus({ kind: PromoKind.PERCENT, value: 3333, maxBonus: null }, amount);
    assert.ok(bonus <= (amount * 3333) / 10_000, `bonus ${bonus} exceeds the exact share`);
  }
});

test('a usable code reports what it is worth', () => {
  const check = checkPromoCode(base, 500_00, 0);
  assert.equal(check.ok, true);
  if (!check.ok) return;
  assert.equal(check.bonus, 50_00);
});

test('an inactive code is refused', () => {
  const check = checkPromoCode({ ...base, isActive: false }, 500_00, 0);
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.equal(check.reason, PromoRejection.INACTIVE);
});

test('a code is refused outside its window', () => {
  const now = new Date('2026-09-15T12:00:00Z');

  const early = checkPromoCode({ ...base, startsAt: '2026-09-16T00:00:00Z' }, 500_00, 0, now);
  assert.equal(early.ok, false);
  if (!early.ok) assert.equal(early.reason, PromoRejection.NOT_STARTED);

  const late = checkPromoCode({ ...base, expiresAt: '2026-09-15T00:00:00Z' }, 500_00, 0, now);
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.reason, PromoRejection.EXPIRED);

  // The instant it expires it is already gone, not still valid.
  const boundary = checkPromoCode({ ...base, expiresAt: now.toISOString() }, 500_00, 0, now);
  assert.equal(boundary.ok, false);
});

test('a code that has run out globally is refused', () => {
  const check = checkPromoCode({ ...base, maxUses: 100, usedCount: 100 }, 500_00, 0);
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.equal(check.reason, PromoRejection.EXHAUSTED);
});

test('the per-player limit is separate from the global one', () => {
  // Plenty left overall, but this player has had theirs.
  const check = checkPromoCode(
    { ...base, maxUses: 1000, usedCount: 5, perUserLimit: 1 },
    500_00,
    1,
  );
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.equal(check.reason, PromoRejection.ALREADY_USED);

  const second = checkPromoCode({ ...base, perUserLimit: 3 }, 500_00, 2);
  assert.equal(second.ok, true, 'a limit of three allows a third use');
});

test('a deposit below the minimum is refused, and says what the minimum is', () => {
  const check = checkPromoCode({ ...base, minDeposit: 1_000_00 }, 500_00, 0);
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.equal(check.reason, PromoRejection.DEPOSIT_TOO_SMALL);
  assert.equal(check.minDeposit, 1_000_00);
});

test('an unlimited code has no cap to hit', () => {
  const check = checkPromoCode({ ...base, maxUses: null, usedCount: 10_000 }, 500_00, 0);
  assert.equal(check.ok, true);
});

test('codes are matched however they were typed', () => {
  assert.equal(normalisePromoCode(' welcome10 '), 'WELCOME10');
  assert.equal(normalisePromoCode('WeLcOmE'), 'WELCOME');
  assert.equal(promoCodeSchema.parse('  summer_25 '), 'SUMMER_25');
});

test('a malformed code is rejected', () => {
  for (const bad of ['ab', '', 'has space', 'пробел', 'a'.repeat(33)]) {
    assert.equal(promoCodeSchema.safeParse(bad).success, false, `accepted ${JSON.stringify(bad)}`);
  }
  for (const good of ['ABC', 'WELCOME-10', 'SUMMER_25', '2026NY']) {
    assert.equal(promoCodeSchema.safeParse(good).success, true, `rejected ${good}`);
  }
});

test('a percentage over 100% cannot be saved', () => {
  const input = {
    code: 'TOOMUCH',
    kind: PromoKind.PERCENT,
    value: 20_000,
    minDeposit: 0,
    maxBonus: null,
    maxUses: null,
    perUserLimit: 1,
    isActive: true,
    startsAt: null,
    expiresAt: null,
  };
  assert.equal(upsertPromoCodeSchema.safeParse(input).success, false);
  // The same value is fine for a fixed code, where it is money rather than bps.
  assert.equal(upsertPromoCodeSchema.safeParse({ ...input, kind: PromoKind.FIXED }).success, true);
});

test('a code cannot expire before it starts', () => {
  const result = upsertPromoCodeSchema.safeParse({
    code: 'BACKWARDS',
    kind: PromoKind.FIXED,
    value: 100,
    minDeposit: 0,
    maxBonus: null,
    maxUses: null,
    perUserLimit: 1,
    isActive: true,
    startsAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(result.success, false);
});
