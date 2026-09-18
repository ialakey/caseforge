import { Global, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { PRISMA_READ, createReadClient } from './prisma-read';
import { MaintenanceService } from './maintenance.service';
import { CacheService } from './cache.service';
import { ConfigController } from './config.controller';
import { HealthController } from './health.controller';
import { FxService } from './fx.service';
import { SettingsService } from './settings.service';

/**
 * Global module: PrismaService is needed by nearly every module, and importing
 * it by hand into each one is pure noise.
 */
@Global()
@Module({
  controllers: [ConfigController, HealthController],
  providers: [
    PrismaService,
    {
      provide: PRISMA_READ,
      inject: [PrismaService],
      useFactory: createReadClient,
    },
    MaintenanceService,
    CacheService,
    FxService,
    SettingsService,
  ],
  exports: [PrismaService, PRISMA_READ, CacheService, FxService, SettingsService],
})
export class CommonModule implements OnApplicationShutdown {
  private readonly logger = new Logger(CommonModule.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  /**
   * The replica client is created outside Nest's lifecycle hooks — it is a
   * factory provider, not a class — so it has to be closed by hand. Skipped
   * when there is no replica: the primary is closed by `PrismaService` itself,
   * and disconnecting it twice throws on shutdown.
   */
  async onApplicationShutdown(): Promise<void> {
    const read = this.moduleRef.get<PrismaClient>(PRISMA_READ, { strict: false });
    const primary = this.moduleRef.get<PrismaService>(PrismaService, { strict: false });
    if (read && read !== (primary as unknown as PrismaClient)) {
      await read.$disconnect().catch((err) => {
        this.logger.warn(`Could not close the replica connection: ${String(err)}`);
      });
    }
  }
}
