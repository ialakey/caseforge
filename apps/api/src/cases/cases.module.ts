import { Module } from '@nestjs/common';
import { CasesService } from './cases.service';
import { CasesController } from './cases.controller';
import { DropsModule } from '../drops/drops.module';
import { BonusModule } from '../bonus/bonus.module';
import { ReferralModule } from '../referral/referral.module';

@Module({
  imports: [DropsModule, BonusModule, ReferralModule],
  controllers: [CasesController],
  providers: [CasesService],
  exports: [CasesService],
})
export class CasesModule {}
