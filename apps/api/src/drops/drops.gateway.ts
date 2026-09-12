import { Inject, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import Redis from 'ioredis';
import { type LiveDrop, WS_EVENTS } from '@caseforge/shared';
import { REDIS_SUBSCRIBER } from '../common/redis.module';
import { DROPS_CHANNEL, DropsService } from './drops.service';
import { loadConfig } from '../common/config';

/**
 * Drops are broadcast in batches every FLUSH_INTERVAL_MS rather than one by
 * one: at 10k openings per minute that is the difference between a stream of
 * individual frames and roughly three frames per second, with a result the eye
 * cannot tell apart.
 */
const FLUSH_INTERVAL_MS = 300;
const MAX_BATCH = 50;

@WebSocketGateway({
  cors: { origin: loadConfig().corsOrigins, credentials: true },
})
export class DropsGateway implements OnModuleInit, OnModuleDestroy, OnGatewayConnection {
  private readonly logger = new Logger(DropsGateway.name);
  private readonly config = loadConfig();
  private buffer: LiveDrop[] = [];
  private timer?: NodeJS.Timeout;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly drops: DropsService,
    private readonly jwt: JwtService,
    @Inject(REDIS_SUBSCRIBER) private readonly subscriber: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.subscriber.subscribe(DROPS_CHANNEL);
    this.subscriber.on('message', (channel, message) => {
      if (channel !== DROPS_CHANNEL) return;
      try {
        this.buffer.push(JSON.parse(message) as LiveDrop);
        if (this.buffer.length > MAX_BATCH) this.buffer.shift();
      } catch (err) {
        this.logger.warn(`Malformed message on ${channel}: ${String(err)}`);
      }
    });

    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * The personal room is assigned by the server from a verified token, never
   * from an id sent by the client — otherwise anyone could subscribe to
   * someone else's balance and withdrawal statuses.
   */
  async handleConnection(client: Socket): Promise<void> {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      (client.handshake.headers.authorization?.startsWith('Bearer ')
        ? client.handshake.headers.authorization.slice(7)
        : undefined);

    if (token) {
      try {
        const payload = await this.jwt.verifyAsync<{ sub: string }>(token, {
          secret: this.config.JWT_ACCESS_SECRET,
        });
        await client.join(`user:${payload.sub}`);
      } catch {
        // An anonymous connection is fine — it just receives no personal events.
        this.logger.debug('Socket connected with an invalid token, continuing anonymously');
      }
    }

    client.emit(WS_EVENTS.DROPS_BATCH, await this.drops.recent());
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    this.server?.emit(WS_EVENTS.DROPS_BATCH, batch);
  }
}
