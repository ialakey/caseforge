import { Controller, Get } from '@nestjs/common';
import type { LiveDrop } from '@caseforge/shared';
import { Public } from '../auth/public.decorator';
import { DropsService } from './drops.service';

/**
 * The drop strip's opening state.
 *
 * The feed itself arrives over the socket, but the strip now sits above the
 * header on every page, and a component that renders empty and fills in a
 * moment later is a layout shift on every navigation. This endpoint is what
 * the server renders the strip from, so the first paint already has drops in
 * it and the socket only has to keep them moving.
 *
 * Public, and deliberately so: it returns what the feed has always shown to
 * anybody with the page open — a username, an item and a price.
 */
@Controller('api/drops')
export class DropsController {
  constructor(private readonly drops: DropsService) {}

  @Public()
  @Get()
  async feed(): Promise<{ recent: LiveDrop[]; best: LiveDrop | null }> {
    // Both at once: two round trips for one strip would be one too many, and
    // neither answer is worth a request of its own.
    const [recent, best] = await Promise.all([this.drops.recent(20), this.drops.bestOfDay()]);
    return { recent, best };
  }
}
