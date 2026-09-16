import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  type InventoryFilter,
  type PriceBandKey,
  inventoryQuerySchema,
  sellAllSchema,
  sellItemsSchema,
} from '@caseforge/shared';
import { InventoryService } from './inventory.service';
import { CurrentUser, type AuthenticatedUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@Controller('api/inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(inventoryQuerySchema))
    query: { filter: InventoryFilter; band: PriceBandKey },
  ) {
    return this.inventory.list(user.id, query.filter, query.band);
  }

  /** Counts and totals per tab, for the filter chips. */
  @Get('summary')
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.inventory.summary(user.id);
  }

  @Post('sell')
  sell(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(sellItemsSchema)) body: { inventoryItemIds: string[] },
  ) {
    return this.inventory.sell(user.id, body.inventoryItemIds);
  }

  @Post('sell-all')
  sellAll(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(sellAllSchema)) body: { band: PriceBandKey },
  ) {
    return this.inventory.sellAll(user.id, body.band);
  }
}
