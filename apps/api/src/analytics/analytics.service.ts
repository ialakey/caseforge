import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import {
  type AnalyticsCollectInput,
  type AnalyticsKpis,
  type AnalyticsOverview,
  type FeatureRow,
  type PlayerRow,
  type RetentionRow,
  type TimeSeriesPoint,
  type TrafficRow,
  AnalyticsEventType,
  ErrorCode,
  MetricKey,
  METRIC_KEYS,
  addDays,
  dayKey,
  fillSeries,
  funnel,
  retention,
  share,
} from '@caseforge/shared';
import { PrismaService } from '../common/prisma.service';
import { PRISMA_READ } from '../common/prisma-read';
import { REDIS_CLIENT } from '../common/redis.module';
import { badRequest } from '../common/app-error';

/**
 * How many events one browser may report per minute.
 *
 * Generous — a page view, a click and a batch flush are a handful — and it is
 * not really about abuse: an endpoint that writes a row per call and is open to
 * the internet needs a ceiling, or a loop in somebody's console fills the
 * table.
 */
const COLLECT_PER_MINUTE = 120;

/** How far back a backfill will go in one call. */
const MAX_BACKFILL_DAYS = 400;

/** Cohorts in the retention grid, and how many weeks wide it is. */
const RETENTION_WEEKS = 8;

type DayRow = { day: Date } & Record<string, unknown>;

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Every report reads through here: a month of aggregates over
    // `case_openings` is the heaviest query the site makes, and it must not run
    // on the connection that is settling battles.
    @Inject(PRISMA_READ) private readonly read: PrismaClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // -------------------------------------------------------------- ingest

  /**
   * Records a batch of browser events.
   *
   * Written with one `createMany`, and deliberately without a transaction:
   * these are observations, not facts about money. Losing one is a rounding
   * error in a traffic report; making a visitor wait for a durable write is a
   * slower site for no benefit.
   */
  async collect(
    input: AnalyticsCollectInput,
    context: { userId: string | null; userAgent: string | null },
  ): Promise<{ accepted: number }> {
    await this.enforceRateLimit(input.anonId, input.events.length);

    const device = deviceFromUserAgent(context.userAgent);

    await this.prisma.analyticsEvent.createMany({
      data: input.events.map((event) => ({
        type: event.type,
        anonId: input.anonId,
        sessionId: input.sessionId,
        userId: context.userId,
        // Only a path, never a full URL: a caller that could write
        // "https://example.com/evil" into a report would be writing the report.
        path: event.path?.startsWith('/') ? event.path.slice(0, 512) : null,
        referrer: event.referrer ?? null,
        utmSource: event.utmSource ?? null,
        utmMedium: event.utmMedium ?? null,
        utmCampaign: event.utmCampaign ?? null,
        device,
        meta: (event.meta ?? undefined) as Prisma.InputJsonValue | undefined,
      })),
    });

    return { accepted: input.events.length };
  }

  private async enforceRateLimit(anonId: string, count: number): Promise<void> {
    const key = `ratelimit:analytics:${anonId}`;
    try {
      const used = await this.redis.incrby(key, count);
      if (used === count) await this.redis.expire(key, 60);
      if (used > COLLECT_PER_MINUTE) {
        throw badRequest(ErrorCode.RATE_LIMITED, 'Too many events');
      }
    } catch (err) {
      // A Redis outage must not stop the site reporting page views; the limit
      // is a guard rail, not a feature.
      if (err instanceof Error && err.name === 'BadRequestException') throw err;
      this.logger.warn(`Analytics rate limit unavailable: ${String(err)}`);
    }
  }

  // -------------------------------------------------------------- rollups

  /**
   * Yesterday, once it is over.
   *
   * Three in the morning UTC rather than midnight: a day is closed by then in
   * every timezone the site sees traffic from, and the nightly reconciliation
   * already has four o'clock.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async rollupYesterday(): Promise<void> {
    const yesterday = addDays(new Date(), -1);
    const written = await this.rollupRange(yesterday, yesterday);
    this.logger.log(`Rolled up ${dayKey(yesterday)}: ${written} metrics`);
  }

  /**
   * Recomputes every metric for a range of days.
   *
   * One grouped query per family of metrics rather than one per metric per day:
   * a thirty-day backfill is nine statements, not five hundred. The rows for
   * the range are replaced wholesale, which is what makes the operation
   * idempotent — a rollup that ran twice must not double a total, and a metric
   * that was renamed must not leave its old rows behind.
   */
  async rollupRange(from: Date, to: Date): Promise<number> {
    const start = new Date(`${dayKey(from)}T00:00:00.000Z`);
    const end = addDays(new Date(`${dayKey(to)}T00:00:00.000Z`), 1);

    const perDay = new Map<string, Map<string, number>>();
    const put = (day: string, key: string, value: number): void => {
      const row = perDay.get(day) ?? new Map<string, number>();
      row.set(key, value);
      perDay.set(day, row);
    };
    const num = (value: unknown): number => Number(value ?? 0);

    const events = await this.read.$queryRaw<DayRow[]>`
      SELECT date_trunc('day', "createdAt")::date AS day,
             COUNT(DISTINCT "anonId") AS visitors,
             COUNT(DISTINCT "sessionId") AS sessions,
             COUNT(*) FILTER (WHERE type = ${AnalyticsEventType.PAGE_VIEW}) AS page_views
      FROM analytics_events
      WHERE "createdAt" >= ${start} AND "createdAt" < ${end}
      GROUP BY 1
    `;
    for (const row of events) {
      const day = dayKey(row.day);
      put(day, MetricKey.VISITORS, num(row.visitors));
      put(day, MetricKey.SESSIONS, num(row.sessions));
      put(day, MetricKey.PAGE_VIEWS, num(row.page_views));
    }

    const signups = await this.read.$queryRaw<DayRow[]>`
      SELECT date_trunc('day', "createdAt")::date AS day, COUNT(*) AS signups
      FROM users WHERE "createdAt" >= ${start} AND "createdAt" < ${end} GROUP BY 1
    `;
    for (const row of signups) put(dayKey(row.day), MetricKey.SIGNUPS, num(row.signups));

    const openings = await this.read.$queryRaw<DayRow[]>`
      SELECT date_trunc('day', "createdAt")::date AS day,
             COUNT(*) AS openings,
             COALESCE(SUM("casePrice"), 0) AS wagered,
             COALESCE(SUM("itemPrice"), 0) AS won,
             COUNT(DISTINCT "userId") AS players
      FROM case_openings
      WHERE "createdAt" >= ${start} AND "createdAt" < ${end}
      GROUP BY 1
    `;
    for (const row of openings) {
      const day = dayKey(row.day);
      put(day, MetricKey.OPENINGS, num(row.openings));
      put(day, MetricKey.WAGERED, num(row.wagered));
      put(day, MetricKey.WON, num(row.won));
      put(day, MetricKey.GGR, num(row.wagered) - num(row.won));
      put(day, MetricKey.ACTIVE_PLAYERS, num(row.players));
    }

    const money = await this.read.$queryRaw<DayRow[]>`
      SELECT date_trunc('day', "createdAt")::date AS day, type,
             COUNT(*) AS entries, COALESCE(SUM(amount), 0) AS total
      FROM transactions
      WHERE "createdAt" >= ${start} AND "createdAt" < ${end}
        AND type IN ('DEPOSIT', 'ITEM_SELL')
      GROUP BY 1, 2
    `;
    for (const row of money) {
      const day = dayKey(row.day);
      if (row.type === 'DEPOSIT') {
        put(day, MetricKey.DEPOSIT_COUNT, num(row.entries));
        put(day, MetricKey.DEPOSIT_TOTAL, num(row.total));
      } else {
        put(day, MetricKey.SELL_TOTAL, num(row.total));
      }
    }

    // Withdrawals are counted on the day they completed, not the day they were
    // asked for: the money leaves when the item does.
    const withdrawals = await this.read.$queryRaw<DayRow[]>`
      SELECT date_trunc('day', "completedAt")::date AS day,
             COUNT(*) AS entries, COALESCE(SUM("totalValue"), 0) AS total
      FROM withdrawals
      WHERE status = 'COMPLETED' AND "completedAt" >= ${start} AND "completedAt" < ${end}
      GROUP BY 1
    `;
    for (const row of withdrawals) {
      const day = dayKey(row.day);
      put(day, MetricKey.WITHDRAWAL_COUNT, num(row.entries));
      put(day, MetricKey.WITHDRAWAL_TOTAL, num(row.total));
    }

    const battles = await this.read.$queryRaw<DayRow[]>`
      SELECT date_trunc('day', "createdAt")::date AS day, COUNT(*) AS battles
      FROM battles WHERE "createdAt" >= ${start} AND "createdAt" < ${end} GROUP BY 1
    `;
    for (const row of battles) put(dayKey(row.day), MetricKey.BATTLES, num(row.battles));

    const seats = await this.read.$queryRaw<DayRow[]>`
      SELECT date_trunc('day', "joinedAt")::date AS day, COUNT(*) AS seats
      FROM battle_players WHERE "joinedAt" >= ${start} AND "joinedAt" < ${end} GROUP BY 1
    `;
    for (const row of seats) put(dayKey(row.day), MetricKey.BATTLE_ENTRIES, num(row.seats));

    const spins = await this.read.$queryRaw<DayRow[]>`
      SELECT date_trunc('day', "createdAt")::date AS day, COUNT(*) AS spins
      FROM daily_bonuses WHERE "createdAt" >= ${start} AND "createdAt" < ${end} GROUP BY 1
    `;
    for (const row of spins) put(dayKey(row.day), MetricKey.BONUS_SPINS, num(row.spins));

    // Promo bonuses come from the redemption rows rather than the ledger: the
    // BONUS entry type also carries the wheel, and a report that cannot tell a
    // promotion from a prize cannot say what the promotion cost.
    const promo = await this.read.$queryRaw<DayRow[]>`
      SELECT date_trunc('day', "createdAt")::date AS day, COALESCE(SUM("bonusAmount"), 0) AS total
      FROM promo_redemptions WHERE "createdAt" >= ${start} AND "createdAt" < ${end} GROUP BY 1
    `;
    for (const row of promo) put(dayKey(row.day), MetricKey.PROMO_BONUS, num(row.total));

    const referral = await this.read.$queryRaw<DayRow[]>`
      SELECT date_trunc('day', "createdAt")::date AS day, COALESCE(SUM(amount), 0) AS total
      FROM referral_earnings WHERE "createdAt" >= ${start} AND "createdAt" < ${end} GROUP BY 1
    `;
    for (const row of referral) put(dayKey(row.day), MetricKey.REFERRAL_ACCRUED, num(row.total));

    // Every day in the range gets a full set of rows, zeros included: a missing
    // row and a zero are the same thing to a reader, and only one of them makes
    // the chart's gap-filling unnecessary.
    const data: Prisma.MetricDailyCreateManyInput[] = [];
    for (let cursor = new Date(start); cursor < end; cursor = addDays(cursor, 1)) {
      const day = dayKey(cursor);
      const row = perDay.get(day) ?? new Map<string, number>();
      for (const key of METRIC_KEYS) {
        data.push({ day: new Date(`${day}T00:00:00.000Z`), key, value: BigInt(row.get(key) ?? 0) });
      }
    }

    await this.prisma.$transaction([
      this.prisma.metricDaily.deleteMany({ where: { day: { gte: start, lt: end } } }),
      this.prisma.metricDaily.createMany({ data }),
    ]);

    return data.length;
  }

  /** Rebuilds the history from the tables that hold it. */
  async backfill(days: number): Promise<{ days: number; metrics: number }> {
    const span = Math.min(Math.max(1, Math.trunc(days)), MAX_BACKFILL_DAYS);
    const metrics = await this.rollupRange(addDays(new Date(), -span), new Date());
    this.logger.log(`Backfilled ${span} days: ${metrics} metrics`);
    return { days: span, metrics };
  }

  // -------------------------------------------------------------- reports

  /**
   * The dashboard in one response.
   *
   * The headline numbers are computed over the whole range while the charts
   * come from the daily rollups, and that is not duplication but the only
   * correct arrangement: **a sum of daily uniques is not a unique.** Somebody
   * who visited on Monday and Tuesday is two daily visitors and one visitor,
   * and a KPI that added the chart up would overcount every returning player.
   */
  async overview(from: Date, to: Date): Promise<AnalyticsOverview> {
    // The requested range usually ends today, and today's rollup was written
    // last night with no data in it. Refreshing it here is nine grouped
    // queries over one day, and it is what lets one code path serve both the
    // chart and the history.
    if (dayKey(to) >= dayKey(new Date())) {
      await this.rollupRange(new Date(), new Date()).catch((err) =>
        this.logger.warn(`Could not refresh today's rollup: ${String(err)}`),
      );
    }

    const spanDays = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1);
    const previousFrom = addDays(from, -spanDays);
    const previousTo = addDays(from, -1);

    const [kpis, previous, series, steps] = await Promise.all([
      this.kpis(from, to),
      this.kpis(previousFrom, previousTo),
      this.series(from, to),
      this.funnelSteps(from, to),
    ]);

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      kpis,
      previous,
      series,
      funnel: steps,
    };
  }

  /** Every rolled-up metric as a gap-free daily series. */
  async series(from: Date, to: Date): Promise<Record<string, TimeSeriesPoint[]>> {
    const rows = await this.read.metricDaily.findMany({
      where: { day: { gte: new Date(`${dayKey(from)}T00:00:00.000Z`), lte: to } },
      orderBy: { day: 'asc' },
    });

    const byKey = new Map<string, TimeSeriesPoint[]>();
    for (const row of rows) {
      const list = byKey.get(row.key) ?? [];
      list.push({ date: dayKey(row.day), value: Number(row.value) });
      byKey.set(row.key, list);
    }

    return Object.fromEntries(
      METRIC_KEYS.map((key) => [key, fillSeries(byKey.get(key) ?? [], from, to)]),
    );
  }

  /**
   * The headline numbers, computed over the range itself.
   *
   * Distinct counts are the reason this is not a sum over `series`: see the
   * note on `overview`.
   */
  async kpis(from: Date, to: Date): Promise<AnalyticsKpis> {
    const period = { gte: from, lte: to };

    const [
      traffic,
      signups,
      openings,
      players,
      deposits,
      withdrawals,
      battles,
      spins,
      promo,
      referral,
    ] = await Promise.all([
      this.read.$queryRaw<Array<{ visitors: bigint; sessions: bigint; views: bigint }>>`
          SELECT COUNT(DISTINCT "anonId") AS visitors,
                 COUNT(DISTINCT "sessionId") AS sessions,
                 COUNT(*) FILTER (WHERE type = ${AnalyticsEventType.PAGE_VIEW}) AS views
          FROM analytics_events WHERE "createdAt" >= ${from} AND "createdAt" <= ${to}
        `,
      this.read.user.count({ where: { createdAt: period } }),
      this.read.caseOpening.aggregate({
        where: { createdAt: period },
        _sum: { casePrice: true, itemPrice: true },
        _count: true,
      }),
      this.read.$queryRaw<Array<{ players: bigint }>>`
          SELECT COUNT(DISTINCT "userId") AS players
          FROM case_openings WHERE "createdAt" >= ${from} AND "createdAt" <= ${to}
        `,
      this.read.transaction.aggregate({
        where: { type: 'DEPOSIT', createdAt: period },
        _sum: { amount: true },
        _count: true,
      }),
      this.read.withdrawal.aggregate({
        where: { status: 'COMPLETED', completedAt: period },
        _sum: { totalValue: true },
        _count: true,
      }),
      this.read.battle.count({ where: { createdAt: period } }),
      this.read.dailyBonus.count({ where: { createdAt: period } }),
      this.read.promoRedemption.aggregate({
        where: { createdAt: period },
        _sum: { bonusAmount: true },
      }),
      this.read.referralEarning.aggregate({
        where: { createdAt: period },
        _sum: { amount: true },
      }),
    ]);

    const wagered = openings._sum.casePrice ?? 0;
    const won = openings._sum.itemPrice ?? 0;
    const activePlayers = Number(players[0]?.players ?? 0);
    const ggr = wagered - won;

    return {
      visitors: Number(traffic[0]?.visitors ?? 0),
      sessions: Number(traffic[0]?.sessions ?? 0),
      pageViews: Number(traffic[0]?.views ?? 0),
      signups,
      activePlayers,
      openings: openings._count,
      wagered,
      won,
      ggr,
      actualRtp: share(won, wagered),
      deposits: { count: deposits._count, total: deposits._sum.amount ?? 0 },
      withdrawals: {
        count: withdrawals._count,
        total: withdrawals._sum.totalValue ?? 0,
      },
      battles,
      bonusSpins: spins,
      promoBonus: promo._sum.bonusAmount ?? 0,
      referralAccrued: referral._sum.amount ?? 0,
      // Per active player rather than per visitor: it is the number that says
      // whether the people who play are worth acquiring.
      arppu: activePlayers > 0 ? Math.round(ggr / activePlayers) : 0,
    };
  }

  /**
   * Visit to withdrawal.
   *
   * The top step is the only one that comes from the event stream; everything
   * below it is a distinct count over the tables that hold the money. That
   * seam is the whole design: behaviour from events, facts from the ledger.
   */
  private async funnelSteps(from: Date, to: Date) {
    const period = { gte: from, lte: to };

    const [visitors, signups, deposited, played, withdrew] = await Promise.all([
      this.read.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(DISTINCT "anonId") AS count
        FROM analytics_events WHERE "createdAt" >= ${from} AND "createdAt" <= ${to}
      `,
      this.read.user.count({ where: { createdAt: period } }),
      this.read.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(DISTINCT "userId") AS count FROM transactions
        WHERE type = 'DEPOSIT' AND "createdAt" >= ${from} AND "createdAt" <= ${to}
      `,
      this.read.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(DISTINCT "userId") AS count FROM case_openings
        WHERE "createdAt" >= ${from} AND "createdAt" <= ${to}
      `,
      this.read.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(DISTINCT "userId") AS count FROM withdrawals
        WHERE "createdAt" >= ${from} AND "createdAt" <= ${to}
      `,
    ]);

    return funnel([
      { key: 'visitors', count: Number(visitors[0]?.count ?? 0) },
      { key: 'signups', count: signups },
      { key: 'deposited', count: Number(deposited[0]?.count ?? 0) },
      { key: 'played', count: Number(played[0]?.count ?? 0) },
      { key: 'withdrew', count: Number(withdrew[0]?.count ?? 0) },
    ]);
  }

  /** Where the traffic came from, and what it was worth. */
  async traffic(from: Date, to: Date): Promise<TrafficRow[]> {
    const rows = await this.read.$queryRaw<
      Array<{
        source: string | null;
        medium: string | null;
        campaign: string | null;
        visitors: bigint;
        signups: bigint;
      }>
    >`
      SELECT COALESCE(e."utmSource", CASE WHEN e.referrer IS NULL OR e.referrer = '' THEN 'direct' ELSE 'referral' END) AS source,
             COALESCE(e."utmMedium", '') AS medium,
             COALESCE(e."utmCampaign", '') AS campaign,
             COUNT(DISTINCT e."anonId") AS visitors,
             -- A signup is attributed to a source when the account was created
             -- inside the period the traffic arrived in; anything else would
             -- credit today's campaign with last month's players.
             COUNT(DISTINCT u.id) FILTER (WHERE u."createdAt" >= ${from} AND u."createdAt" <= ${to}) AS signups
      FROM analytics_events e
      LEFT JOIN users u ON u.id = e."userId"
      WHERE e."createdAt" >= ${from} AND e."createdAt" <= ${to}
      GROUP BY 1, 2, 3
      ORDER BY visitors DESC
      LIMIT 40
    `;

    return rows.map((row) => ({
      source: row.source ?? 'direct',
      medium: row.medium ?? '',
      campaign: row.campaign ?? '',
      visitors: Number(row.visitors),
      signups: Number(row.signups),
      conversion: share(Number(row.signups), Number(row.visitors)),
    }));
  }

  /** The players who move the numbers. */
  async players(from: Date, to: Date, limit = 20): Promise<PlayerRow[]> {
    const rows = await this.read.$queryRaw<
      Array<{
        userId: string;
        username: string;
        avatarUrl: string | null;
        openings: bigint;
        wagered: bigint;
        won: bigint;
        deposits: bigint;
        withdrawals: bigint;
        lastSeenAt: Date | null;
      }>
    >`
      SELECT u.id AS "userId", u.username, u."avatarUrl",
             COUNT(o.id) AS openings,
             COALESCE(SUM(o."casePrice"), 0) AS wagered,
             COALESCE(SUM(o."itemPrice"), 0) AS won,
             COALESCE((SELECT SUM(t.amount) FROM transactions t
                       WHERE t."userId" = u.id AND t.type = 'DEPOSIT'
                         AND t."createdAt" >= ${from} AND t."createdAt" <= ${to}), 0) AS deposits,
             COALESCE((SELECT SUM(w."totalValue") FROM withdrawals w
                       WHERE w."userId" = u.id AND w.status = 'COMPLETED'
                         AND w."completedAt" >= ${from} AND w."completedAt" <= ${to}), 0) AS withdrawals,
             MAX(o."createdAt") AS "lastSeenAt"
      FROM users u
      JOIN case_openings o ON o."userId" = u.id
        AND o."createdAt" >= ${from} AND o."createdAt" <= ${to}
      GROUP BY u.id, u.username, u."avatarUrl"
      ORDER BY wagered DESC
      LIMIT ${limit}
    `;

    return rows.map((row) => ({
      userId: row.userId,
      username: row.username,
      avatarUrl: row.avatarUrl,
      openings: Number(row.openings),
      wagered: Number(row.wagered),
      won: Number(row.won),
      ggr: Number(row.wagered) - Number(row.won),
      deposits: Number(row.deposits),
      withdrawals: Number(row.withdrawals),
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    }));
  }

  /**
   * Which features people actually use, and what each is worth.
   *
   * GGR per feature is the question a roadmap is decided on, and it cannot be
   * answered by counting clicks: the upgrade consumes an item and returns
   * another, the contract consumes several, a battle moves the pot between
   * players. Each row is measured in its own terms, and the column says so.
   */
  async features(from: Date, to: Date): Promise<FeatureRow[]> {
    const period = { gte: from, lte: to };

    const [solo, battles, upgrades, contracts, bonuses] = await Promise.all([
      this.read.$queryRaw<Array<{ users: bigint; events: bigint; wagered: bigint; won: bigint }>>`
        SELECT COUNT(DISTINCT "userId") AS users, COUNT(*) AS events,
               COALESCE(SUM("casePrice"), 0) AS wagered, COALESCE(SUM("itemPrice"), 0) AS won
        FROM case_openings
        WHERE "battleId" IS NULL AND "createdAt" >= ${from} AND "createdAt" <= ${to}
      `,
      this.read.$queryRaw<Array<{ users: bigint; events: bigint; wagered: bigint; won: bigint }>>`
        SELECT COUNT(DISTINCT "userId") AS users, COUNT(*) AS events,
               COALESCE(SUM("casePrice"), 0) AS wagered, COALESCE(SUM("itemPrice"), 0) AS won
        FROM case_openings
        WHERE "battleId" IS NOT NULL AND "createdAt" >= ${from} AND "createdAt" <= ${to}
      `,
      this.read.upgrade.aggregate({
        where: { createdAt: period },
        _sum: { stakeValue: true },
        _count: true,
      }),
      this.read.contract.aggregate({
        where: { createdAt: period },
        _sum: { stakeValue: true, rewardValue: true },
        _count: true,
      }),
      this.read.dailyBonus.aggregate({ where: { createdAt: period }, _count: true }),
    ]);

    const upgradeUsers = await this.read.upgrade.findMany({
      where: { createdAt: period },
      select: { userId: true },
      distinct: ['userId'],
    });
    const contractUsers = await this.read.contract.findMany({
      where: { createdAt: period },
      select: { userId: true },
      distinct: ['userId'],
    });
    const bonusUsers = await this.read.dailyBonus.findMany({
      where: { createdAt: period },
      select: { userId: true },
      distinct: ['userId'],
    });

    // An upgrade's margin is not (stake - reward): a lost upgrade keeps the
    // stake and a won one hands over an item worth more. The site's take is the
    // expected margin on the staked value, which is what the RTP constant is,
    // so it is reported as the stake against the value returned by outcome.
    const wonUpgrades = await this.read.upgrade.aggregate({
      where: { createdAt: period, status: 'WON' },
      _sum: { targetValue: true },
    });

    return [
      {
        feature: 'cases',
        users: Number(solo[0]?.users ?? 0),
        events: Number(solo[0]?.events ?? 0),
        wagered: Number(solo[0]?.wagered ?? 0),
        ggr: Number(solo[0]?.wagered ?? 0) - Number(solo[0]?.won ?? 0),
      },
      {
        feature: 'battles',
        users: Number(battles[0]?.users ?? 0),
        events: Number(battles[0]?.events ?? 0),
        wagered: Number(battles[0]?.wagered ?? 0),
        ggr: Number(battles[0]?.wagered ?? 0) - Number(battles[0]?.won ?? 0),
      },
      {
        feature: 'upgrade',
        users: upgradeUsers.length,
        events: upgrades._count,
        wagered: upgrades._sum.stakeValue ?? 0,
        ggr: (upgrades._sum.stakeValue ?? 0) - (wonUpgrades._sum.targetValue ?? 0),
      },
      {
        feature: 'contracts',
        users: contractUsers.length,
        events: contracts._count,
        wagered: contracts._sum.stakeValue ?? 0,
        ggr: (contracts._sum.stakeValue ?? 0) - (contracts._sum.rewardValue ?? 0),
      },
      {
        feature: 'bonus',
        users: bonusUsers.length,
        events: bonuses._count,
        wagered: 0,
        // The wheel only ever costs the site money; that is what it is for.
        ggr: 0,
      },
    ];
  }

  /**
   * Weekly retention by sign-up cohort.
   *
   * Bounded by the cohort window rather than by a page: the query pulls one row
   * per player who signed up inside it, with the weeks they played in, and the
   * grid is assembled by the shared function that the tests pin down. Past a
   * few hundred thousand players in the window this wants to become a grouped
   * query in SQL; the window is what keeps it honest until then.
   */
  async retention(weeks = RETENTION_WEEKS): Promise<RetentionRow[]> {
    const from = addDays(new Date(), -weeks * 7);

    const rows = await this.read.$queryRaw<Array<{ signedUpAt: Date; weeks: Date[] | null }>>`
      SELECT u."createdAt" AS "signedUpAt",
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT date_trunc('week', o."createdAt")), NULL) AS weeks
      FROM users u
      LEFT JOIN case_openings o ON o."userId" = u.id
      WHERE u."createdAt" >= ${from}
      GROUP BY u.id, u."createdAt"
    `;

    return retention(
      rows.map((row) => ({ signedUpAt: row.signedUpAt, activeAt: row.weeks ?? [] })),
      weeks,
    );
  }

  /** The raw stream, for when a number in a report needs explaining. */
  async events(page: number, perPage: number, type?: string) {
    const where = type ? { type } : {};
    const [total, rows] = await Promise.all([
      this.read.analyticsEvent.count({ where }),
      this.read.analyticsEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        include: { user: { select: { username: true } } },
      }),
    ]);

    return {
      total,
      page,
      perPage,
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        path: row.path,
        referrer: row.referrer,
        source: row.utmSource,
        device: row.device,
        username: row.user?.username ?? null,
        anonId: row.anonId,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /** Devices, for deciding what the interface has to work on. */
  async devices(from: Date, to: Date): Promise<Array<{ device: string; visitors: number }>> {
    const rows = await this.read.$queryRaw<Array<{ device: string | null; visitors: bigint }>>`
      SELECT COALESCE(device, 'unknown') AS device, COUNT(DISTINCT "anonId") AS visitors
      FROM analytics_events
      WHERE "createdAt" >= ${from} AND "createdAt" <= ${to}
      GROUP BY 1 ORDER BY visitors DESC
    `;
    return rows.map((row) => ({ device: row.device ?? 'unknown', visitors: Number(row.visitors) }));
  }
}

/**
 * The device class, from the user agent.
 *
 * Coarse on purpose: the question the panel answers is "does the interface have
 * to work on a phone", and that has three answers. Storing the raw string
 * instead would be storing a fingerprint to answer the same question.
 */
export function deviceFromUserAgent(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  if (/ipad|tablet|playbook|silk/.test(ua)) return 'tablet';
  if (/mobi|iphone|android.*mobile|windows phone/.test(ua)) return 'mobile';
  return 'desktop';
}
