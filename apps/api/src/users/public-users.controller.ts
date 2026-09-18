import { Controller, Get, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import type { PublicProfileView } from '@caseforge/shared';
import { Public } from '../auth/public.decorator';
import { SettingsService } from '../common/settings.service';
import { UsersService } from './users.service';

/**
 * A player's page as a stranger sees it.
 *
 * Separate from `/api/me` rather than a mode of it: that controller answers
 * about whoever holds the token and returns balances, trade URLs and
 * transactions. Anything reachable by a stranger belongs behind its own route
 * with its own shape, so a field cannot become public by being added to a
 * profile object somebody assumed was private.
 *
 * The live drop strip links here, so this is as public as the strip itself.
 */
@Controller('api/users')
export class PublicUsersController {
  constructor(
    private readonly users: UsersService,
    private readonly settings: SettingsService,
  ) {}

  @Public()
  @Get(':id')
  async profile(@Param('id', ParseUUIDPipe) id: string): Promise<PublicProfileView> {
    await this.settings.ensureFresh();

    // An operator who switched public profiles off gets a 404 rather than a
    // 403: "this player does not exist here" is the answer that does not
    // confirm the id belongs to somebody.
    if (this.settings.get<boolean>('appearance.publicProfiles') !== true) {
      throw new NotFoundException('Profile not found');
    }

    const profile = await this.users.getPublicProfile(id);
    if (!profile) throw new NotFoundException('Profile not found');
    return profile;
  }
}
