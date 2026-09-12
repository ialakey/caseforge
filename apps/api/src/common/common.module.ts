import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { MaintenanceService } from './maintenance.service';
import { ConfigController } from './config.controller';
import { FxService } from './fx.service';

/**
 * Global module: PrismaService is needed by nearly every module, and importing
 * it by hand into each one is pure noise.
 */
@Global()
@Module({
  controllers: [ConfigController],
  providers: [PrismaService, MaintenanceService, FxService],
  exports: [PrismaService, FxService],
})
export class CommonModule {}
