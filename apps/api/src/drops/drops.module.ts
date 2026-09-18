import { Module } from '@nestjs/common';
import { DropsService } from './drops.service';
import { DropsGateway } from './drops.gateway';
import { DropsController } from './drops.controller';

@Module({
  controllers: [DropsController],
  providers: [DropsService, DropsGateway],
  exports: [DropsService],
})
export class DropsModule {}
