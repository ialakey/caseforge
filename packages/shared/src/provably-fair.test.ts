import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  TICKET_SPACE,
  calculateRtp,
  pickByRoll,
  validateTicketRanges,
} from './tickets.ts';
import {
  computeRoll,
  generateServerSeed,
  hashServerSeed,
  verifyOpening,
} from './provably-fair.ts';
import { verifyOpeningAsync } from './verify.ts';

test('roll is deterministic and inside the ticket space', () => {
  const seed = 'a'.repeat(64);
  const a = computeRoll(seed, 'client', 0);
  const b = computeRoll(seed, 'client', 0);
  assert.equal(a, b);
  assert.ok(a >= 0 && a < TICKET_SPACE);
});

test('roll changes with nonce and with client seed', () => {
  const seed = generateServerSeed();
  assert.notEqual(computeRoll(seed, 'c', 0), computeRoll(seed, 'c', 1));
  assert.notEqual(computeRoll(seed, 'c1', 0), computeRoll(seed, 'c2', 0));
});

test('negative or fractional nonce is rejected', () => {
  const seed = generateServerSeed();
  assert.throws(() => computeRoll(seed, 'c', -1));
  assert.throws(() => computeRoll(seed, 'c', 1.5));
});

test('verifyOpening confirms a legitimate opening and rejects a swapped seed', () => {
  const serverSeed = generateServerSeed();
  const serverSeedHash = hashServerSeed(serverSeed);
  const roll = computeRoll(serverSeed, 'my-seed', 7);

  const ok = verifyOpening({ serverSeed, serverSeedHash, clientSeed: 'my-seed', nonce: 7, expectedRoll: roll });
  assert.equal(ok.hashMatches, true);
  assert.equal(ok.rollMatches, true);

  const tampered = verifyOpening({
    serverSeed: generateServerSeed(),
    serverSeedHash,
    clientSeed: 'my-seed',
    nonce: 7,
    expectedRoll: roll,
  });
  assert.equal(tampered.hashMatches, false);
});

const fullCoverage = [
  { rangeFrom: 0, rangeTo: 799_999 },
  { rangeFrom: 800_000, rangeTo: 989_999 },
  { rangeFrom: 990_000, rangeTo: 999_999 },
];

test('valid ranges tile the whole ticket space', () => {
  assert.equal(validateTicketRanges(fullCoverage).valid, true);
});

test('a gap in ranges is reported', () => {
  const res = validateTicketRanges([
    { rangeFrom: 0, rangeTo: 499_999 },
    { rangeFrom: 500_001, rangeTo: 999_999 },
  ]);
  assert.equal(res.valid, false);
  assert.match(res.errors.join(' '), /gap/);
});

test('an overlap in ranges is reported', () => {
  const res = validateTicketRanges([
    { rangeFrom: 0, rangeTo: 600_000 },
    { rangeFrom: 500_000, rangeTo: 999_999 },
  ]);
  assert.equal(res.valid, false);
  assert.match(res.errors.join(' '), /overlap/);
});

test('ranges that stop short of the ticket space are reported', () => {
  const res = validateTicketRanges([{ rangeFrom: 0, rangeTo: 499_999 }]);
  assert.equal(res.valid, false);
  assert.match(res.errors.join(' '), /cover 500000 of 1000000/);
});

test('every possible roll hits exactly one item', () => {
  for (const roll of [0, 1, 799_999, 800_000, 989_999, 990_000, TICKET_SPACE - 1]) {
    assert.doesNotThrow(() => pickByRoll(fullCoverage, roll));
  }
});

test('drop distribution follows the ticket ranges', () => {
  const serverSeed = generateServerSeed();
  const counts = [0, 0, 0];
  const runs = 60_000;
  for (let nonce = 0; nonce < runs; nonce++) {
    const roll = computeRoll(serverSeed, 'dist', nonce);
    counts[fullCoverage.findIndex((r) => roll >= r.rangeFrom && roll <= r.rangeTo)]! += 1;
  }
  // 80% / 19% / 1%, with tolerance for variance
  assert.ok(Math.abs(counts[0]! / runs - 0.8) < 0.01, `common share ${counts[0]! / runs}`);
  assert.ok(Math.abs(counts[1]! / runs - 0.19) < 0.01, `rare share ${counts[1]! / runs}`);
  assert.ok(Math.abs(counts[2]! / runs - 0.01) < 0.005, `mythical share ${counts[2]! / runs}`);
});

test('rtp matches a hand-computed expectation', () => {
  // 90% x 50 + 10% x 500 = 45 + 50 = 95 at a price of 100 -> RTP 0.95
  const rtp = calculateRtp(
    [
      { rangeFrom: 0, rangeTo: 899_999, price: 50 },
      { rangeFrom: 900_000, rangeTo: 999_999, price: 500 },
    ],
    100,
  );
  assert.ok(Math.abs(rtp - 0.95) < 1e-9, `rtp ${rtp}`);
});

test('browser verification on Web Crypto matches the server on node:crypto', async () => {
  // This is what makes provably fair meaningful: the player recomputes the
  // opening with different code and must arrive at the same roll.
  const serverSeed = generateServerSeed();
  const serverSeedHash = hashServerSeed(serverSeed);
  const expectedRoll = computeRoll(serverSeed, 'browser-check', 42);

  const clientSide = await verifyOpeningAsync({
    serverSeed,
    serverSeedHash,
    clientSeed: 'browser-check',
    nonce: 42,
    expectedRoll,
  });

  assert.equal(clientSide.hashMatches, true);
  assert.equal(clientSide.rollMatches, true);
  assert.equal(clientSide.computedRoll, expectedRoll);
});
