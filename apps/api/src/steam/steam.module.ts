import { Module } from '@nestjs/common';
import { SteamOpenIdService } from './steam-openid.service';
import { SteamMarketService } from './steam-market.service';
import { ItemSyncService } from './item-sync.service';

@Module({
  providers: [SteamOpenIdService, SteamMarketService, ItemSyncService],
  exports: [SteamOpenIdService, SteamMarketService, ItemSyncService],
})
export class SteamModule {}
