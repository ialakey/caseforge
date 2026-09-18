import { Module } from '@nestjs/common';
import { BattlesService } from './battles.service';
import { BattlesController } from './battles.controller';
import { BattlesGateway } from './battles.gateway';
import { CasesModule } from '../cases/cases.module';
import { DropsModule } from '../drops/drops.module';
import { ReferralModule } from '../referral/referral.module';

@Module({
  imports: [CasesModule, DropsModule, ReferralModule],
  controllers: [BattlesController],
  providers: [BattlesService, BattlesGateway],
  exports: [BattlesService],
})
export class BattlesModule {}
