import { Body, Controller, Get, Post } from '@nestjs/common';
import { sellItemsSchema } from '@caseforge/shared';
import { InventoryService } from './inventory.service';
import { CurrentUser, type AuthenticatedUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@Controller('api/inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.inventory.list(user.id);
  }

  @Post('sell')
  sell(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(sellItemsSchema)) body: { inventoryItemIds: string[] },
  ) {
    return this.inventory.sell(user.id, body.inventoryItemIds);
  }
}
