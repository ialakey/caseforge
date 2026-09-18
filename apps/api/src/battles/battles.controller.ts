import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { type CreateBattleInput, createBattleSchema } from '@caseforge/shared';
import { BattlesService } from './battles.service';
import { Public } from '../auth/public.decorator';
import { CurrentUser, type AuthenticatedUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@Controller('api/battles')
export class BattlesController {
  constructor(private readonly battles: BattlesService) {}

  /** The lobby is public: a visitor can watch before they sign in. */
  @Public()
  @Get()
  list() {
    return this.battles.list();
  }

  @Public()
  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.battles.get(id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createBattleSchema)) body: CreateBattleInput,
  ) {
    return this.battles.create(user.id, body);
  }

  @Post(':id/join')
  join(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.battles.join(user.id, id);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.battles.cancel(user.id, id);
  }
}
