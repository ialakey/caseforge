import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { TICKET_SPACE, calculateRtp, validateTicketRanges } from './tickets.ts';
import {
  MAX_ALLOWED_RTP,
  autoBalance,
  distributeRanges,
  judgeRtp,
  suggestCasePrice,
} from './balancing.ts';

test('distributeRanges covers the whole ticket space', () => {
  const ranges = distributeRanges([0.5, 0.3, 0.19, 0.01]);
  assert.equal(validateTicketRanges(ranges).valid, true);
});

test('the rounding remainder goes to the widest range, not the last one', () => {
  // Three shares of 1/3 give 333,333 tickets each, leaving 1 spare.
  const ranges = distributeRanges([1 / 3, 1 / 3, 1 / 3]);
  const widths = ranges.map((r) => r.rangeTo - r.rangeFrom + 1);
  assert.equal(widths.reduce((a, b) => a + b, 0), TICKET_SPACE);
  assert.equal(widths[0], 333_334, 'the spare ticket went to the first, not the last');
});

test('an item with a vanishing share still gets a ticket', () => {
  const ranges = distributeRanges([0.9999999, 0.0000001]);
  assert.equal(validateTicketRanges(ranges).valid, true);
  assert.ok(ranges[1]!.rangeTo - ranges[1]!.rangeFrom + 1 >= 1, 'zero-chance slots must not exist');
});

test('suggestCasePrice derives the price from the loot table', () => {
  // 90% x 50 + 10% x 500 = 95; at RTP 0.95 the price must come out at 100.
  const price = suggestCasePrice(
    [
      { rangeFrom: 0, rangeTo: 899_999, price: 50 },
      { rangeFrom: 900_000, rangeTo: 999_999, price: 500 },
    ],
    0.95,
  );
  assert.equal(price, 100);
});

test('autoBalance hits the target RTP', () => {
  const items = [{ price: 300 }, { price: 1200 }, { price: 6200 }, { price: 48_000 }, { price: 480_000 }];
  const casePrice = 10_000;

  const result = autoBalance(items, casePrice, 0.9);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(validateTicketRanges(result.ranges).valid, true);
  assert.ok(Math.abs(result.actualRtp - 0.9) < 0.001, `got RTP ${result.actualRtp}`);
});

test('autoBalance makes pricier items rarer', () => {
  const items = [{ price: 300 }, { price: 6200 }, { price: 480_000 }];
  const result = autoBalance(items, 10_000, 0.9);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const widths = result.ranges.map((r) => r.rangeTo - r.rangeFrom + 1);
  assert.ok(widths[0]! > widths[1]!, 'the cheap one must beat the mid one');
  assert.ok(widths[1]! > widths[2]!, 'the mid one must beat the expensive one');
});

test('autoBalance refuses when the target RTP is unreachable', () => {
  // The cheapest item costs more than the case — sub-100% return is impossible.
  const result = autoBalance([{ price: 5000 }, { price: 9000 }], 1000, 0.9);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /achievable RTP/);
  assert.ok(result.minRtp > 1, 'the minimum achievable RTP is above 100%');
});

test('autoBalance refuses when prices are zero', () => {
  const result = autoBalance([{ price: 0 }, { price: 100 }], 1000, 0.9);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /price/);
});

test('autoBalance works on a single-item case', () => {
  const result = autoBalance([{ price: 900 }], 1000, 0.9);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ranges.length, 1);
  assert.equal(result.ranges[0]!.rangeFrom, 0);
  assert.equal(result.ranges[0]!.rangeTo, TICKET_SPACE - 1);
});

test('autoBalance survives a huge price spread without overflow', () => {
  // A knife worth 2.4M minor units next to an item worth 300: without
  // normalisation price^(-k) goes to Infinity and the solution falls apart.
  const items = [{ price: 300 }, { price: 2_400_000 }];
  const result = autoBalance(items, 5000, 0.9);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(Number.isFinite(result.actualRtp));
  assert.ok(Math.abs(result.actualRtp - 0.9) < 0.01, `RTP ${result.actualRtp}`);
  assert.equal(validateTicketRanges(result.ranges).valid, true);
});

test('the actual RTP from autoBalance matches an independent calculation', () => {
  const prices = [300, 1200, 15_000, 95_000, 1_650_000];
  const casePrice = 30_000;
  const result = autoBalance(prices.map((price) => ({ price })), casePrice, 0.88);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const independent = calculateRtp(
    result.ranges.map((r, i) => ({ ...r, price: prices[i]! })),
    casePrice,
  );
  assert.ok(Math.abs(independent - result.actualRtp) < 1e-12);
});

test('judgeRtp blocks a loss-making case', () => {
  const verdict = judgeRtp(1.05);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.message, /loses money/);
});

test('judgeRtp allows but flags a borderline case as unhealthy', () => {
  const verdict = judgeRtp(MAX_ALLOWED_RTP - 0.01);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.healthy, false);
});

test('judgeRtp calls a case inside the corridor healthy', () => {
  const verdict = judgeRtp(0.9);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.healthy, true);
});
