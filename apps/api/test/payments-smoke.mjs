/**
 * End-to-end smoke test for the payment port, against a LIVE API.
 *
 * The webhook is the one endpoint on this site that moves money without an
 * authenticated caller, so it is the one most worth testing outside the unit
 * suite. What is checked here cannot be checked in isolation: that an unsigned
 * notification is refused, that a signed one credits exactly once however many
 * times the provider sends it, and that a confirmation for less money than was
 * asked is refused rather than credited short.
 *
 * Run:  node test/payments-smoke.mjs
 * Requires docker compose up, migrations applied, the seed run and the API
 * running on port 4000.
 */
import path from 'node:path';
import { createHmac } from 'node:crypto';
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

/**
 * The signature the stub provider expects.
 *
 * Derived exactly as the adapter derives it — the domain string is what keeps
 * the webhook key from being the session key.
 */
function signWebhook(rawBody) {
  const key = createHmac('sha256', process.env.JWT_ACCESS_SECRET)
    .update('caseforge:stub-payment-webhook')
    .digest();
  return createHmac('sha256', key).update(rawBody).digest('hex');
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

const balance = async () =>
  (await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { balance: true } }))
    .balance;

const notify = (payload) => {
  const rawBody = JSON.stringify(payload);
  return fetch(`${API}/api/payments/webhook/stub`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-signature': signWebhook(rawBody) },
    body: rawBody,
  });
};

const AMOUNT = 250_00;

console.log('\n1. The stub provider is offered');
{
  const res = await fetch(`${API}/api/payments/providers`, { headers: auth });
  const body = await res.json();
  assert(res.status === 200, `providers answered ${res.status}`);
  assert(body.providers.includes('stub'), `stub is available (${body.providers.join(', ')})`);
}

console.log('\n2. Creating a payment does not move the balance');
let paymentId;
{
  const before = await balance();
  const res = await fetch(`${API}/api/payments`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ amount: AMOUNT }),
  });
  const body = await res.json();
  paymentId = body.paymentId;

  assert(res.status === 201 || res.status === 200, `create answered ${res.status}`);
  assert(typeof body.redirectUrl === 'string', 'it hands back somewhere to pay');
  assert((await balance()) === before, 'the balance is untouched until the money is confirmed');

  const row = await prisma.payment.findUnique({ where: { id: paymentId } });
  assert(row?.status === 'PENDING', `the record starts PENDING (${row?.status})`);
}

console.log('\n3. An unsigned notification is refused');
{
  const before = await balance();
  const res = await fetch(`${API}/api/payments/webhook/stub`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-signature': 'not-a-signature' },
    body: JSON.stringify({ paymentId, outcome: 'succeeded', amount: AMOUNT }),
  });
  assert(res.status === 401, `a forged signature is refused with ${res.status}`);
  assert((await balance()) === before, 'and credits nothing');
}

console.log('\n4. A short confirmation is refused rather than credited short');
{
  const short = await prisma.payment.create({
    data: { userId: user.id, provider: 'stub', amount: AMOUNT, status: 'PENDING' },
  });
  await prisma.payment.update({
    where: { id: short.id },
    data: { providerRef: short.id },
  });

  const before = await balance();
  const res = await notify({ paymentId: short.id, outcome: 'succeeded', amount: AMOUNT - 100_00 });
  assert(res.status === 200, `answered ${res.status}`);
  assert((await balance()) === before, 'a short payment credits nothing');

  const row = await prisma.payment.findUnique({ where: { id: short.id } });
  assert(row?.status === 'FAILED', `and is marked FAILED (${row?.status})`);
}

console.log('\n5. A signed confirmation credits exactly once');
{
  const before = await balance();

  const first = await notify({ paymentId, outcome: 'succeeded', amount: AMOUNT });
  assert(first.status === 200, `the first notification answered ${first.status}`);
  assert((await balance()) === before + AMOUNT, 'the balance moved by the amount paid');

  // Providers retry. The second delivery has to be a no-op, not a second
  // credit — this is the assertion the whole idempotency design exists for.
  const second = await notify({ paymentId, outcome: 'succeeded', amount: AMOUNT });
  assert(second.status === 200, `a repeat delivery still answers ${second.status}`);
  assert((await balance()) === before + AMOUNT, 'and does not credit twice');

  const entries = await prisma.transaction.count({
    where: { userId: user.id, comment: { contains: paymentId } },
  });
  assert(entries === 1, `exactly one ledger entry for the payment (${entries})`);
}

console.log('\n6. A notification about an unknown payment is acknowledged, not acted on');
{
  const before = await balance();
  const res = await notify({
    paymentId: '00000000-0000-0000-0000-000000000000',
    outcome: 'succeeded',
    amount: AMOUNT,
  });
  // 200 on purpose: a 4xx would have the provider retrying for a week over
  // something this site has no record of.
  assert(res.status === 200, `answered ${res.status}`);
  assert((await balance()) === before, 'and credited nothing');
}

console.log(failures === 0 ? '\nAll payment checks passed' : `\n${failures} check(s) FAILED`);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);
