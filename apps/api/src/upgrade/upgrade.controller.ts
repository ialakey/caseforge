import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { paginationSchema, upgradeSchema, upgradeTargetsSchema } from '@caseforge/shared';
import { UpgradeService } from './upgrade.service';
import { CurrentUser, type AuthenticatedUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@Controller('api/upgrade')
export class UpgradeController {
  constructor(private readonly upgrade: UpgradeService) {}

  /** Inventory items available to stake. */
  @Get('stakes')
  stakes(@CurrentUser() user: AuthenticatedUser) {
    return this.upgrade.listStakes(user.id);
  }

  /** Available targets for a stake of the given value. */
  @Get('targets')
  targets(
    @Query(new ZodValidationPipe(upgradeTargetsSchema))
    query: { stakeValue: number; search?: string; page: number; perPage: number },
  ) {
    return this.upgrade.listTargets(query);
  }

  @Post()
  run(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(upgradeSchema))
    body: { inventoryItemId: string; targetItemId: string },
  ) {
    return this.upgrade.upgrade(user.id, body.inventoryItemId, body.targetItemId);
  }

  @Get('history')
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(paginationSchema)) query: { page: number; perPage: number },
  ) {
    return this.upgrade.history(user.id, query.page, query.perPage);
  }
}
