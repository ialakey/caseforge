import { Controller, Get, Post, Query } from '@nestjs/common';
import { paginationSchema } from '@caseforge/shared';
import { BonusService } from './bonus.service';
import { CurrentUser, type AuthenticatedUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@Controller('api/bonus')
export class BonusController {
  constructor(private readonly bonus: BonusService) {}

  /** The wheel, the cooldown and any unspent vouchers. */
  @Get()
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.bonus.status(user.id);
  }

  @Post('spin')
  spin(@CurrentUser() user: AuthenticatedUser) {
    return this.bonus.spin(user.id);
  }

  @Get('history')
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(paginationSchema)) query: { page: number; perPage: number },
  ) {
    return this.bonus.history(user.id, query.page, query.perPage);
  }
}
