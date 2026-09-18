/**
 * End-to-end smoke test for skin giveaways, against a LIVE API.
 *
 * The draw is the part worth testing outside the unit suite, because it is the
 * one place the site hands over a real item to somebody chosen at random. What
 * is checked here cannot be checked in isolation: that the server seed stays
 * hidden until the draw, that entering is refused without the required top-up
 * and refused twice for the same player, that the winner actually receives the
 * prize, and that the published numbers recompute to the same winner.
 *
 * Run:  node test/giveaway-smoke.mjs
 * Requires docker compose up, migrations applied, the seed run and the API
 * running on port 4000.
 */
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';

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

/** The same roll the server computes: HMAC over `clientSeed:nonce`, mod 1e6. */
function computeRoll(serverSeed, clientSeed, nonce) {
  const hmac = createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`).digest('hex');
  return Number.parseInt(hmac.slice(0, 8), 16) % 1_000_000;
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

const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
if (!admin) throw new Error('No administrator — run pnpm db:seed');

const prize = await prisma.item.findFirst({
  where: { marketPrice: { gt: 0 } },
  orderBy: { marketPrice: 'desc' },
});
if (!prize) throw new Error('No priced items — run pnpm seed:cases');

const token = signJwt(
  { sub: admin.id, steamId64: admin.steamId64, role: admin.role },
  process.env.JWT_ACCESS_SECRET,
);
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const post = (p, body) =>
  fetch(`${API}${p}`, { method: 'POST', headers: auth, body: body ? JSON.stringify(body) : undefined });

// The largest the schema allows, and far beyond anything the demo account has
// topped up — which is the point: this giveaway must be unreachable.
const HIGH_THRESHOLD = 100_000_000;
let unreachableId;
let winnableId;

console.log('\n1. A giveaway nobody can qualify for');
{
  const res = await post('/api/admin/giveaways', {
    itemId: prize.id,
    title: 'Smoke: unreachable',
    minDeposit: HIGH_THRESHOLD,
    opensAt: new Date().toISOString(),
    drawsAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const body = await res.json();
  unreachableId = body.id;

  assert(res.status === 201 || res.status === 200, `created with ${res.status}`);
  assert(body.status === 'OPEN', `it opens immediately (${body.status})`);
  assert(typeof body.serverSeedHash === 'string', 'the seed hash is published at once');
  // The whole promise of the scheme: the seed cannot be read while it could
  // still be used to choose a moment.
  assert(body.serverSeed === null, 'and the seed itself is withheld until the draw');
}

console.log('\n2. Entering without the top-up is refused');
{
  const res = await post(`/api/giveaways/${unreachableId}/enter`);
  const body = await res.json();
  assert(res.status === 400, `refused with ${res.status}`);
  assert(body.code === 'GIVEAWAY_DEPOSIT_REQUIRED', `and says why (${body.code})`);

  const count = await prisma.giveawayEntry.count({ where: { giveawayId: unreachableId } });
  assert(count === 0, 'nobody was entered');
}

console.log('\n3. A giveaway anybody may enter, entered once and only once');
{
  const res = await post('/api/admin/giveaways', {
    itemId: prize.id,
    title: 'Smoke: winnable',
    minDeposit: 0,
    opensAt: new Date().toISOString(),
    drawsAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  winnableId = (await res.json()).id;

  const first = await post(`/api/giveaways/${winnableId}/enter`);
  assert(first.status === 201 || first.status === 200, `the first entry is accepted (${first.status})`);

  const second = await post(`/api/giveaways/${winnableId}/enter`);
  const body = await second.json();
  assert(second.status === 400, `a second entry is refused with ${second.status}`);
  assert(body.code === 'GIVEAWAY_ALREADY_ENTERED', `and says why (${body.code})`);

  const count = await prisma.giveawayEntry.count({ where: { giveawayId: winnableId } });
  assert(count === 1, `exactly one entry stands (${count})`);
}

console.log('\n4. The draw hands over the prize, once');
{
  const before = await prisma.inventoryItem.count({
    where: { userId: admin.id, itemId: prize.id },
  });

  // The deadline is brought forward in the database rather than triggered
  // through an endpoint, because there deliberately is no endpoint: a draw
  // happens when `drawsAt` passes and at no other time. See the note in the
  // service about why an operator must not be able to choose the moment.
  await prisma.giveaway.update({
    where: { id: winnableId },
    data: { drawsAt: new Date(Date.now() - 1000) },
  });

  // Then wait for the sweep, which runs once a minute.
  let drawn = null;
  for (let i = 0; i < 70; i++) {
    drawn = await prisma.giveaway.findUnique({ where: { id: winnableId } });
    if (drawn.status === 'DRAWN') break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  assert(drawn.status === 'DRAWN', `the giveaway was drawn (${drawn.status})`);
  assert(drawn.winnerUserId === admin.id, 'the only entrant won');

  const after = await prisma.inventoryItem.count({
    where: { userId: admin.id, itemId: prize.id },
  });
  assert(after === before + 1, `the prize reached the winner's inventory (${before} -> ${after})`);

  // The published numbers have to recompute to the same winner, using only
  // what a visitor can see on the winners page.
  const entries = await prisma.giveawayEntry.findMany({
    where: { giveawayId: winnableId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, userId: true },
  });
  const clientSeed = createHash('sha256').update(entries.map((e) => e.id).join(',')).digest('hex');
  const roll = computeRoll(drawn.serverSeed, clientSeed, 0);

  assert(clientSeed === drawn.clientSeed, 'the client seed recomputes from the entrant list');
  assert(roll === drawn.roll, `the roll recomputes (${roll} === ${drawn.roll})`);
  assert(
    entries[roll % entries.length].userId === drawn.winnerUserId,
    'and picks the same winner',
  );

  assert(
    createHash('sha256').update(drawn.serverSeed).digest('hex') === drawn.serverSeedHash,
    'the revealed seed matches the hash published before the draw',
  );
}

console.log('\n5. A drawn giveaway publishes its seed');
{
  const list = await fetch(`${API}/api/giveaways/history`).then((r) => r.json());
  const row = list.find((g) => g.id === winnableId);
  assert(row !== undefined, 'it appears in the history');
  assert(typeof row.serverSeed === 'string', 'with the server seed now revealed');
  assert(typeof row.clientSeed === 'string', 'and the client seed');
}

console.log('\nCleaning up');
{
  await prisma.inventoryItem.deleteMany({
    where: { userId: admin.id, itemId: prize.id, openingId: null, bonusRewardId: null, createdAt: { gte: new Date(Date.now() - 600_000) } },
  });
  await prisma.giveaway.deleteMany({ where: { title: { startsWith: 'Smoke: ' } } });
  console.log('  removed the smoke giveaways and the prize they granted');
}

console.log(failures === 0 ? '\nAll giveaway checks passed' : `\n${failures} check(s) FAILED`);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);
