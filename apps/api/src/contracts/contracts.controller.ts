import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { contractPreviewSchema, contractSchema, paginationSchema } from '@caseforge/shared';
import { ContractsService } from './contracts.service';
import { CurrentUser, type AuthenticatedUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@Controller('api/contracts')
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  /** Inventory items available to stake. */
  @Get('stakes')
  stakes(@CurrentUser() user: AuthenticatedUser) {
    return this.contracts.listStakes(user.id);
  }

  /** The outcome table for a stake, with nothing consumed. */
  @Get('preview')
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(contractPreviewSchema))
    query: { inventoryItemIds: string[] },
  ) {
    return this.contracts.preview(user.id, query.inventoryItemIds);
  }

  @Post()
  run(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(contractSchema)) body: { inventoryItemIds: string[] },
  ) {
    return this.contracts.run(user.id, body.inventoryItemIds);
  }

  @Get('history')
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(paginationSchema)) query: { page: number; perPage: number },
  ) {
    return this.contracts.history(user.id, query.page, query.perPage);
  }
}
