/**
 * Load generator, against a LIVE API.
 *
 * Dependency-free on purpose: the repository has no load-testing tool and
 * adding one would be a binary everybody has to install before they can
 * reproduce a number. Node can saturate a local API perfectly well, and being
 * in-repo means the scenarios are the site's own rather than a generic
 * "hit / with 100 VUs".
 *
 * What it measures is the thing the roadmap's spike is about: how the read
 * paths behave when thousands of people are looking at the same catalogue, and
 * what the write path costs when they start opening cases.
 *
 *   node test/load.mjs                                   # 20s browse, 50 concurrent
 *   node test/load.mjs --scenario=mixed --concurrency=100 --duration=30
 *   node test/load.mjs --scenario=open --users=20
 *
 * Scenarios:
 *   browse   public reads only — catalogue, config, lobby, health
 *   open     the write path: one case opened per request, per throwaway player
 *   battles  two throwaway players create and fill a two-round battle
 *   mixed    four parts browse to one part open
 *
 * Caveats worth stating before anybody quotes a number from this: the
 * generator shares the machine with the API and the database, so it competes
 * with what it is measuring, and one Node process is a ceiling of its own.
 * Treat the numbers as comparative — before and after a change — rather than
 * as capacity.
 */
import path from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';

config({ path: path.join(import.meta.dirname, '../../../.env') });

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith('--'))
    .map((arg) => {
      const [key, value = 'true'] = arg.slice(2).split('=');
      return [key, value];
    }),
);

const API = args.api ?? 'http://localhost:4000';
const SCENARIO = args.scenario ?? 'browse';
const CONCURRENCY = Number(args.concurrency ?? 50);
const DURATION_SEC = Number(args.duration ?? 20);
const USERS = Number(args.users ?? 10);

const SCENARIOS = ['browse', 'open', 'battles', 'mixed'];
if (!SCENARIOS.includes(SCENARIO)) {
  console.error(`Unknown scenario "${SCENARIO}". One of: ${SCENARIOS.join(', ')}`);
  process.exit(1);
}

/** HS256 by hand — see the note in smoke.mjs. */
function signJwt(payload, secret, ttlSeconds = 3600) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ ...payload, iat: now, exp: now + ttlSeconds });
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const prisma = new PrismaClient();
const createdUsers = [];

/**
 * A throwaway player, funded through the ledger so the nightly reconciliation
 * still agrees while the test runs.
 */
async function makePlayer(balance) {
  const steamId64 = `7656119${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;
  const user = await prisma.user.create({
    data: { steamId64, username: `load-${randomUUID().slice(0, 8)}`, balance },
  });
  const seed = randomBytes(32).toString('hex');
  await prisma.serverSeed.create({
    data: {
      userId: user.id,
      seed,
      seedHash: createHash('sha256').update(seed).digest('hex'),
      isActive: true,
    },
  });
  await prisma.clientSeed.create({
    data: { userId: user.id, seed: randomBytes(8).toString('hex'), isActive: true },
  });
  await prisma.transaction.create({
    data: {
      userId: user.id,
      type: 'ADMIN_ADJUSTMENT',
      amount: balance,
      balanceAfter: balance,
      comment: 'load test float',
    },
  });
  createdUsers.push(user.id);

  return {
    id: user.id,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signJwt(
        { sub: user.id, steamId64: user.steamId64, role: user.role },
        process.env.JWT_ACCESS_SECRET,
      )}`,
    },
  };
}

// --- measurement -----------------------------------------------------------

/**
 * Latencies are kept per label rather than aggregated on the fly: percentiles
 * need the distribution, and a mean would hide exactly what a spike does to a
 * site — the tail.
 */
const stats = new Map();

function record(label, ms, status) {
  let entry = stats.get(label);
  if (!entry) {
    entry = { latencies: [], statuses: new Map() };
    stats.set(label, entry);
  }
  entry.latencies.push(ms);
  entry.statuses.set(status, (entry.statuses.get(status) ?? 0) + 1);
}

async function call(label, url, init) {
  const started = performance.now();
  try {
    const res = await fetch(url, init);
    // The body has to be drained, or keep-alive stalls on the next request.
    await res.arrayBuffer();
    record(label, performance.now() - started, res.status);
  } catch (err) {
    record(label, performance.now() - started, `error:${err?.cause?.code ?? 'fetch'}`);
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function report(elapsedSec) {
  const rows = [];
  let total = 0;
  let failed = 0;

  for (const [label, entry] of [...stats.entries()].sort()) {
    const sorted = [...entry.latencies].sort((a, b) => a - b);
    const ok = entry.statuses.get(200) ?? 0;
    const created = entry.statuses.get(201) ?? 0;
    const bad = sorted.length - ok - created;
    total += sorted.length;
    failed += bad;

    rows.push({
      endpoint: label,
      n: sorted.length,
      rps: +(sorted.length / elapsedSec).toFixed(1),
      p50: +percentile(sorted, 50).toFixed(1),
      p90: +percentile(sorted, 90).toFixed(1),
      p99: +percentile(sorted, 99).toFixed(1),
      max: +sorted[sorted.length - 1].toFixed(1),
      nonOk: bad,
    });
  }

  console.log(
    `\n${SCENARIO}: ${CONCURRENCY} concurrent, ${elapsedSec.toFixed(1)}s, ` +
      `${total} requests, ${(total / elapsedSec).toFixed(1)} rps, ${failed} non-2xx\n`,
  );
  console.table(rows);

  // Status codes other than 200/201 are printed in full: a load test where a
  // third of the requests are 429 is a rate-limit measurement, and reading it
  // as latency is how people conclude a site is fast when it is refusing work.
  for (const [label, entry] of [...stats.entries()].sort()) {
    const odd = [...entry.statuses.entries()].filter(([code]) => code !== 200 && code !== 201);
    if (odd.length > 0) {
      console.log(`  ${label}: ${odd.map(([code, n]) => `${code}×${n}`).join(', ')}`);
    }
  }
}

// --- scenarios -------------------------------------------------------------

const cases = await (await fetch(`${API}/api/cases`)).json();
if (!Array.isArray(cases) || cases.length === 0) {
  console.error('No cases in the catalogue — run pnpm seed:cases');
  process.exit(1);
}
const cheapest = [...cases].sort((a, b) => a.price - b.price)[0];

async function browseOnce() {
  const pick = Math.random();
  if (pick < 0.55) return call('GET /api/cases', `${API}/api/cases`);
  if (pick < 0.75) return call('GET /api/cases/:slug', `${API}/api/cases/${cheapest.slug}`);
  if (pick < 0.9) return call('GET /api/battles', `${API}/api/battles`);
  if (pick < 0.97) return call('GET /api/config', `${API}/api/config`);
  return call('GET /api/health', `${API}/api/health`);
}

function openOnce(player) {
  return call('POST /api/cases/open', `${API}/api/cases/open`, {
    method: 'POST',
    headers: player.headers,
    body: JSON.stringify({ caseId: cheapest.id, count: 1 }),
  });
}

async function battleOnce(host, rival) {
  const started = performance.now();
  let created;
  try {
    const res = await fetch(`${API}/api/battles`, {
      method: 'POST',
      headers: host.headers,
      body: JSON.stringify({ slots: 2, cases: [{ caseId: cheapest.id, count: 2 }] }),
    });
    created = await res.json();
    record('POST /api/battles', performance.now() - started, res.status);
  } catch (err) {
    record('POST /api/battles', performance.now() - started, `error:${err?.cause?.code ?? 'fetch'}`);
    return;
  }
  if (!created?.battle?.id) return;

  await call('POST /api/battles/:id/join', `${API}/api/battles/${created.battle.id}/join`, {
    method: 'POST',
    headers: rival.headers,
  });
}

// --- the run ---------------------------------------------------------------

const needsPlayers = SCENARIO !== 'browse';
const players = [];
if (needsPlayers) {
  // Enough float that the run ends on the clock rather than on an empty
  // balance: a scenario that spends out halfway through measures the error
  // path for the second half.
  const float = cheapest.price * 4 * Math.ceil((DURATION_SEC * CONCURRENCY) / Math.max(USERS, 1));
  for (let i = 0; i < USERS; i++) players.push(await makePlayer(Math.max(float, 100_000)));
  console.log(`Created ${players.length} throwaway players`);
}

console.log(
  `Hammering ${API} — scenario ${SCENARIO}, ${CONCURRENCY} concurrent, ${DURATION_SEC}s\n` +
    'The generator shares this machine with the API, so read the numbers as comparative.',
);

const deadline = Date.now() + DURATION_SEC * 1000;
const runStarted = performance.now();

/**
 * One worker is a loop, not a burst: the concurrency is the number of requests
 * in flight, which is what a queue in front of the database actually sees.
 */
async function worker(index) {
  const host = players[index % Math.max(players.length, 1)];
  const rival = players[(index + 1) % Math.max(players.length, 1)];

  while (Date.now() < deadline) {
    switch (SCENARIO) {
      case 'browse':
        await browseOnce();
        break;
      case 'open':
        await openOnce(host);
        break;
      case 'battles':
        await battleOnce(host, rival);
        break;
      case 'mixed':
        if (index % 5 === 0) await openOnce(host);
        else await browseOnce();
        break;
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
report((performance.now() - runStarted) / 1000);

// The throwaway players take their openings, items, battles and ledger rows
// with them.
if (createdUsers.length > 0) {
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  console.log(`\nRemoved ${createdUsers.length} throwaway players and everything they did`);
}
await prisma.$disconnect();
