import { Inject, Logger, OnModuleInit } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server } from 'socket.io';
import Redis from 'ioredis';
import { WS_EVENTS } from '@caseforge/shared';
import { REDIS_SUBSCRIBER } from '../common/redis.module';
import { loadConfig } from '../common/config';
import { BATTLES_CHANNEL, type BattleEvent } from './battles.events';

/**
 * Pushes battle changes to the browser.
 *
 * Unlike the drop feed these are not batched. A battle event is rare — a
 * creation, a seat, a settlement — and it is what the lobby is looking at, so
 * three hundred milliseconds of buffering would only make a seat appear to be
 * free after somebody had taken it.
 */
@WebSocketGateway({
  cors: { origin: loadConfig().corsOrigins, credentials: true },
})
export class BattlesGateway implements OnModuleInit {
  private readonly logger = new Logger(BattlesGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(@Inject(REDIS_SUBSCRIBER) private readonly subscriber: Redis) {}

  async onModuleInit(): Promise<void> {
    await this.subscriber.subscribe(BATTLES_CHANNEL);
    this.subscriber.on('message', (channel, message) => {
      if (channel !== BATTLES_CHANNEL) return;
      try {
        const event = JSON.parse(message) as BattleEvent;
        if (event.kind === 'battle') {
          this.server?.emit(WS_EVENTS.BATTLE_UPDATED, event.battle);
        } else {
          // The personal room is joined by the drops gateway from a verified
          // token, so addressing it here cannot leak a balance to anyone else.
          this.server?.to(`user:${event.userId}`).emit(WS_EVENTS.BALANCE_UPDATED, {
            balance: event.balance,
          });
        }
      } catch (err) {
        this.logger.warn(`Malformed message on ${channel}: ${String(err)}`);
      }
    });
  }
}
