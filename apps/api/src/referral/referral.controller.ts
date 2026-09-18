import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { claimReferralSchema, setReferralCodeSchema } from '@caseforge/shared';
import { ReferralService } from './referral.service';
import { CurrentUser, type AuthenticatedUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@Controller('api/referral')
export class ReferralController {
  constructor(private readonly referral: ReferralService) {}

  /** The code, the live rates, the recruits and what they have earned. */
  @Get()
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.referral.summary(user.id);
  }

  /**
   * Applies an invite the browser was carrying.
   *
   * It is a separate call rather than part of sign-in because the invite is
   * known to the page and the page only runs again once the Steam round trip is
   * over. What stops it being abused later is the account-activity rule in the
   * service, not the timing of the call.
   */
  @Post('bind')
  bind(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(claimReferralSchema)) body: { code: string },
    @Req() request: FastifyRequest,
  ) {
    return this.referral.bind(user.id, body.code, request.ip ?? null);
  }

  @Post('code')
  setCode(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(setReferralCodeSchema)) body: { code: string },
  ) {
    return this.referral.setCode(user.id, body.code);
  }

  @Post('claim')
  claim(@CurrentUser() user: AuthenticatedUser) {
    return this.referral.claim(user.id);
  }
}
