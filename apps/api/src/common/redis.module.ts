import { Global, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';
export const REDIS_PUBLISHER = 'REDIS_PUBLISHER';
export const REDIS_SUBSCRIBER = 'REDIS_SUBSCRIBER';

const logger = new Logger('Redis');

/**
 * Three separate connections: a Redis subscriber cannot run ordinary commands,
 * so pub/sub and the cache must not share a client.
 *
 * `enableReadyCheck` is off on purpose. By default ioredis sends `INFO` after
 * every reconnect — an ordinary command a subscriber connection cannot run —
 * and the log fills with "Connection in subscriber mode" with no hint at the
 * source. The readiness check buys nothing here: Redis comes up alongside the
 * application through docker compose.
 */
function createClient(role: string): Redis {
  const client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });

  // An own handler is mandatory: without an 'error' listener ioredis prints
  // "Unhandled error event" with no context, and it is impossible to tell
  // which of the three connections broke.
  client.on('error', (err) => logger.error(`[${role}] ${err.message}`));

  return client;
}

@Global()
@Module({
  providers: [
    // Each factory is wrapped rather than passed bare: Nest calls a factory
    // with its injected dependencies, and `createClient` has none — so handing
    // it over directly would call it with no arguments and label every one of
    // the three connections `[undefined]`, which is the one thing the role was
    // added to prevent.
    { provide: REDIS_CLIENT, useFactory: () => createClient('cache') },
    { provide: REDIS_PUBLISHER, useFactory: () => createClient('publisher') },
    { provide: REDIS_SUBSCRIBER, useFactory: () => createClient('subscriber') },
  ],
  exports: [REDIS_CLIENT, REDIS_PUBLISHER, REDIS_SUBSCRIBER],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(private readonly moduleRef: ModuleRef) {}

  async onApplicationShutdown(): Promise<void> {
    for (const token of [REDIS_CLIENT, REDIS_PUBLISHER, REDIS_SUBSCRIBER]) {
      const client = this.moduleRef.get<Redis>(token, { strict: false });
      await client?.quit().catch(() => undefined);
    }
  }
}
