import { Module } from '@nestjs/common';
import { PromoModule } from '../promo/promo.module';
import { ReferralModule } from '../referral/referral.module';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { PublicUsersController } from './public-users.controller';

@Module({
  imports: [PromoModule, ReferralModule],
  // `UsersController` owns /api/me, `PublicUsersController` owns /api/users/:id.
  controllers: [UsersController, PublicUsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
