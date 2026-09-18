import { Controller, Get } from '@nestjs/common';
import type { SiteStats } from '@caseforge/shared';
import { Public } from '../auth/public.decorator';
import { SiteStatsService } from './site-stats.service';

/**
 * The counters along the top of the landing page.
 *
 * Public and cached. Everything here is already visible by other means — how
 * many cases the site has opened is in the drop feed, how many players it has
 * is not a secret — and the numbers exist to say the place is alive.
 */
@Controller('api/stats')
export class SiteStatsController {
  constructor(private readonly stats: SiteStatsService) {}

  @Public()
  @Get()
  get(): Promise<SiteStats> {
    return this.stats.get();
  }
}
