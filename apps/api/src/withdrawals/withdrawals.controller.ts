import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { requestWithdrawalSchema } from '@caseforge/shared';
import { WithdrawalsService } from './withdrawals.service';
import { CurrentUser, type AuthenticatedUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@Controller('api/withdrawals')
export class WithdrawalsController {
  constructor(private readonly withdrawals: WithdrawalsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.withdrawals.list(user.id);
  }

  @Post()
  request(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(requestWithdrawalSchema)) body: { inventoryItemIds: string[] },
  ) {
    return this.withdrawals.request(user.id, body.inventoryItemIds);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.withdrawals.cancel(user.id, id);
  }
}
