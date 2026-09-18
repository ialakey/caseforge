import { Module } from '@nestjs/common';
import { SteamOpenIdService } from './steam-openid.service';
import { SteamMarketService } from './steam-market.service';
import { ItemSyncService } from './item-sync.service';
import { SteamInventoryService } from './steam-inventory.service';

@Module({
  providers: [SteamOpenIdService, SteamMarketService, ItemSyncService, SteamInventoryService],
  exports: [SteamOpenIdService, SteamMarketService, ItemSyncService, SteamInventoryService],
})
export class SteamModule {}
