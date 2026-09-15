/**
 * End-to-end smoke test for contracts, against a LIVE API.
 *
 * Covers what the unit tests cannot: that the staked items are really
 * consumed, that the reward really appears, that the stored outcome table
 * agrees with the roll the server recorded, and that the preview a player is
 * shown is the table the contract is actually played on.
 *
 * Run:  node test/contract-smoke.mjs
 * Requires docker compose up, migrations applied, the seed run and the API
 * running on port 4000.
 */
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import {
  CONTRACT_MAX_ITEMS,
  CONTRACT_MIN_ITEMS,
  CONTRACT_RTP,
  TICKET_SPACE,
  pickContractOutcome,
} from '@caseforge/shared';

config({ path: path.join(import.meta.dirname, '../../../.env') });

const API = 'http://localhost:4000';

/** HS256 by hand — see the note in smoke.mjs. */
function signJwt(payload, secret, ttlSeconds = 900) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ ...payload, iat: now, exp: now + ttlSeconds });
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const prisma = new PrismaClient();

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('  ok: ' + msg);
  } else {
    failures += 1;
    console.log('  FAILED: ' + msg);
  }
}

const user = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
if (!user) throw new Error('No administrator — run pnpm db:seed');
const token = signJwt(
  { sub: user.id, steamId64: user.steamId64, role: user.role },
  process.env.JWT_ACCESS_SECRET,
);
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

console.log('\n1. A contract needs a token');
{
  const res = await fetch(`${API}/api/contracts/stakes`);
  assert(res.status === 401, `anonymous stakes request refused with ${res.status}`);
}

console.log('\n2. Stakes list');
{
  // Open a few cheap cases if the account is short. The inventory suite sells
  // everything it finds, so running the smoke tests in sequence would otherwise
  // leave this one with nothing to stake and fail on the order rather than on
  // the code.
  let available = await (await fetch(`${API}/api/contracts/stakes`, { headers: auth })).json();
  if (available.length < CONTRACT_MIN_ITEMS) {
    const cases = await (await fetch(`${API}/api/cases`)).json();
    const cheapest = [...cases].sort((a, b) => a.price - b.price)[0];
    await fetch(`${API}/api/cases/open`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ caseId: cheapest.id, count: CONTRACT_MIN_ITEMS }),
    });
    console.log(`  (topped the inventory up from "${cheapest.name}")`);
  }
}

const stakes = await (await fetch(`${API}/api/contracts/stakes`, { headers: auth })).json();
assert(Array.isArray(stakes), `returned ${stakes.length} stakeable item(s)`);
assert(stakes.length >= CONTRACT_MIN_ITEMS, `at least ${CONTRACT_MIN_ITEMS} items to stake`);

console.log('\n3. Too few items is refused');
{
  const ids = stakes.slice(0, CONTRACT_MIN_ITEMS - 1).map((s) => s.inventoryItemId);
  const res = await fetch(`${API}/api/contracts`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ inventoryItemIds: ids }),
  });
  assert(res.status === 400, `a ${ids.length}-item contract refused with ${res.status}`);
}

console.log('\n4. The same item cannot be staked twice');
{
  const one = stakes[0].inventoryItemId;
  const res = await fetch(`${API}/api/contracts`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ inventoryItemIds: [one, one, one] }),
  });
  assert(res.status === 400, `a duplicated stake refused with ${res.status}`);
}

console.log('\n5. Preview');
const picked = stakes.slice(0, Math.min(CONTRACT_MAX_ITEMS, 4));
const ids = picked.map((s) => s.inventoryItemId);
const stakeValue = picked.reduce((sum, s) => sum + s.price, 0);

const preview = await (
  await fetch(`${API}/api/contracts/preview?inventoryItemIds=${ids.join(',')}`, { headers: auth })
).json();
assert(preview.stakeValue === stakeValue, `stake value ${preview.stakeValue} matches the items`);
assert(preview.outcomes.length >= 5, `${preview.outcomes.length} outcomes offered`);
assert(
  Math.abs(preview.rtp - CONTRACT_RTP) < 1e-3,
  `preview RTP ${preview.rtp.toFixed(6)} is the advertised ${CONTRACT_RTP}`,
);

const tickets = preview.outcomes.reduce((s, o) => s + (o.rangeTo - o.rangeFrom + 1), 0);
assert(tickets === TICKET_SPACE, `the outcomes tile all ${TICKET_SPACE} tickets`);
assert(
  preview.outcomes.every((o, i) => i === 0 || o.rangeFrom === preview.outcomes[i - 1].rangeTo + 1),
  'the ticket ranges are contiguous',
);
assert(
  preview.outcomes.every(
    (o) => o.price >= preview.rewardRange.min && o.price <= preview.rewardRange.max,
  ),
  `every outcome sits inside ${preview.rewardRange.min}..${preview.rewardRange.max}`,
);

const expected = preview.outcomes.reduce((s, o) => s + o.chance * o.price, 0);
assert(
  Math.abs(expected / stakeValue - CONTRACT_RTP) < 1e-3,
  `the table pays ${(expected / stakeValue).toFixed(6)} of the stake on average`,
);

console.log('\n6. Running the contract');
const before = await prisma.inventoryItem.count({ where: { userId: user.id, status: 'AVAILABLE' } });
const res = await fetch(`${API}/api/contracts`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ inventoryItemIds: ids }),
});
const result = await res.json();
assert(res.status === 201 || res.status === 200, `contract accepted with ${res.status}`);
assert(Boolean(result.contractId), `contract ${result.contractId} created`);
assert(result.stakeValue === stakeValue, 'the contract was played on the staked sum');

console.log('\n7. The roll agrees with the stored outcome table');
const stored = await prisma.contract.findUnique({
  where: { id: result.contractId },
  include: { stakes: true, reward: true },
});
assert(stored.roll === result.roll, `stored roll ${stored.roll} matches the response`);
assert(stored.roll >= 0 && stored.roll < TICKET_SPACE, `roll ${stored.roll} is inside the space`);

const winner = pickContractOutcome(stored.outcomes, stored.roll);
assert(
  winner.itemId === stored.rewardItemId,
  'the item the roll lands on is the item that was awarded',
);
assert(winner.price === stored.rewardValue, `the reward was valued at ${winner.price}`);
assert(
  stored.targetValue === Math.round(stakeValue * CONTRACT_RTP),
  `the table was solved for ${stored.targetValue}`,
);

console.log('\n8. The stakes are consumed and the reward exists');
assert(stored.stakes.length === ids.length, `${stored.stakes.length} item(s) recorded as staked`);
assert(
  stored.stakes.every((s) => s.status === 'CONTRACTED'),
  'every staked item is marked CONTRACTED',
);
assert(Boolean(stored.reward), 'a reward row was created');
assert(stored.reward.status === 'AVAILABLE', 'the reward is available to the player');
assert(
  stored.reward.acquiredPrice === stored.rewardValue,
  'the reward was banked at the price it was won for',
);
assert(
  stored.reward.id === result.rewardInventoryItemId,
  'the response points at the reward that was created',
);

const after = await prisma.inventoryItem.count({ where: { userId: user.id, status: 'AVAILABLE' } });
assert(
  after === before - ids.length + 1,
  `available items went ${before} -> ${after}, i.e. ${ids.length} in and 1 out`,
);

console.log('\n9. The staked items cannot be staked again');
{
  const again = await fetch(`${API}/api/contracts`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ inventoryItemIds: ids }),
  });
  assert(again.status === 400, `replaying the same stake refused with ${again.status}`);
}

console.log('\n10. The contract shares the opening nonce sequence');
{
  const seed = await prisma.serverSeed.findFirst({ where: { userId: user.id, isActive: true } });
  assert(seed.nonce >= stored.nonce, `seed nonce ${seed.nonce} advanced past the contract`);
  const clash = await prisma.contract.findFirst({
    where: { serverSeedId: stored.serverSeedId, nonce: stored.nonce, id: { not: stored.id } },
  });
  assert(clash === null, 'the (seed, nonce) pair is unique to this contract');
}

console.log('\n11. History');
{
  const history = await (
    await fetch(`${API}/api/contracts/history?page=1&perPage=10`, { headers: auth })
  ).json();
  assert(history.total >= 1, `${history.total} contract(s) in history`);
  assert(history.items[0].id === stored.id, 'the newest contract is the one just played');
  assert(history.items[0].stakeCount === ids.length, 'history records how many items went in');
}

await prisma.$disconnect();
console.log(failures === 0 ? '\nAll contract smoke checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
