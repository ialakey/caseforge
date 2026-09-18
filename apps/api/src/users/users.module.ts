import { Module } from '@nestjs/common';
import { PromoModule } from '../promo/promo.module';
import { ReferralModule } from '../referral/referral.module';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

@Module({
  imports: [PromoModule, ReferralModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
