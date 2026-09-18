import { Module } from '@nestjs/common';
import { KycModule } from '../kyc/kyc.module';
import { WithdrawalsService } from './withdrawals.service';
import { WithdrawalsController } from './withdrawals.controller';

@Module({
  // The identity gate lives with withdrawals because that is where it bites.
  imports: [KycModule],
  controllers: [WithdrawalsController],
  providers: [WithdrawalsService],
  exports: [WithdrawalsService],
})
export class WithdrawalsModule {}
