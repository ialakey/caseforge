import { Module } from '@nestjs/common';
import { DropsService } from './drops.service';
import { DropsGateway } from './drops.gateway';

@Module({
  providers: [DropsService, DropsGateway],
  exports: [DropsService],
})
export class DropsModule {}
