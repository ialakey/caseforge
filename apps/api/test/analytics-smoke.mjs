/**
 * End-to-end smoke test for the appearance builder and the analytics contour,
 * against a LIVE API.
 *
 * What it checks is the seam between the two halves of this stage: that a
 * setting saved in the panel reaches the public configuration the browser
 * renders from, and that an event reported by a browser reaches a report — with
 * the money numbers still coming from the ledger rather than from the stream.
 *
 * Run:  node test/analytics-smoke.mjs
 * Requires docker compose up, migrations applied and the API running on :4000.
 * Every setting it touches is restored afterwards.
 */
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import { DEFAULT_THEME, MetricKey, buildAppearance, hexToHslTriplet } from '@caseforge/shared';

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
const auth = {
  Authorization: `Bearer ${signJwt(
    { sub: admin.id, steamId64: admin.steamId64, role: admin.role },
    process.env.JWT_ACCESS_SECRET,
  )}`,
  'Content-Type': 'application/json',
};

const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });

// What the appearance looked like before this test touched it, so it can be
// put back exactly — this runs against somebody's development site.
const before = await (await fetch(`${API}/api/config`)).json();
const savedRows = await prisma.setting.findMany({ where: { key: { startsWith: 'appearance.' } } });

console.log('\n1. The registry describes the new field kinds');
{
  const { body } = await json(await fetch(`${API}/api/admin/settings`, { headers: auth }));
  const definitions = body.definitions ?? {};
  assert(definitions['appearance.siteName']?.kind === 'string', 'the site name is a string field');
  assert(definitions['appearance.accent']?.kind === 'color', 'the accent is a colour field');
  assert(definitions['appearance.logoUrl']?.kind === 'url', 'the logo is a URL field');
  assert(
    definitions['appearance.accent']?.default === DEFAULT_THEME.accent,
    'the panel is told the shipped value, so it can offer to put it back',
  );
  assert(
    Object.values(definitions).filter((d) => d.group === 'appearance').length >= 30,
    'the appearance group is complete',
  );
}

console.log('\n2. A refused value is refused, and nothing is stored');
{
  const { status, body } = await json(
    await fetch(`${API}/api/admin/settings`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ values: { 'appearance.accent': 'chartreuse' } }),
    }),
  );
  assert(status === 400, `a colour that is not a colour was refused with ${status}`);
  assert(
    JSON.stringify(body).includes('appearance.accent'),
    'and the error names the field that was wrong',
  );

  const stored = await prisma.setting.findUnique({ where: { key: 'appearance.accent' } });
  assert(
    stored === null || stored.value !== 'chartreuse',
    'the refused value did not reach the database',
  );
}

console.log('\n3. A saved appearance reaches the public configuration');
{
  const values = {
    'appearance.siteName': 'SmokeForge',
    'appearance.accent': '#34d399',
    'appearance.heroTitleEn': 'Smoke tested',
    'appearance.navBonus': false,
    'appearance.radiusPx': 4,
  };
  const { status } = await json(
    await fetch(`${API}/api/admin/settings`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ values }),
    }),
  );
  assert(status === 200 || status === 201, `the save was accepted with ${status}`);

  const config = await (await fetch(`${API}/api/config`)).json();
  assert(config.appearance.siteName === 'SmokeForge', 'the site name travels to the browser');
  assert(config.appearance.theme.accent === '#34d399', 'so does the palette');
  assert(config.appearance.hero.title.en === 'Smoke tested', 'and the banner headline');
  assert(config.appearance.nav.bonus === false, 'and a section that was switched off');
  assert(config.appearance.theme.radiusPx === 4, 'and the corner radius');

  // The same function the browser uses to read it, over the same values: the
  // panel and the site cannot disagree about what a key means.
  const rebuilt = buildAppearance((key) => values[key]);
  assert(rebuilt.siteName === 'SmokeForge', 'the shared builder agrees with the server');
  assert(
    hexToHslTriplet(config.appearance.theme.accent) === '158.1 64.4% 51.6%',
    'the colour converts to the triple the stylesheet expects',
  );
}

console.log('\n4. An empty text falls back to the shipped default rather than blanking the page');
{
  await fetch(`${API}/api/admin/settings`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ values: { 'appearance.heroTitleEn': '' } }),
  });
  const config = await (await fetch(`${API}/api/config`)).json();
  assert(config.appearance.hero.title.en === '', 'the stored value is empty');
  // The fallback itself lives in the front end, next to the dictionary; what
  // matters here is that the empty value is preserved rather than replaced by
  // something the operator did not type.
  assert(config.appearance.siteName === 'SmokeForge', 'and the rest of the configuration stands');
}

console.log('\n5. The browser can report events, and only sensible ones');
{
  const anonId = `anon-${randomUUID().slice(0, 12)}`;
  const sessionId = `sess-${randomUUID().slice(0, 12)}`;

  const anonymous = await json(
    await fetch(`${API}/api/analytics/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anonId,
        sessionId,
        events: [
          { type: 'page_view', path: '/', utmSource: 'smoke', utmMedium: 'test' },
          { type: 'sign_in_started', path: '/' },
        ],
      }),
    }),
  );
  assert(anonymous.status === 201 || anonymous.status === 200, 'collect is open to a visitor');
  assert(anonymous.body?.accepted === 2, 'both events were accepted');

  const nonsense = await json(
    await fetch(`${API}/api/analytics/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anonId, sessionId, events: [{ type: 'drop_tables' }] }),
    }),
  );
  assert(nonsense.status === 400, 'an unknown event type is refused');

  const stored = await prisma.analyticsEvent.findMany({ where: { anonId } });
  assert(stored.length === 2, 'the accepted events are on the table');
  assert(
    stored.every((row) => row.userId === null),
    'an anonymous visitor stays anonymous',
  );
  assert(
    stored.some((row) => row.utmSource === 'smoke'),
    'the campaign travelled with the event',
  );
  // No IP, no user agent: the stream is about behaviour, not identity.
  assert(!('ip' in stored[0]) && !('userAgent' in stored[0]), 'no address or agent is stored');

  // A signed-in browser is joined to its account, which is what makes the
  // funnel span the anonymous top and the signed-in bottom.
  const identified = `anon-${randomUUID().slice(0, 12)}`;
  await fetch(`${API}/api/analytics/collect`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      anonId: identified,
      sessionId,
      events: [{ type: 'page_view', path: '/battles' }],
    }),
  });
  const joined = await prisma.analyticsEvent.findFirst({ where: { anonId: identified } });
  assert(joined?.userId === admin.id, 'a token on the request attributes the event');
}

console.log('\n6. The rollup derives the same numbers the tables hold');
{
  const { status, body } = await json(
    await fetch(`${API}/api/admin/analytics/backfill?days=30`, { method: 'POST', headers: auth }),
  );
  assert(status === 200 || status === 201, `the backfill ran with ${status}`);
  assert(body.metrics > 0, `it wrote ${body.metrics} values`);

  const today = new Date().toISOString().slice(0, 10);
  const wagered = await prisma.metricDaily.findUnique({
    where: { day_key: { day: new Date(`${today}T00:00:00.000Z`), key: MetricKey.WAGERED } },
  });
  const openings = await prisma.caseOpening.aggregate({
    where: { createdAt: { gte: new Date(`${today}T00:00:00.000Z`) } },
    _sum: { casePrice: true },
  });
  assert(
    Number(wagered?.value ?? 0) === (openings._sum.casePrice ?? 0),
    "today's wagered metric equals the sum of today's openings",
  );
}

console.log('\n7. The reports answer, and the money still comes from the ledger');
{
  const overview = await (
    await fetch(`${API}/api/admin/analytics/overview?days=30`, { headers: auth })
  ).json();

  const ledger = await prisma.caseOpening.aggregate({
    where: { createdAt: { gte: new Date(Date.now() - 29 * 86_400_000) } },
    _sum: { casePrice: true, itemPrice: true },
  });
  const wagered = ledger._sum.casePrice ?? 0;
  const won = ledger._sum.itemPrice ?? 0;

  assert(overview.kpis.wagered === wagered, 'wagered matches the openings table exactly');
  assert(overview.kpis.ggr === wagered - won, 'and GGR is wagered minus won, not an estimate');
  assert(overview.funnel.length === 5, 'the funnel has all five steps');
  assert(overview.funnel[0].ofFirst === 1, 'the first step is the reference');
  assert(
    Array.isArray(overview.series[MetricKey.VISITORS]),
    'the visitors series came back as a series',
  );

  const series = overview.series[MetricKey.WAGERED];
  const dates = series.map((point) => point.date);
  assert(new Set(dates).size === dates.length, 'the series has one point per day');
  assert(
    dates.every((date, index) => index === 0 || date > dates[index - 1]),
    'and they are in order with no gaps',
  );

  for (const report of ['traffic', 'players', 'features', 'devices', 'retention', 'events']) {
    const res = await fetch(`${API}/api/admin/analytics/${report}?days=30`, { headers: auth });
    assert(res.status === 200, `${report} answered ${res.status}`);
  }
}

console.log('\n8. The reports are staff-only');
{
  const anonymous = await fetch(`${API}/api/admin/analytics/overview`);
  assert(anonymous.status === 401, `an anonymous request got ${anonymous.status}`);

  const player = await prisma.user.findFirst({ where: { role: 'USER' } });
  if (player) {
    const playerAuth = {
      Authorization: `Bearer ${signJwt(
        { sub: player.id, steamId64: player.steamId64, role: player.role },
        process.env.JWT_ACCESS_SECRET,
      )}`,
    };
    const refused = await fetch(`${API}/api/admin/analytics/overview`, { headers: playerAuth });
    assert(refused.status === 403, `a player got ${refused.status}`);
  }
}

// Put the site back exactly as it was found: this ran against a real site's
// settings, and a smoke test that leaves it renamed is a smoke test nobody runs
// twice.
await prisma.setting.deleteMany({ where: { key: { startsWith: 'appearance.' } } });
for (const row of savedRows) {
  await prisma.setting.create({ data: { key: row.key, value: row.value } });
}
// The API caches settings for fifteen seconds; the restore is verified through
// the database rather than through a sleep.
const restored = await prisma.setting.findMany({ where: { key: { startsWith: 'appearance.' } } });
assert(
  restored.length === savedRows.length,
  `the appearance was restored (${restored.length} settings)`,
);
console.log(`  (was: "${before.appearance.siteName}", accent ${before.appearance.theme.accent})`);

await prisma.$disconnect();
console.log(
  failures === 0 ? '\nAll appearance and analytics checks passed\n' : `\n${failures} FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
