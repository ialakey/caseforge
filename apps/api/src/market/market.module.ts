import { Module } from '@nestjs/common';
import { MarketService } from './market.service';

@Module({
  providers: [MarketService],
  exports: [MarketService],
})
export class MarketModule {}
