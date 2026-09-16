import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  MarketStage,
  classifyStage,
  explainNoAccount,
  pickAccount,
  fromMarketMajor,
  fromMarketPrice,
  marketCurrencyProblem,
  marketSearchSchema,
  maxPayable,
  pickOffer,
  toMarketPrice,
} from './market.ts';

test('roubles convert one-for-one and dollars do not', () => {
  // The market quotes RUB in kopecks but USD in thousandths. Getting this
  // wrong does not throw — it silently authorises ten times the price.
  assert.equal(toMarketPrice(12_345, 'RUB'), 12_345);
  assert.equal(toMarketPrice(12_345, 'USD'), 123_450);
  assert.equal(toMarketPrice(12_345, 'EUR'), 123_450);

  assert.equal(fromMarketPrice(12_345, 'RUB'), 12_345);
  assert.equal(fromMarketPrice(123_450, 'USD'), 12_345);
});

test('a balance in whole units becomes minor units', () => {
  assert.equal(fromMarketMajor(123.45), 12_345);
  assert.equal(fromMarketMajor(0.9), 90);
  assert.equal(fromMarketMajor(0), 0);
});

test('an account in another currency is refused rather than converted', () => {
  // The site has no settlement rate, only a display one, and buying against a
  // display rate is how a withdrawal ends up costing eighty times the item.
  assert.equal(marketCurrencyProblem('RUB'), null);
  assert.equal(marketCurrencyProblem('rub'), null);
  assert.ok(marketCurrencyProblem('USD'));
  assert.ok(marketCurrencyProblem('GBP'));
  assert.ok(marketCurrencyProblem(null));
});

test('the overpay cap is what the operator set, rounded down', () => {
  assert.equal(maxPayable(100_00, 0), 100_00);
  assert.equal(maxPayable(100_00, 700), 107_00);
  assert.equal(maxPayable(333, 700), 356);
  // Never above the ceiling: the rounding has to go the site's way.
  assert.ok(maxPayable(333, 700) <= (333 * 10_700) / 10_000);
});

test('the cheapest offer inside the cap wins', () => {
  const offers = [
    { price: 900, count: 3, class: null, instance: null },
    { price: 700, count: 1, class: null, instance: null },
    { price: 1_500, count: 9, class: null, instance: null },
  ];
  assert.equal(pickOffer(offers, 1_000)?.price, 700);
});

test('a sold-out listing is not an offer', () => {
  // count: 0 is the market saying the listing has already gone. Buying against
  // it fails later and slower than skipping it now.
  const offers = [
    { price: 700, count: 0, class: null, instance: null },
    { price: 900, count: 2, class: null, instance: null },
  ];
  assert.equal(pickOffer(offers, 1_000)?.price, 900);
});

test('nothing inside the cap means no purchase, not the cheapest anyway', () => {
  const offers = [{ price: 5_000, count: 4, class: null, instance: null }];
  assert.equal(pickOffer(offers, 1_000), null);
  assert.equal(pickOffer([], 1_000), null);
});

test('only a documented stage is read as final', () => {
  assert.equal(classifyStage(MarketStage.ITEM_GIVEN), 'DELIVERED');
  assert.equal(classifyStage(MarketStage.TIMED_OUT), 'FAILED');
  assert.equal(classifyStage(MarketStage.NEW), 'PENDING');
  // An unfamiliar stage keeps waiting. Writing a purchase off early hands the
  // player their item back while the seller is still delivering the real one.
  assert.equal(classifyStage(3), 'PENDING');
  assert.equal(classifyStage(undefined), 'PENDING');
  assert.equal(classifyStage(null), 'PENDING');
});

test('a search response is parsed rather than trusted', () => {
  // The market returns some numbers as strings; coercion is what keeps a
  // string price from being compared against the cap as text.
  const parsed = marketSearchSchema.parse({
    success: true,
    currency: 'RUB',
    data: [{ market_hash_name: 'AK-47 | Redline', price: '400', count: '10' }],
  });
  assert.equal(parsed.data?.[0]?.price, 400);
  assert.equal(parsed.data?.[0]?.count, 10);
});

const account = (over: Partial<Parameters<typeof pickAccount>[0][number]> = {}) => ({
  id: 'a',
  status: 'ONLINE',
  balance: 1_000_00,
  currency: 'RUB',
  lastUsedAt: 0,
  ...over,
});

test('the least recently used account buys, not the richest', () => {
  // Spreading requests is the whole reason there is more than one key: the
  // market deletes one that goes over five requests a second. Always picking
  // the fattest balance would funnel every purchase through a single key.
  const chosen = pickAccount(
    [
      account({ id: 'rich', balance: 900_000_00, lastUsedAt: 500 }),
      account({ id: 'idle', balance: 10_000, lastUsedAt: 100 }),
    ],
    5_000,
  );
  assert.equal(chosen?.id, 'idle');
});

test('an account that cannot cover the price is skipped', () => {
  const chosen = pickAccount(
    [
      account({ id: 'broke', balance: 100, lastUsedAt: 0 }),
      account({ id: 'funded', balance: 50_000, lastUsedAt: 900 }),
    ],
    5_000,
  );
  assert.equal(chosen?.id, 'funded');
});

test('an account that has never been read is still tried', () => {
  // Otherwise a freshly added key would sit idle for ever: nothing would use
  // it, so nothing would ever learn its balance.
  assert.equal(pickAccount([account({ id: 'fresh', balance: null })], 5_000)?.id, 'fresh');
});

test('only online accounts in the right currency buy', () => {
  assert.equal(pickAccount([account({ status: 'DISABLED' })], 100), null);
  assert.equal(pickAccount([account({ status: 'ERROR' })], 100), null);
  assert.equal(pickAccount([account({ status: 'OFFLINE' })], 100), null);
  // A dollar account against a rouble site would be charged ten times over.
  assert.equal(pickAccount([account({ currency: 'USD' })], 100), null);
});

test('the refusal says which thing an operator has to fix', () => {
  assert.match(explainNoAccount([], 100), /registered/);
  assert.match(explainNoAccount([account({ status: 'DISABLED' })], 100), /online/);
  assert.match(explainNoAccount([account({ currency: 'USD' })], 100), /USD/);
  assert.match(explainNoAccount([account({ balance: 1 })], 100), /100/);
});
