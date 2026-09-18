import { Body, Controller, Headers, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { type AnalyticsCollectInput, analyticsCollectSchema } from '@caseforge/shared';
import { AnalyticsService } from './analytics.service';
import { Public } from '../auth/public.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/**
 * Where the browser reports what it did.
 *
 * Public, because most of what is worth measuring happens before anybody signs
 * in — a visitor who never gets past the landing page is the most important
 * row in a funnel. The account is picked up from the token when there is one,
 * which is what joins the anonymous top of the funnel to the signed-in bottom.
 */
@Controller('api/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Public()
  @Post('collect')
  collect(
    @Body(new ZodValidationPipe(analyticsCollectSchema)) body: AnalyticsCollectInput,
    @Req() request: FastifyRequest & { user?: { id: string } },
    @Headers('user-agent') userAgent?: string,
  ) {
    // The guard runs on every route, and on a @Public one it still attaches
    // the user when the request carried a valid token — so this is the signed
    // identity, never something the payload claimed.
    return this.analytics.collect(body, {
      userId: request.user?.id ?? null,
      userAgent: userAgent ?? null,
    });
  }
}
