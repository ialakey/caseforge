import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  type DepositQuote,
  type ItemDepositView,
  createItemDepositSchema,
  type CreateItemDepositInput,
} from '@caseforge/shared';
import { CurrentUser, type AuthenticatedUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ItemDepositsService } from './item-deposits.service';

/**
 * Depositing skins.
 *
 * Every route is authenticated and scoped to the caller: an inventory, a quote
 * and a request all belong to one player, and none of them takes a user id
 * from the body. A deposit endpoint that accepted "whose" as a parameter is
 * one mistake away from crediting the wrong account.
 */
@Controller('api/deposits/items')
export class ItemDepositsController {
  constructor(private readonly deposits: ItemDepositsService) {}

  /** The caller's Steam inventory, priced at the current payout rate. */
  @Get('inventory')
  inventory(@CurrentUser() user: AuthenticatedUser): Promise<DepositQuote> {
    return this.deposits.quote(user.id);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<ItemDepositView[]> {
    return this.deposits.list(user.id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createItemDepositSchema)) body: CreateItemDepositInput,
  ): Promise<ItemDepositView> {
    return this.deposits.create(user.id, body.assetIds);
  }

  @Post(':id/cancel')
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ItemDepositView> {
    return this.deposits.cancel(user.id, id);
  }
}
