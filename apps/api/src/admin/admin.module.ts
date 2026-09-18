import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { ReportsService } from './reports.service';
import { AdminController } from './admin.controller';
import { CasesModule } from '../cases/cases.module';
import { SteamModule } from '../steam/steam.module';
import { PromoModule } from '../promo/promo.module';
import { MarketModule } from '../market/market.module';

@Module({
  imports: [CasesModule, SteamModule, PromoModule, MarketModule],
  controllers: [AdminController],
  providers: [AdminService, ReportsService],
})
export class AdminModule {}
