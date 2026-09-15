import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  depositWithPromoSchema,
  promoCodeSchema,
  paginationSchema,
  setClientSeedSchema,
  tradeUrlSchema,
} from '@caseforge/shared';
import { UsersService } from './users.service';
import { PromoService } from '../promo/promo.service';
import { CurrentUser, type AuthenticatedUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const setTradeUrlSchema = z.object({ tradeUrl: tradeUrlSchema });

const previewPromoSchema = z.object({
  amount: z.number().int().min(1),
  promoCode: promoCodeSchema,
});

@Controller('api/me')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly promo: PromoService,
  ) {}

  @Get()
  profile(@CurrentUser() user: AuthenticatedUser) {
    return this.users.getProfile(user.id);
  }

  @Post('trade-url')
  setTradeUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(setTradeUrlSchema)) body: { tradeUrl: string },
  ) {
    return this.users.setTradeUrl(user.id, body.tradeUrl);
  }

  @Post('deposit')
  deposit(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(depositWithPromoSchema))
    body: { amount: number; promoCode?: string | null },
  ) {
    return this.users.deposit(user.id, body.amount, body.promoCode ?? null);
  }

  /** What a promo code would add to this top-up, before committing to it. */
  @Post('promo/preview')
  previewPromo(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(previewPromoSchema))
    body: { amount: number; promoCode: string },
  ) {
    return this.promo.preview(user.id, body.promoCode, body.amount);
  }

  @Get('seeds')
  seeds(@CurrentUser() user: AuthenticatedUser) {
    return this.users.getSeeds(user.id);
  }

  @Post('seeds/client')
  setClientSeed(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(setClientSeedSchema)) body: { clientSeed: string },
  ) {
    return this.users.setClientSeed(user.id, body.clientSeed);
  }

  @Post('seeds/rotate')
  rotateSeed(@CurrentUser() user: AuthenticatedUser) {
    return this.users.rotateServerSeed(user.id);
  }

  @Get('openings')
  openings(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(paginationSchema)) query: { page: number; perPage: number },
  ) {
    return this.users.getOpenings(user.id, query.page, query.perPage);
  }

  @Get('transactions')
  transactions(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(paginationSchema)) query: { page: number; perPage: number },
  ) {
    return this.users.getTransactions(user.id, query.page, query.perPage);
  }
}
