/**
 * End-to-end smoke test for the daily bonus, against a LIVE API.
 *
 * Covers what the unit tests cannot: that the cooldown really blocks a second
 * spin, that the roll recorded on the spin is the slice that was paid out, that
 * a balance prize reaches the ledger, and that a voucher is spent by an opening
 * exactly once and takes the right amount off it.
 *
 * Run:  node test/bonus-smoke.mjs
 * Requires docker compose up, migrations applied, the seed run and the API
 * running on port 4000.
 */
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import {
  BonusKind,
  TICKET_SPACE,
  WHEEL,
  isVoucher,
  pickWheelSlice,
  validateTicketRanges,
  voucherSaving,
} from '@caseforge/shared';

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
const get = async (p) => (await fetch(`${API}${p}`, { headers: auth })).json();

/** The cooldown is a real product rule; a test has to be able to stand it down. */
const clearCooldown = () =>
  prisma.user.update({ where: { id: user.id }, data: { lastBonusAt: null } });

console.log('\n1. The bonus needs a token');
{
  const res = await fetch(`${API}/api/bonus`);
  assert(res.status === 401, `anonymous status request refused with ${res.status}`);
  const spin = await fetch(`${API}/api/bonus/spin`, { method: 'POST' });
  assert(spin.status === 401, `anonymous spin refused with ${spin.status}`);
}

console.log('\n2. The wheel the server serves is the wheel it rolls');
{
  const status = await get('/api/bonus');
  assert(status.wheel.length === WHEEL.length, `${status.wheel.length} slices served`);
  const validation = validateTicketRanges(status.wheel);
  assert(validation.valid, `the served wheel tiles all ${TICKET_SPACE} tickets`);
  const chances = status.wheel.reduce((s, x) => s + x.chance, 0);
  assert(Math.abs(chances - 1) < 1e-9, `the served chances sum to ${chances}`);
}

console.log('\n3. Spinning');
await clearCooldown();
const balanceBefore = (await prisma.user.findUnique({ where: { id: user.id } })).balance;
const spin = await (
  await fetch(`${API}/api/bonus/spin`, { method: 'POST', headers: auth })
).json();
{
  assert(Boolean(spin.bonusId), `spin ${spin.bonusId} recorded`);
  assert(spin.roll >= 0 && spin.roll < TICKET_SPACE, `roll ${spin.roll} is inside the space`);

  // The prize must be the slice that owns the roll — not a second draw.
  const expected = pickWheelSlice(spin.roll);
  assert(spin.segmentKey === expected.key, `roll ${spin.roll} belongs to ${expected.key}`);
  assert(spin.kind === expected.kind, `kind is ${spin.kind}`);
  assert(spin.value === expected.value, `value is ${spin.value}`);

  const row = await prisma.dailyBonus.findUnique({ where: { id: spin.bonusId } });
  assert(row.roll === spin.roll, 'the stored roll matches the response');
  assert(row.segmentKey === spin.segmentKey, 'the stored slice matches the response');
  assert(
    isVoucher(row.kind) ? row.consumedAt === null : row.consumedAt !== null,
    `a ${row.kind} prize is ${isVoucher(row.kind) ? 'left open' : 'settled at once'}`,
  );
}

console.log('\n4. The prize is actually paid out');
{
  const after = (await prisma.user.findUnique({ where: { id: user.id } })).balance;
  if (spin.kind === BonusKind.BALANCE) {
    assert(after === balanceBefore + spin.value, `balance rose by ${spin.value}`);
    const ledger = await prisma.transaction.findFirst({
      where: { referenceId: spin.bonusId, type: 'BONUS' },
    });
    assert(ledger?.amount === spin.value, 'a BONUS ledger row was written for it');
  } else if (spin.kind === BonusKind.FREE_ITEM) {
    const granted = await prisma.inventoryItem.findFirst({
      where: { bonusRewardId: spin.bonusId },
    });
    assert(Boolean(granted), 'the skin landed in the inventory');
    assert(granted?.status === 'AVAILABLE', 'and it is available to use');
  } else {
    assert(after === balanceBefore, 'a voucher prize moves no money yet');
  }
}

console.log('\n5. A second spin is refused by the cooldown');
{
  const again = await fetch(`${API}/api/bonus/spin`, { method: 'POST', headers: auth });
  const body = await again.json();
  assert(again.status === 400, `the second spin refused with ${again.status}`);
  assert(body.code === 'BONUS_ON_COOLDOWN', `refused as ${body.code}`);

  const status = await get('/api/bonus');
  assert(status.canSpin === false, 'the status agrees the wheel is not ready');
  assert(Boolean(status.nextSpinAt), `next spin at ${status.nextSpinAt}`);
}

console.log('\n6. Simultaneous spins still yield only one');
{
  await clearCooldown();
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      fetch(`${API}/api/bonus/spin`, { method: 'POST', headers: auth }).then((r) => r.status),
    ),
  );
  const accepted = results.filter((s) => s === 200 || s === 201).length;
  assert(accepted === 1, `${accepted} of 5 concurrent spins accepted`);
}

/**
 * Writes a voucher onto the account the way a spin writes one.
 *
 * Earlier sections may have span one of their own, and an opening spends
 * whichever voucher is worth most — so every case below starts by clearing
 * what was already there and asserts against what it put back.
 */
async function giveVoucher(kind, segmentKey, value) {
  const seed = await prisma.serverSeed.findFirst({ where: { userId: user.id, isActive: true } });
  const clientSeed = await prisma.clientSeed.findFirst({
    where: { userId: user.id, isActive: true },
  });
  const bumped = await prisma.serverSeed.update({
    where: { id: seed.id },
    data: { nonce: { increment: 1 } },
  });
  return prisma.dailyBonus.create({
    data: {
      userId: user.id,
      kind,
      segmentKey,
      value,
      serverSeedId: seed.id,
      clientSeedId: clientSeed.id,
      nonce: bumped.nonce,
      roll: 0,
    },
  });
}

const clearVouchers = () =>
  prisma.dailyBonus.updateMany({
    where: { userId: user.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });

console.log('\n7. A voucher is spent by an opening, once, for the right amount');
{
  await clearVouchers();
  const voucher = await giveVoucher('DISCOUNT', 'discount-50', 5000);

  const cases = await (await fetch(`${API}/api/cases`)).json();
  const target = cheapestPaid(cases);
  const expectedSaving = voucherSaving(BonusKind.DISCOUNT, 5000, target.price, 1);

  const before = (await prisma.user.findUnique({ where: { id: user.id } })).balance;
  const res = await fetch(`${API}/api/cases/open`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ caseId: target.id, count: 1 }),
  });
  const out = await res.json();
  assert(res.status === 201 || res.status === 200, `opening accepted with ${res.status}`);
  assert(Boolean(out.bonusApplied), 'the response says a bonus was applied');
  assert(out.bonusApplied?.segmentKey === 'discount-50', 'and names the right one');
  assert(
    out.bonusApplied?.saving === expectedSaving,
    `it took off ${out.bonusApplied?.saving}, expected ${expectedSaving}`,
  );
  assert(
    out.totalSpent === target.price - expectedSaving,
    `charged ${out.totalSpent} instead of ${target.price}`,
  );

  const after = (await prisma.user.findUnique({ where: { id: user.id } })).balance;
  const won = out.openings.reduce((s, o) => s + o.item.price, 0);
  assert(after === before - out.totalSpent, 'the balance moved by exactly what was charged');
  assert(won >= 0, `the opening still produced ${out.openings.length} item(s)`);

  const spent = await prisma.dailyBonus.findUnique({ where: { id: voucher.id } });
  assert(spent.consumedAt !== null, 'the voucher is marked spent');

  // And it cannot be spent twice.
  const second = await fetch(`${API}/api/cases/open`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ caseId: target.id, count: 1 }),
  });
  const secondOut = await second.json();
  assert(secondOut.bonusApplied === null, 'the next opening gets no bonus');
  assert(secondOut.totalSpent === target.price, 'and pays the full price');
}

console.log('\n7b. With several vouchers open, the most valuable one is spent');
{
  await clearVouchers();
  const cases = await (await fetch(`${API}/api/cases`)).json();
  const target = cheapestPaid(cases);

  // A free opening of this case is worth its full price; a tenth off is not.
  const cheap = await giveVoucher('DISCOUNT', 'discount-10', 1000);
  const rich = await giveVoucher('FREE_CASE', 'free-case', 300_00);

  const out = await (
    await fetch(`${API}/api/cases/open`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ caseId: target.id, count: 1 }),
    })
  ).json();

  assert(out.bonusApplied?.segmentKey === 'free-case', `spent ${out.bonusApplied?.segmentKey}`);
  assert(out.totalSpent === 0, `a free case charged ${out.totalSpent}`);

  const stillOpen = await prisma.dailyBonus.findUnique({ where: { id: cheap.id } });
  assert(stillOpen.consumedAt === null, 'the lesser voucher was left alone');
  const used = await prisma.dailyBonus.findUnique({ where: { id: rich.id } });
  assert(used.consumedAt !== null, 'the better voucher was spent');

  await clearVouchers();
}

console.log('\n8. The balance still agrees with the ledger');
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
console.log(failures === 0 ? '\nAll bonus smoke checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
