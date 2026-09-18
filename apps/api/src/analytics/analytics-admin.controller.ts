import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { UserRole, paginationSchema } from '@caseforge/shared';
import { AnalyticsService } from './analytics.service';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/**
 * The reporting half of the panel.
 *
 * Readable by an analyst — that is the role's whole purpose — while the
 * backfill, which rewrites history, stays with an administrator.
 *
 * Every endpoint takes the same period and defaults it the same way, because a
 * dashboard whose tiles and charts cover different ranges is a dashboard that
 * tells two stories.
 */
const periodSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** Convenience for the panel's period chips: "last N days", inclusive. */
  days: z.coerce.number().int().min(1).max(365).optional(),
});

const retentionSchema = z.object({ weeks: z.coerce.number().int().min(2).max(26).default(8) });
const backfillSchema = z.object({ days: z.coerce.number().int().min(1).max(400).default(30) });
const eventsSchema = paginationSchema.extend({ type: z.string().trim().max(60).optional() });

function resolvePeriod(query: z.infer<typeof periodSchema>): { from: Date; to: Date } {
  const to = query.to ?? new Date();
  const days = query.days ?? 30;
  const from = query.from ?? new Date(to.getTime() - (days - 1) * 86_400_000);
  return { from, to };
}

@Controller('api/admin/analytics')
@UseGuards(RolesGuard)
@Roles(UserRole.ANALYST)
export class AnalyticsAdminController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  overview(@Query(new ZodValidationPipe(periodSchema)) query: z.infer<typeof periodSchema>) {
    const { from, to } = resolvePeriod(query);
    return this.analytics.overview(from, to);
  }

  @Get('traffic')
  traffic(@Query(new ZodValidationPipe(periodSchema)) query: z.infer<typeof periodSchema>) {
    const { from, to } = resolvePeriod(query);
    return this.analytics.traffic(from, to);
  }

  @Get('players')
  players(@Query(new ZodValidationPipe(periodSchema)) query: z.infer<typeof periodSchema>) {
    const { from, to } = resolvePeriod(query);
    return this.analytics.players(from, to);
  }

  @Get('features')
  features(@Query(new ZodValidationPipe(periodSchema)) query: z.infer<typeof periodSchema>) {
    const { from, to } = resolvePeriod(query);
    return this.analytics.features(from, to);
  }

  @Get('devices')
  devices(@Query(new ZodValidationPipe(periodSchema)) query: z.infer<typeof periodSchema>) {
    const { from, to } = resolvePeriod(query);
    return this.analytics.devices(from, to);
  }

  @Get('retention')
  retention(@Query(new ZodValidationPipe(retentionSchema)) query: { weeks: number }) {
    return this.analytics.retention(query.weeks);
  }

  @Get('events')
  events(
    @Query(new ZodValidationPipe(eventsSchema))
    query: {
      page: number;
      perPage: number;
      type?: string;
    },
  ) {
    return this.analytics.events(query.page, query.perPage, query.type);
  }

  /**
   * Rebuilds the daily rollups from the tables that hold the truth.
   *
   * Needed once after the analytics tables are created — the history exists in
   * `case_openings` and `transactions`, it has simply never been summarised —
   * and after any change to how a metric is computed.
   */
  @Post('backfill')
  @Roles(UserRole.ADMIN)
  backfill(@Query(new ZodValidationPipe(backfillSchema)) query: { days: number }) {
    return this.analytics.backfill(query.days);
  }
}
