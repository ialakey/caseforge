import { Module } from '@nestjs/common';
import { PromoModule } from '../promo/promo.module';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

@Module({
  imports: [PromoModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
