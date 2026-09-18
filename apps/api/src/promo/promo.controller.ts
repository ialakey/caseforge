import { Controller, Get } from '@nestjs/common';
import type { FeaturedPromo } from '@caseforge/shared';
import { Public } from '../auth/public.decorator';
import { PromoService } from './promo.service';

/**
 * The one promotion the landing page is allowed to show.
 *
 * Public, and narrow on purpose. It answers with a code only when an operator
 * has marked that code for the front page *and* it is still valid — most codes
 * are not for everybody, and one handed to a single streamer's audience must
 * never leak out of a list endpoint that seemed harmless.
 */
@Controller('api/promo')
export class PromoController {
  constructor(private readonly promo: PromoService) {}

  @Public()
  @Get('featured')
  async featured(): Promise<{ promo: FeaturedPromo | null }> {
    return { promo: await this.promo.featured() };
  }
}
