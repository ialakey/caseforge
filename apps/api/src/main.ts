import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { AppModule } from './app.module';
import { loadConfig } from './common/config';
import { RedisIoAdapter } from './redis-io.adapter';

/**
 * By default Fastify answers 400 to a POST with Content-Type: application/json
 * and an empty body. That hits every payload-less endpoint — seed rotation,
 * withdrawal cancellation, logout — while a typical front-end client sets that
 * header on all POSTs. So an empty body is treated as {}.
 */
function overrideJsonBodyParser(app: NestFastifyApplication): void {
  const instance = app.getHttpAdapter().getInstance();
  instance.removeContentTypeParser('application/json');
  instance.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body: string, done) => {
      if (body === '') return done(null, {});
      try {
        done(null, JSON.parse(body));
      } catch {
        const err = new Error('Malformed JSON') as Error & { statusCode?: number };
        err.statusCode = 400;
        done(err, undefined);
      }
    },
  );
}

async function bootstrap(): Promise<void> {
  // Fail immediately on a bad environment, before the port is opened.
  const config = loadConfig();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
  );

  await app.register(fastifyCookie);

  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
  });

  const ioAdapter = new RedisIoAdapter(app);
  await ioAdapter.connect(config.REDIS_URL);
  app.useWebSocketAdapter(ioAdapter);

  app.enableShutdownHooks();

  // Initialise before listen: only after init() has Nest registered its own
  // JSON parser so it can be replaced, and Fastify has not yet frozen the
  // configuration with a ready() call.
  await app.init();
  overrideJsonBodyParser(app);

  await app.listen(config.API_PORT, '0.0.0.0');
  new Logger('Bootstrap').log(`API listening on http://localhost:${config.API_PORT}`);
}

void bootstrap();
