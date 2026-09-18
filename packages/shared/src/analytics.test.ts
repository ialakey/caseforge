import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  ANALYTICS_BATCH_MAX,
  AnalyticsEventType,
  MONEY_METRICS,
  METRIC_KEYS,
  analyticsCollectSchema,
  addDays,
  dayKey,
  fillSeries,
  funnel,
  niceMax,
  retention,
  seriesPath,
  share,
  weekKey,
} from './analytics.ts';

test('a batch is validated, capped and tied to one browser', () => {
  const ok = analyticsCollectSchema.safeParse({
    anonId: 'anon-12345678',
    sessionId: 'sess-12345678',
    events: [{ type: AnalyticsEventType.PAGE_VIEW, path: '/battles' }],
  });
  assert.equal(ok.success, true);

  const unknownType = analyticsCollectSchema.safeParse({
    anonId: 'anon-12345678',
    sessionId: 'sess-12345678',
    events: [{ type: 'delete_everything' }],
  });
  assert.equal(unknownType.success, false);

  const tooMany = analyticsCollectSchema.safeParse({
    anonId: 'anon-12345678',
    sessionId: 'sess-12345678',
    events: new Array(ANALYTICS_BATCH_MAX + 1).fill({ type: AnalyticsEventType.PAGE_VIEW }),
  });
  assert.equal(tooMany.success, false);

  const noId = analyticsCollectSchema.safeParse({
    anonId: 'short',
    sessionId: 'sess-12345678',
    events: [{ type: AnalyticsEventType.PAGE_VIEW }],
  });
  assert.equal(noId.success, false);
});

test('every money metric is a metric', () => {
  for (const key of MONEY_METRICS) {
    assert.ok(METRIC_KEYS.includes(key), `${key} is not in METRIC_KEYS`);
  }
});

test('days are UTC, so a report does not move when the operator does', () => {
  assert.equal(dayKey(new Date('2026-09-18T23:59:59Z')), '2026-09-18');
  assert.equal(dayKey(new Date('2026-09-19T00:00:01Z')), '2026-09-19');
  assert.equal(dayKey(addDays(new Date('2026-09-30T12:00:00Z'), 1)), '2026-10-01');
});

test('a series has no holes in it', () => {
  // A gap is drawn as a straight line across it, which says "no change" where
  // the truth is "no data".
  const series = fillSeries(
    [
      { date: '2026-09-16', value: 5 },
      { date: '2026-09-18', value: 7 },
    ],
    new Date('2026-09-15T00:00:00Z'),
    new Date('2026-09-18T00:00:00Z'),
  );
  assert.deepEqual(series, [
    { date: '2026-09-15', value: 0 },
    { date: '2026-09-16', value: 5 },
    { date: '2026-09-17', value: 0 },
    { date: '2026-09-18', value: 7 },
  ]);
});

test('a share survives an empty denominator', () => {
  assert.equal(share(3, 12), 0.25);
  assert.equal(share(0, 0), 0);
  assert.equal(share(5, 0), 0);
});

test('the funnel reports both conversions', () => {
  const steps = funnel([
    { key: 'visitors', count: 1000 },
    { key: 'signups', count: 200 },
    { key: 'deposited', count: 50 },
    { key: 'opened', count: 45 },
  ]);

  assert.equal(steps[0]!.ofFirst, 1);
  assert.equal(steps[0]!.ofPrevious, 1);
  assert.equal(steps[1]!.ofFirst, 0.2);
  assert.equal(steps[1]!.ofPrevious, 0.2);
  // The step that is actually leaking: a quarter of the people who signed up
  // paid, which is invisible if only the share of the top is shown.
  assert.equal(steps[2]!.ofFirst, 0.05);
  assert.equal(steps[2]!.ofPrevious, 0.25);
  assert.equal(steps[3]!.ofPrevious, 0.9);
});

test('an empty funnel does not divide by zero', () => {
  const steps = funnel([
    { key: 'visitors', count: 0 },
    { key: 'signups', count: 0 },
  ]);
  assert.deepEqual(
    steps.map((s) => [s.ofFirst, s.ofPrevious]),
    [
      [1, 1],
      [0, 0],
    ],
  );
});

test('a week starts on Monday', () => {
  assert.equal(weekKey(new Date('2026-09-18T10:00:00Z')), '2026-09-14'); // Friday
  assert.equal(weekKey(new Date('2026-09-14T00:00:00Z')), '2026-09-14'); // Monday itself
  assert.equal(weekKey(new Date('2026-09-20T23:00:00Z')), '2026-09-14'); // Sunday
  assert.equal(weekKey(new Date('2026-09-21T00:00:00Z')), '2026-09-21'); // next Monday
});

test('retention counts a player once per week, in the right column', () => {
  const rows = retention(
    [
      {
        signedUpAt: new Date('2026-09-14T09:00:00Z'),
        // Twice in week 0, once in week 2, nothing in week 1.
        activeAt: [
          new Date('2026-09-14T10:00:00Z'),
          new Date('2026-09-16T10:00:00Z'),
          new Date('2026-09-29T10:00:00Z'),
        ],
      },
      { signedUpAt: new Date('2026-09-15T09:00:00Z'), activeAt: [new Date('2026-09-15T10:00:00Z')] },
    ],
    4,
  );

  assert.equal(rows.length, 1, 'both players signed up in the same week');
  const row = rows[0]!;
  assert.equal(row.cohort, '2026-09-14');
  assert.equal(row.size, 2);
  assert.equal(row.weeks[0], 1, 'both were active in their first week');
  assert.equal(row.weeks[1], 0);
  assert.equal(row.weeks[2], 0.5, 'one of the two came back two weeks later');
});

test('activity before the cohort week is ignored rather than wrapped', () => {
  const rows = retention(
    [
      {
        signedUpAt: new Date('2026-09-21T09:00:00Z'),
        activeAt: [new Date('2026-09-10T10:00:00Z'), new Date('2026-09-22T10:00:00Z')],
      },
    ],
    3,
  );
  assert.deepEqual(rows[0]!.weeks, [1, 0, 0]);
});

test('an axis maximum is a number a human would have picked', () => {
  assert.equal(niceMax([0, 0]), 1);
  assert.equal(niceMax([3, 7]), 10);
  assert.equal(niceMax([731]), 1000);
  assert.equal(niceMax([120, 180]), 200);
  assert.equal(niceMax([0.4]), 0.5);
});

test('the series path spans the box and respects the maximum', () => {
  const path = seriesPath([0, 5, 10], 100, 50, 10);
  assert.equal(path, 'M 0 50 L 50 25 L 100 0');

  // One point is a flat line rather than a dot nobody can see.
  assert.equal(seriesPath([4], 100, 50, 10), 'M 0 30 L 100 30');
  assert.equal(seriesPath([], 100, 50), '');
});
