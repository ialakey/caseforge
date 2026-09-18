import { Module } from '@nestjs/common';
import { KycService } from './kyc.service';
import { KycController, KycAdminController } from './kyc.controller';

@Module({
  controllers: [KycController, KycAdminController],
  providers: [KycService],
  exports: [KycService],
})
export class KycModule {}
