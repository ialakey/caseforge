import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { type GiveawayStanding, type GiveawayView, UserRole } from '@caseforge/shared';
import { Public } from '../auth/public.decorator';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { CurrentUser, type AuthenticatedUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { GiveawaysService } from './giveaways.service';

const createGiveawaySchema = z.object({
  itemId: z.string().uuid(),
  title: z.string().trim().min(2).max(120),
  titleEn: z.string().trim().max(120).nullable().optional(),
  minDeposit: z.number().int().min(0).max(100_000_000).default(0),
  opensAt: z.string().datetime(),
  drawsAt: z.string().datetime(),
});

/** What anybody may see, and what a signed-in player may do. */
@Controller('api/giveaways')
export class GiveawaysController {
  constructor(private readonly giveaways: GiveawaysService) {}

  @Public()
  @Get()
  list(): Promise<GiveawayView[]> {
    return this.giveaways.list();
  }

  /** Past draws, with the seed each one can be re-checked against. */
  @Public()
  @Get('history')
  history(): Promise<GiveawayView[]> {
    return this.giveaways.history();
  }

  /** How the caller stands against each giveaway currently open. */
  @Get('standings')
  standings(@CurrentUser() user: AuthenticatedUser): Promise<GiveawayStanding[]> {
    return this.giveaways.standings(user.id);
  }

  @Post(':id/enter')
  enter(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<GiveawayStanding> {
    return this.giveaways.enter(user.id, id);
  }
}

/** Creating and calling off giveaways. */
@Controller('api/admin/giveaways')
@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN)
export class GiveawaysAdminController {
  constructor(private readonly giveaways: GiveawaysService) {}

  @Get()
  list(): Promise<GiveawayView[]> {
    return this.giveaways.listAll();
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createGiveawaySchema)) body: z.infer<typeof createGiveawaySchema>,
  ): Promise<GiveawayView> {
    return this.giveaways.create({
      itemId: body.itemId,
      title: body.title,
      titleEn: body.titleEn ?? null,
      minDeposit: body.minDeposit,
      opensAt: new Date(body.opensAt),
      drawsAt: new Date(body.drawsAt),
    });
  }

  @Post(':id/cancel')
  async cancel(@Param('id', ParseUUIDPipe) id: string): Promise<{ cancelled: true }> {
    await this.giveaways.cancel(id);
    return { cancelled: true };
  }
}
