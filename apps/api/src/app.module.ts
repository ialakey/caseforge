import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { CommonModule } from './common/common.module';
import { RedisModule } from './common/redis.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { SteamModule } from './steam/steam.module';
import { UsersModule } from './users/users.module';
import { CasesModule } from './cases/cases.module';
import { InventoryModule } from './inventory/inventory.module';
import { DropsModule } from './drops/drops.module';
import { WithdrawalsModule } from './withdrawals/withdrawals.module';
import { ItemDepositsModule } from './deposits/item-deposits.module';
import { UpgradeModule } from './upgrade/upgrade.module';
import { ContractsModule } from './contracts/contracts.module';
import { BonusModule } from './bonus/bonus.module';
import { PromoModule } from './promo/promo.module';
import { BattlesModule } from './battles/battles.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ReferralModule } from './referral/referral.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    CommonModule,
    RedisModule,
    AuthModule,
    SteamModule,
    UsersModule,
    CasesModule,
    InventoryModule,
    DropsModule,
    WithdrawalsModule,
    ItemDepositsModule,
    UpgradeModule,
    ContractsModule,
    BonusModule,
    PromoModule,
    BattlesModule,
    ReferralModule,
    AnalyticsModule,
    AdminModule,
  ],
  providers: [
    // Authentication is on by default for every endpoint; exceptions are marked @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
