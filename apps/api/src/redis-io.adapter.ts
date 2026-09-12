import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { ServerOptions } from 'socket.io';

/**
 * Without the Redis adapter rooms live in one process's memory: with two or
 * more API instances half the users simply never receive an event.
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  async connect(redisUrl: string): Promise<void> {
    const pubClient = new Redis(redisUrl, { maxRetriesPerRequest: null });
    const subClient = pubClient.duplicate();
    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      (server as { adapter: (a: unknown) => void }).adapter(this.adapterConstructor);
    }
    return server;
  }
}
