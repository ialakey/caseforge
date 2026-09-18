import { Module } from '@nestjs/common';
import { SteamModule } from '../steam/steam.module';
import { ItemDepositsService } from './item-deposits.service';
import { ItemDepositsController } from './item-deposits.controller';

@Module({
  imports: [SteamModule],
  controllers: [ItemDepositsController],
  providers: [ItemDepositsService],
  exports: [ItemDepositsService],
})
export class ItemDepositsModule {}
