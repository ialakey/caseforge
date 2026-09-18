/**
 * Security smoke test, against a LIVE API.
 *
 * Not a penetration test — it is the set of protections that are easy to
 * remove by accident. A body limit lifted to make one upload work, a header
 * plugin dropped during a refactor, a route that stops checking the role it
 * used to check: each of those is a one-line change that nothing else in the
 * suite would notice, and each of them is the whole defence for something.
 *
 * Run:  node test/security-smoke.mjs
 * Requires docker compose up, migrations applied, the seed run and the API
 * running on port 4000.
 */
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
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

const adminToken = signJwt(
  { sub: admin.id, steamId64: admin.steamId64, role: admin.role },
  process.env.JWT_ACCESS_SECRET,
);
// The same account, claiming a role it does not have. Signed with the real
// secret, so this is not a forgery test — it is the question of whether the
// back office believes the claim, which it should, and whether the role it
// finds there is enough, which it should not be.
const playerToken = signJwt(
  { sub: admin.id, steamId64: admin.steamId64, role: 'USER' },
  process.env.JWT_ACCESS_SECRET,
);

console.log('\n1. Headers a browser needs whether or not anybody asked for them');
{
  const res = await fetch(`${API}/api/config`);
  const h = (name) => res.headers.get(name) ?? '';

  assert(h('x-content-type-options') === 'nosniff', 'content types are not sniffed');
  assert(h('content-security-policy').includes("default-src 'none'"), 'nothing loads by default');
  assert(h('content-security-policy').includes("frame-ancestors 'none'"), 'and nothing frames it');
  assert(h('strict-transport-security').includes('max-age='), 'HTTPS is remembered');
  assert(h('referrer-policy') === 'no-referrer', 'the referrer is not passed on');
  // The one header that must NOT be restrictive: the site is a separate origin.
  assert(h('cross-origin-resource-policy') === 'cross-origin', 'the web app may still read it');
}

console.log('\n2. SQL is not built out of what the caller sent');
{
  const payloads = [
    "'; DROP TABLE users; --",
    "' OR '1'='1",
    '1; SELECT pg_sleep(10)--',
    "%27%20UNION%20SELECT%20NULL--",
  ];

  for (const payload of payloads) {
    const res = await fetch(`${API}/api/cases/${encodeURIComponent(payload)}`);
    // 404 is the right answer: it was looked up as a slug and there is no such
    // case. A 500 would mean the string reached the database as syntax.
    assert(res.status === 404, `slug ${JSON.stringify(payload.slice(0, 20))} → ${res.status}`);
  }

  const search = await fetch(
    `${API}/api/admin/items?search=${encodeURIComponent("' OR 1=1 --")}&perPage=5`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );
  const body = await search.json();
  assert(search.status === 200, `a search for injection syntax answers ${search.status}`);
  assert(Array.isArray(body.items) && body.items.length === 0, 'and finds nothing, rather than everything');

  // The point of the whole section: the table the payloads asked to drop.
  assert((await prisma.user.count()) > 0, 'the users table is still there');
}

console.log('\n3. An id is an id');
{
  const res = await fetch(`${API}/api/users/not-a-uuid`);
  assert(res.status === 400, `a malformed id is refused with ${res.status}`);

  const missing = await fetch(`${API}/api/users/00000000-0000-4000-8000-000000000000`);
  assert(missing.status === 404, `an id nobody owns is a plain 404 (${missing.status})`);
}

console.log('\n4. A role is not a claim the caller gets to make');
{
  const anonymous = await fetch(`${API}/api/admin/users`);
  assert(anonymous.status === 401, `the back office refuses a stranger with ${anonymous.status}`);

  const asPlayer = await fetch(`${API}/api/admin/users`, {
    headers: { Authorization: `Bearer ${playerToken}` },
  });
  assert(asPlayer.status === 403, `and a signed-in player with ${asPlayer.status}`);

  // Same token, one character of the signature changed.
  const tampered = adminToken.slice(0, -1) + (adminToken.at(-1) === 'a' ? 'b' : 'a');
  const forged = await fetch(`${API}/api/admin/users`, {
    headers: { Authorization: `Bearer ${tampered}` },
  });
  assert(forged.status === 401, `an edited token is refused with ${forged.status}`);
}

console.log('\n5. Bodies have a ceiling, and one route has a higher one');
{
  const twoMegabytes = 'A'.repeat(2 * 1024 * 1024);
  const post = (path, body) =>
    fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const ordinary = await post('/api/analytics/collect', { padding: twoMegabytes });
  assert(ordinary.status === 413, `two megabytes to an ordinary route → ${ordinary.status}`);

  // Unauthenticated, so this cannot succeed — but a 401 means the body was
  // read and only then refused, which is the thing being checked.
  const upload = await post('/api/kyc', {
    fullName: 'Smoke Test',
    dateOfBirth: '1990-01-01',
    country: 'RU',
    documentNo: '1234567',
    documents: [{ kind: 'PASSPORT', contentType: 'image/png', base64: twoMegabytes }],
  });
  assert(upload.status !== 413, `the same two megabytes to the KYC route → ${upload.status}`);

  const huge = await post('/api/kyc', {
    fullName: 'Smoke Test',
    dateOfBirth: '1990-01-01',
    country: 'RU',
    documentNo: '1234567',
    documents: [{ kind: 'PASSPORT', contentType: 'image/png', base64: 'A'.repeat(13 * 1024 * 1024) }],
  });
  assert(huge.status === 413, `thirteen megabytes there → ${huge.status}`);
}

console.log('\n6. Analytics counts the address, not the name the caller chose');
{
  const redis = new Redis(process.env.REDIS_URL);
  const key = 'ratelimit:analytics:127.0.0.1';
  await redis.del(key);

  for (let i = 0; i < 3; i++) {
    await fetch(`${API}/api/analytics/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // A different anonId every time, which is what a script would do.
      body: JSON.stringify({
        anonId: `smoke-anon-${i}-xxxxxxxx`,
        sessionId: `smoke-session-${i}-xxxxxxxx`,
        events: [{ type: 'page_view', path: '/' }],
      }),
    });
  }

  const counted = Number(await redis.get(key));
  assert(counted === 3, `three rotating identities landed in one bucket (${counted})`);

  await redis.del(key);
  await prisma.analyticsEvent.deleteMany({ where: { anonId: { startsWith: 'smoke-anon-' } } });
  await redis.quit();
}

// Last, because it leaves the address throttled for the rest of the window.
console.log('\n7. There is a ceiling on requests');
{
  const redis = new Redis(process.env.REDIS_URL);
  const key = 'ratelimit:http:127.0.0.1';
  await redis.del(key);

  let throttled = 0;
  let statuses = new Set();
  // Sequential on one connection: fast enough to finish well inside the
  // window, which a parallel burst is not guaranteed to be on a slow box.
  for (let i = 0; i < 360; i++) {
    const res = await fetch(`${API}/api/config`);
    statuses.add(res.status);
    if (res.status === 429) throttled += 1;
    if (throttled > 3) break;
  }

  assert(throttled > 0, `the limiter fired (${throttled} refusals, statuses ${[...statuses]})`);

  const res = await fetch(`${API}/api/config`);
  assert(res.headers.get('retry-after') !== null, 'and says when to come back');

  // Health is how an operator knows the site is up; throttling it would turn a
  // busy minute into a restart.
  const health = await fetch(`${API}/api/health`);
  assert(health.status === 200, `health answers anyway (${health.status})`);

  // Put the address back, or every other test on this machine starts at 429.
  await redis.del(key);
  await redis.quit();
}

console.log(failures === 0 ? '\nAll security checks passed' : `\n${failures} check(s) FAILED`);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);
