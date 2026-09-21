/**
 * End-to-end smoke test for the inventory, against a LIVE API.
 *
 * Covers what the unit tests cannot: that a sold or withdrawn item keeps its
 * row instead of disappearing, that the filters and price bands select what
 * they claim to, that selling everything respects the band it was pressed
 * under, and that the balance and the ledger agree afterwards.
 *
 * Run:  node test/inventory-smoke.mjs
 * Requires docker compose up, migrations applied, the seed run and the API
 * running on port 4000.
 */
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import { PRICE_BANDS, SPENT_STATUSES, inPriceBand } from '@caseforge/shared';

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

/**
 * The administrator these checks run as.
 *
 * Ordered, because `findFirst` without one is whatever Postgres hands back
 * first — and a deployment that has promoted a second admin then gets a
 * different account on each run. A suite that reconciles a balance against a
 * ledger has to look at the same account every time, or it passes and fails at
 * random for reasons that have nothing to do with the code.
 */
const user = await prisma.user.findFirst({
  where: { role: 'ADMIN' },
  orderBy: { createdAt: 'asc' },
});
if (!user) throw new Error('No administrator — run pnpm db:seed');
const token = signJwt(
  { sub: user.id, steamId64: user.steamId64, role: user.role },
  process.env.JWT_ACCESS_SECRET,
);
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const get = async (path) => (await fetch(`${API}${path}`, { headers: auth })).json();

console.log('\n1. The inventory needs a token');
{
  const res = await fetch(`${API}/api/inventory`);
  assert(res.status === 401, `anonymous request refused with ${res.status}`);
}

console.log('\n2. Spent items are kept, not deleted');
{
  const all = await get('/api/inventory?filter=all');
  const history = await get('/api/inventory?filter=history');
  const spent = all.filter((i) => SPENT_STATUSES.includes(i.status));
  assert(all.length > 0, `${all.length} row(s) in the inventory`);
  assert(
    history.every((i) => SPENT_STATUSES.includes(i.status)),
    'the history tab holds only spent statuses',
  );
  assert(
    history.length === spent.length,
    `history (${history.length}) matches the spent rows in "all" (${spent.length})`,
  );
}

console.log('\n3. The available filter returns only actionable items');
{
  const available = await get('/api/inventory?filter=available');
  assert(
    available.every((i) => i.status === 'AVAILABLE'),
    `all ${available.length} row(s) are AVAILABLE`,
  );
}

console.log('\n4. Summary counts agree with the rows');
const summary = await get('/api/inventory/summary');
{
  const all = await get('/api/inventory?filter=all');
  const available = await get('/api/inventory?filter=available');
  assert(summary.all.count >= all.length, `summary counts ${summary.all.count} in total`);
  assert(
    summary.available.count === available.length,
    `summary available ${summary.available.count} matches ${available.length} rows`,
  );
  assert(
    summary.all.count === summary.available.count + summary.pending.count + summary.history.count,
    'the tabs partition the inventory with no row counted twice',
  );
}

console.log('\n5. Price bands select what they advertise');
{
  for (const band of PRICE_BANDS) {
    const rows = await get(`/api/inventory?filter=all&band=${band.key}`);
    const inside = rows.every((r) => inPriceBand(r.acquiredPrice, band));
    assert(inside, `band ${band.key}: all ${rows.length} row(s) inside [${band.min}, ${band.max})`);
  }
}

console.log('\n6. Withdrawing locks the item behind a request');
{
  const available = await get('/api/inventory?filter=available');
  if (available.length === 0) throw new Error('No available items - open a case first');
  const target = available[0];

  const before = summary.all.count;

  // A request needs somewhere to deliver to, and the site refuses one without
  // it, so the trade URL is set here rather than assumed to be there already.
  const accountId = (BigInt(user.steamId64) - 76561197960265728n).toString();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      tradeUrl: `https://steamcommunity.com/tradeoffer/new/?partner=${accountId}&token=aBcD1234`,
    },
  });

  const res = await fetch(`${API}/api/withdrawals`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ inventoryItemIds: [target.id] }),
  });
  const out = await res.json();
  assert(res.status === 201 || res.status === 200, `withdrawal accepted with ${res.status}`);
  assert(typeof out.id === 'string', 'a request was created');

  const row = await prisma.inventoryItem.findUnique({ where: { id: target.id } });
  assert(row !== null, 'the row still exists after the request');
  // LOCKED rather than WITHDRAWN: nothing has been delivered yet. The worker
  // moves it on only once the market says the seller handed the skin over.
  assert(row.status === 'LOCKED', `status is ${row.status}`);
  assert(row.withdrawalId === out.id, 'the item is attached to the request');

  const after = await get('/api/inventory/summary');
  assert(after.all.count === before, `total rows unchanged: ${before} -> ${after.all.count}`);
  assert(after.pending.count === summary.pending.count + 1, 'the item moved into the pending tab');

  // A withdrawal is not a sale - it must not pay anything out.
  const fresh = await prisma.user.findUnique({ where: { id: user.id } });
  assert(fresh.balance === user.balance, 'requesting a withdrawal did not change the balance');

  // Cancelling returns it, so the run leaves nothing locked behind it.
  const cancelled = await fetch(`${API}/api/withdrawals/${out.id}/cancel`, {
    method: 'POST',
    headers: auth,
  });
  assert(cancelled.status === 201 || cancelled.status === 200, 'the request was cancelled');
  const returned = await prisma.inventoryItem.findUnique({ where: { id: target.id } });
  assert(returned.status === 'AVAILABLE', `the item came back as ${returned.status}`);
}

console.log('\n7. Withdrawing a spent item is refused');
{
  const spent = await prisma.inventoryItem.findFirst({
    where: { userId: user.id, status: { in: ['SOLD', 'WITHDRAWN'] } },
  });
  if (!spent) {
    console.log('  skipped: nothing spent yet');
  } else {
    const res = await fetch(`${API}/api/withdrawals`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ inventoryItemIds: [spent.id] }),
    });
    assert(res.status === 400, `withdrawing a spent item refused with ${res.status}`);
  }
}

console.log('\n8. Selling everything respects the band it was pressed under');
{
  const band = PRICE_BANDS[0];
  const before = await get(`/api/inventory?filter=available&band=${band.key}`);
  const outsideBefore = (await get('/api/inventory?filter=available')).filter(
    (r) => !inPriceBand(r.acquiredPrice, band),
  );

  if (before.length === 0) {
    console.log('  skipped: nothing available in the cheapest band');
  } else {
    const balanceBefore = (await prisma.user.findUnique({ where: { id: user.id } })).balance;

    const res = await fetch(`${API}/api/inventory/sell-all`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ band: band.key }),
    });
    const out = await res.json();
    assert(res.status === 201 || res.status === 200, `sell-all accepted with ${res.status}`);
    assert(out.sold === before.length, `sold ${out.sold} of ${before.length} in the band`);
    assert(
      out.balance === balanceBefore + out.total,
      `balance moved by exactly the reported total (${out.total})`,
    );

    const outsideAfter = (await get('/api/inventory?filter=available')).filter(
      (r) => !inPriceBand(r.acquiredPrice, band),
    );
    assert(
      outsideAfter.length === outsideBefore.length,
      `items outside the band untouched: ${outsideBefore.length} -> ${outsideAfter.length}`,
    );

    const emptied = await get(`/api/inventory?filter=available&band=${band.key}`);
    assert(emptied.length === 0, 'the band has nothing available left');
  }
}

console.log('\n9. The balance still agrees with the ledger');
{
  const sum = await prisma.transaction.aggregate({
    where: { userId: user.id },
    _sum: { amount: true },
  });
  const fresh = await prisma.user.findUnique({ where: { id: user.id } });
  assert(
    fresh.balance === (sum._sum.amount ?? 0),
    `balance ${fresh.balance} equals the ledger sum ${sum._sum.amount ?? 0}`,
  );
}

await prisma.$disconnect();
console.log(failures === 0 ? '\nAll inventory smoke checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
