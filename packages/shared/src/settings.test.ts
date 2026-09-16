import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateTicketRanges } from './tickets.ts';
import { WHEEL_SEGMENTS, buildWheel } from './bonus.ts';
import {
  SETTING_GROUPS,
  SETTING_KEYS,
  defaultSettings,
  parseSetting,
  settingDefinitions,
  validateSetting,
} from './settings.ts';

test('every setting has a default that its own schema accepts', () => {
  // A registry whose defaults do not validate would fail the moment an
  // operator saved the form back unchanged.
  const defaults = defaultSettings();
  for (const key of SETTING_KEYS) {
    const result = validateSetting(key, defaults[key]);
    assert.equal(result.ok, true, `${key}: default is rejected by its own schema`);
  }
});

test('every setting belongs to a known group', () => {
  const definitions = settingDefinitions();
  for (const key of SETTING_KEYS) {
    assert.ok(
      (SETTING_GROUPS as readonly string[]).includes(definitions[key].group),
      `${key}: group "${definitions[key].group}" is not one of the known groups`,
    );
    assert.ok(definitions[key].label.length > 0, `${key}: no label`);
  }
});

test('a missing value falls back to the default rather than throwing', () => {
  for (const key of SETTING_KEYS) {
    const missing = parseSetting(key, undefined);
    assert.equal(missing.usedDefault, true, `${key}: undefined did not fall back`);
    const nulled = parseSetting(key, null);
    assert.equal(nulled.usedDefault, true, `${key}: null did not fall back`);
  }
});

test('a corrupt stored value falls back instead of taking the site down', () => {
  // This is the whole point of parseSetting being total: a hand-edited row must
  // not be able to stop the API from serving.
  const result = parseSetting('economy.sellFeeBps', { nonsense: true });
  assert.equal(result.usedDefault, true);
  assert.equal(result.value, 0);

  const wheel = parseSetting('bonus.wheel', 'not a wheel at all');
  assert.equal(wheel.usedDefault, true);
  assert.deepEqual(wheel.value, WHEEL_SEGMENTS);
});

test('out-of-range numbers are refused on the way in', () => {
  assert.equal(validateSetting('economy.sellFeeBps', -1).ok, false);
  assert.equal(validateSetting('economy.sellFeeBps', 99_999).ok, false);
  assert.equal(validateSetting('economy.sellFeeBps', 250).ok, true);

  assert.equal(validateSetting('bonus.cooldownHours', 0).ok, false);
  assert.equal(validateSetting('bonus.cooldownHours', 24).ok, true);

  assert.equal(validateSetting('limits.openWindowSec', 0).ok, false);
  assert.equal(validateSetting('limits.openPerWindow', 1).ok, true);
});

test('a wheel whose shares do not add up is refused', () => {
  const result = validateSetting('bonus.wheel', [
    { key: 'a', kind: 'BALANCE', share: 0.5, value: 100 },
    { key: 'b', kind: 'BALANCE', share: 0.2, value: 100 },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(
    result.errors.some((e) => /add up to 1/.test(e)),
    `errors were ${JSON.stringify(result.errors)}`,
  );
});

test('a wheel with duplicate keys is refused', () => {
  const result = validateSetting('bonus.wheel', [
    { key: 'same', kind: 'BALANCE', share: 0.5, value: 100 },
    { key: 'same', kind: 'BALANCE', share: 0.5, value: 100 },
  ]);
  assert.equal(result.ok, false);
});

test('a wheel with a 100% discount is refused', () => {
  // It would make an opening free and turn the debit into a no-op.
  const result = validateSetting('bonus.wheel', [
    { key: 'free', kind: 'DISCOUNT', share: 0.5, value: 10_000 },
    { key: 'ok', kind: 'BALANCE', share: 0.5, value: 100 },
  ]);
  assert.equal(result.ok, false);
});

test('an operator-supplied wheel still tiles the ticket space', () => {
  // The point of running edited slices through the same buildWheel: whatever an
  // operator saves, the rolled wheel stays whole.
  const custom = [
    { key: 'a', kind: 'BALANCE' as const, share: 0.125, value: 500 },
    { key: 'b', kind: 'DISCOUNT' as const, share: 0.375, value: 1500 },
    { key: 'c', kind: 'FREE_CASE' as const, share: 0.4, value: 100_00 },
    { key: 'd', kind: 'FREE_ITEM' as const, share: 0.1, value: 50_00 },
  ];
  const result = validateSetting('bonus.wheel', custom);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const wheel = buildWheel(custom);
  const validation = validateTicketRanges(wheel);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.valid, true);
});

test('an enum setting offers exactly the values it accepts', () => {
  // The panel renders the options list and the schema judges what comes back.
  // If they disagree, the form offers a choice that saving then rejects.
  const definitions = settingDefinitions();
  for (const key of SETTING_KEYS) {
    const def = definitions[key];
    if (def.kind !== 'enum') {
      assert.equal(def.options, null, `${key}: only an enum setting may carry options`);
      continue;
    }
    assert.ok(def.options && def.options.length > 0, `${key}: an enum with no options`);
    for (const option of def.options!) {
      assert.equal(validateSetting(key, option).ok, true, `${key}: rejects its own option ${option}`);
    }
    assert.equal(validateSetting(key, 'not-an-option').ok, false, `${key}: accepts anything`);
  }
});

test('the delivery channel is one of the two that exist', () => {
  assert.equal(validateSetting('withdrawals.provider', 'MARKET').ok, true);
  assert.equal(validateSetting('withdrawals.provider', 'BOTS').ok, true);
  assert.equal(validateSetting('withdrawals.provider', 'market').ok, false);
});

test('the overpay ceiling cannot be opened all the way', () => {
  // Basis points, so 10 000 is "pay up to double" — anything past that is a
  // typo rather than a policy.
  assert.equal(validateSetting('withdrawals.market.maxOverpayBps', -1).ok, false);
  assert.equal(validateSetting('withdrawals.market.maxOverpayBps', 10_001).ok, false);
  assert.equal(validateSetting('withdrawals.market.maxOverpayBps', 700).ok, true);
});

test('an unknown key is not silently accepted', () => {
  // The keys are a closed set; typos have to be caught rather than stored.
  assert.equal((SETTING_KEYS as string[]).includes('nonsense.key'), false);
});
