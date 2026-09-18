import { Module } from '@nestjs/common';
import { GiveawaysService } from './giveaways.service';
import { GiveawaysController, GiveawaysAdminController } from './giveaways.controller';

@Module({
  controllers: [GiveawaysController, GiveawaysAdminController],
  providers: [GiveawaysService],
  exports: [GiveawaysService],
})
export class GiveawaysModule {}
