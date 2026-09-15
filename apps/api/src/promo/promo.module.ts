import { Module } from '@nestjs/common';
import { PromoService } from './promo.service';

@Module({
  providers: [PromoService],
  exports: [PromoService],
})
export class PromoModule {}
