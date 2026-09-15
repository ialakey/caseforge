import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { CasesModule } from '../cases/cases.module';
import { SteamModule } from '../steam/steam.module';
import { PromoModule } from '../promo/promo.module';

@Module({
  imports: [CasesModule, SteamModule, PromoModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
