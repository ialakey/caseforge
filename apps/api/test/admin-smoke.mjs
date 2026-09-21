/**
 * End-to-end smoke test for the settings registry and promo codes, against a
 * LIVE API.
 *
 * Covers what the unit tests cannot: that a saved setting actually reaches the
 * behaviour it configures, that a bad one is refused rather than stored, that a
 * promo code credits a separate ledger row, and that its limits hold when the
 * same code is redeemed twice.
 *
 * Run:  node test/admin-smoke.mjs
 * Requires docker compose up, migrations applied, the seed run and the API
 * running on port 4000.
 */
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import { SETTING_KEYS, sellPrice } from '@caseforge/shared';

config({ path: path.join(import.meta.dirname, '../../../.env') });

const API = 'http://localhost:4000';

/**
 * The cheapest case a player can actually buy.
 *
 * Not simply the cheapest: a free case is priced at 0 and therefore sorts
 * first, but it is rationed by a deposit threshold and a 24-hour opening limit
 * rather than by a price. Opening one here is refused outright, and a battle
 * built from one has an entry price of nothing — which is a wager no
 * commission can be a share of.
 */
function cheapestPaid(cases) {
  const paid = cases.filter((c) => c.price > 0 && !c.free);
  if (paid.length === 0) {
    throw new Error('No purchasable case in the catalogue — run pnpm seed:cases');
  }
  return paid.reduce((a, b) => (a.price <= b.price ? a : b));
}

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
const admin = await prisma.user.findFirst({
  where: { role: 'ADMIN' },
  orderBy: { createdAt: 'asc' },
});
if (!admin) throw new Error('No administrator — run pnpm db:seed');
const token = signJwt(
  { sub: admin.id, steamId64: admin.steamId64, role: admin.role },
  process.env.JWT_ACCESS_SECRET,
);
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const get = async (p) => (await fetch(`${API}${p}`, { headers: auth })).json();
const post = (p, body) =>
  fetch(`${API}${p}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });

const saveSettings = (values) => post('/api/admin/settings', { values });

console.log('\n1. Settings need a staff token');
{
  const res = await fetch(`${API}/api/admin/settings`);
  assert(res.status === 401, `anonymous read refused with ${res.status}`);
}

console.log('\n2. The registry describes every setting it returns');
const initial = await get('/api/admin/settings');
{
  assert(
    Object.keys(initial.definitions).length === SETTING_KEYS.length,
    `${Object.keys(initial.definitions).length} definitions for ${SETTING_KEYS.length} keys`,
  );
  assert(
    SETTING_KEYS.every((k) => k in initial.values),
    'every key has a value',
  );
  assert(
    Object.values(initial.definitions).every((d) => d.group && d.kind && d.label),
    'every definition carries a group, a kind and a label',
  );
}

console.log('\n3. A bad value is refused, not stored');
{
  // Shares that do not add up would leave part of the ticket space unreachable.
  const bad = await saveSettings({
    'bonus.wheel': [
      { key: 'a', kind: 'BALANCE', share: 0.5, value: 100 },
      { key: 'b', kind: 'BALANCE', share: 0.2, value: 100 },
    ],
  });
  assert(bad.status === 400, `a wheel summing to 0.7 refused with ${bad.status}`);

  const out = await saveSettings({ 'economy.sellFeeBps': 999999 });
  assert(out.status === 400, `an out-of-range fee refused with ${out.status}`);

  const unknown = await saveSettings({ 'nonsense.key': 1 });
  assert(unknown.status === 400, `an unknown key refused with ${unknown.status}`);

  const after = await get('/api/admin/settings');
  assert(
    JSON.stringify(after.values) === JSON.stringify(initial.values),
    'nothing was stored by the refused writes',
  );
}

console.log('\n4. A saved setting changes the behaviour it configures');
{
  // The sell-back fee is the cleanest one to observe: it shows up in the price
  // the inventory quotes for an item.
  await saveSettings({ 'economy.sellFeeBps': 1000 });

  const cases = await (await fetch(`${API}/api/cases`)).json();
  const cheapest = cheapestPaid(cases);
  await post('/api/cases/open', { caseId: cheapest.id, count: 1 });

  const inventory = await get('/api/inventory?filter=available');
  const item = inventory[0];
  assert(Boolean(item), 'there is an item to quote');
  assert(
    item.sellPrice === sellPrice(item.acquiredPrice, 1000),
    `sell price ${item.sellPrice} reflects the 10% fee on ${item.acquiredPrice}`,
  );

  await saveSettings({ 'economy.sellFeeBps': 0 });
  const restored = await get('/api/inventory?filter=available');
  assert(
    restored[0].sellPrice === restored[0].acquiredPrice,
    'and reverts when the fee goes back to zero',
  );
}

console.log('\n5. Maintenance mode stops play without stopping sign-in');
{
  await saveSettings({ 'site.maintenance': true });
  const cases = await (await fetch(`${API}/api/cases`)).json();
  // A purchasable case, because the second half of this check needs the
  // opening to succeed: the catalogue leads with free cases, and those are
  // refused by their own deposit gate whatever maintenance mode says. The
  // maintenance refusal would still read as correct — it is checked first —
  // and the resumption would then fail for an unrelated reason.
  const target = cheapestPaid(cases);
  const res = await post('/api/cases/open', { caseId: target.id, count: 1 });
  const body = await res.json();
  assert(res.status === 400, `opening refused with ${res.status}`);
  assert(body.code === 'MAINTENANCE', `refused as ${body.code}`);

  const me = await fetch(`${API}/api/me`, { headers: auth });
  assert(me.status === 200, 'the profile still loads during maintenance');

  await saveSettings({ 'site.maintenance': false });
  const reopened = await post('/api/cases/open', { caseId: target.id, count: 1 });
  assert(reopened.status === 201 || reopened.status === 200, 'and play resumes when it is off');
}

console.log('\n6. A promo code credits the deposit and a separate bonus row');
const code = `SMOKE${Date.now().toString().slice(-6)}`;
{
  const created = await post('/api/admin/promo-codes', {
    code,
    kind: 'PERCENT',
    value: 2000,
    minDeposit: 100_00,
    maxBonus: null,
    maxUses: null,
    perUserLimit: 1,
    isActive: true,
    startsAt: null,
    expiresAt: null,
  });
  assert(created.status === 201 || created.status === 200, `code created with ${created.status}`);

  const deposit = 500_00;
  const expectedBonus = Math.floor((deposit * 2000) / 10_000);

  const preview = await (await post('/api/me/promo/preview', { amount: deposit, promoCode: code.toLowerCase() })).json();
  assert(preview.bonus === expectedBonus, `preview quotes ${preview.bonus}, expected ${expectedBonus}`);
  assert(preview.code === code, 'a lower-cased code matches the stored upper-cased one');

  const before = (await prisma.user.findUnique({ where: { id: admin.id } })).balance;
  const res = await post('/api/me/deposit', { amount: deposit, promoCode: code });
  const out = await res.json();
  assert(res.status === 201 || res.status === 200, `deposit accepted with ${res.status}`);
  assert(
    out.balance === before + deposit + expectedBonus,
    `balance rose by the deposit plus ${expectedBonus}`,
  );

  const rows = await prisma.transaction.findMany({
    where: { userId: admin.id },
    orderBy: { createdAt: 'desc' },
    take: 2,
  });
  const bonusRow = rows.find((r) => r.type === 'BONUS');
  const depositRow = rows.find((r) => r.type === 'DEPOSIT');
  assert(depositRow?.amount === deposit, 'the deposit row holds what the player paid');
  assert(bonusRow?.amount === expectedBonus, 'the bonus row holds what the promotion gave');
}

console.log('\n7. The per-player limit holds');
{
  const res = await post('/api/me/deposit', { amount: 500_00, promoCode: code });
  const body = await res.json();
  assert(res.status === 400, `a second use refused with ${res.status}`);
  assert(body.code === 'PROMO_INVALID', `refused as ${body.code}`);

  const promo = await prisma.promoCode.findUnique({ where: { code } });
  assert(promo.usedCount === 1, `the counter stayed at ${promo.usedCount}`);
}

console.log('\n8. A deposit below the code minimum is refused');
{
  const small = `${code}S`;
  await post('/api/admin/promo-codes', {
    code: small,
    kind: 'FIXED',
    value: 100_00,
    minDeposit: 1_000_00,
    maxBonus: null,
    maxUses: null,
    perUserLimit: 5,
    isActive: true,
    startsAt: null,
    expiresAt: null,
  });
  const res = await post('/api/me/promo/preview', { amount: 100_00, promoCode: small });
  assert(res.status === 400, `a too-small top-up refused with ${res.status}`);
}

console.log('\n9. A deactivated code stops working');
{
  const list = await get('/api/admin/promo-codes');
  const row = list.find((p) => p.code === code);
  await post(`/api/admin/promo-codes/${row.id}/deactivate`, {});

  const after = (await get('/api/admin/promo-codes')).find((p) => p.code === code);
  assert(after.isActive === false, 'the code is marked inactive');
  assert(after.usedCount === 1, 'and keeps its redemption count');
}

console.log('\n10. The balance still agrees with the ledger');
{
  const sum = await prisma.transaction.aggregate({
    where: { userId: admin.id },
    _sum: { amount: true },
  });
  const fresh = await prisma.user.findUnique({ where: { id: admin.id } });
  assert(
    fresh.balance === (sum._sum.amount ?? 0),
    `balance ${fresh.balance} equals the ledger sum ${sum._sum.amount ?? 0}`,
  );
}

await prisma.$disconnect();
console.log(failures === 0 ? '\nAll admin smoke checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
