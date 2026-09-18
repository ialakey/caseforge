import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import Redis from 'ioredis';
import { AppModule } from './app.module';
import { loadConfig } from './common/config';
import { RedisIoAdapter } from './redis-io.adapter';

/**
 * How large a request body may be, anywhere.
 *
 * Fastify's own default, stated here rather than inherited, because the next
 * constant is an exception to it and an exception needs something to be an
 * exception to. Every endpoint on this API takes a small JSON object; a
 * megabyte is already far more than any of them has a use for.
 */
const BODY_LIMIT = 1024 * 1024;

/**
 * The exception: identity documents.
 *
 * They arrive as base64 inside JSON, up to four of them, and a photograph of a
 * passport taken on a phone is several megabytes before encoding adds a third.
 * Under the global limit those uploads would be refused with a 413 that says
 * nothing about why, so the one route that carries them is allowed more — and
 * only that route, because raising the ceiling everywhere would let any caller
 * make the server buffer twelve megabytes at a time.
 */
const KYC_BODY_LIMIT = 12 * 1024 * 1024;

/** The route that exception applies to. */
const KYC_ROUTE = '/api/kyc';

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

/**
 * Lets the KYC upload through the body limit the rest of the API lives under.
 *
 * Applied as a hook rather than by raising the global limit, and registered
 * before `init()` because that is when Nest declares its routes: a hook added
 * afterwards would have nothing left to intercept.
 */
function allowLargeKycUploads(app: NestFastifyApplication): void {
  app.getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      if (route.url === KYC_ROUTE && methods.includes('POST')) {
        route.bodyLimit = KYC_BODY_LIMIT;
      }
    });
}

async function bootstrap(): Promise<void> {
  // Fail immediately on a bad environment, before the port is opened.
  const config = loadConfig();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: config.TRUST_PROXY, bodyLimit: BODY_LIMIT }),
  );

  await app.register(fastifyCookie);

  /**
   * Headers this API cannot be talked out of sending.
   *
   * It answers with JSON and, on one route, a scan of somebody's passport. The
   * defaults are right for both, with two adjustments: a page from here is
   * never meant to be framed or scripted, so the policy is tightened to
   * nothing at all, and `crossOriginEmbedderPolicy` is left off because the
   * site is a separate origin and has no use for the isolation it demands.
   */
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        sandbox: ['allow-downloads'],
      },
    },
    crossOriginEmbedderPolicy: false,
    // The web app and the API are different origins; `same-origin` here would
    // refuse the very requests CORS is being configured to allow.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'no-referrer' },
  });

  /**
   * One ceiling over everything, counted in Redis.
   *
   * In Redis rather than in memory because the count has to mean the same
   * thing on every instance — a limit that resets when a request lands on the
   * second container is a limit multiplied by the number of containers.
   *
   * Keyed by address, which is the only thing a flood has in common: keying by
   * account would leave the unauthenticated half of the site — the catalogue,
   * the drop feed, the Steam return, the token refresh — with no ceiling at
   * all, and those are exactly the routes worth pointing a script at.
   */
  const limiterRedis = new Redis(config.REDIS_URL, {
    // The limiter must never be what takes the site down: if Redis is slow,
    // stop asking it and let the request through rather than queue behind it.
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  limiterRedis.on('error', () => {
    // Logged once by the plugin's own `onExceeding`; a per-command handler here
    // exists only so a dropped connection is not an unhandled error event.
  });

  await app.register(fastifyRateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_SEC * 1000,
    redis: limiterRedis,
    // A shared prefix keeps the limiter's keys apart from the ones the
    // application writes, so flushing one never silently empties the other.
    nameSpace: 'ratelimit:http:',
    // Health checks are what tells an operator the site is up. Throttling them
    // would turn a busy minute into a false alarm and, worse, into a restart.
    allowList: (request) => request.url.startsWith('/api/health'),
    // Redis unreachable: answer the request. The limit is a guard rail, and a
    // guard rail that fails closed is an outage.
    skipOnError: true,
    // Refused in an onRequest hook, so this never reaches Nest's exception
    // layer and the body Fastify serialises is `{ statusCode, message }` — the
    // `code` every other refusal carries is dropped on the way out. The front
    // end reads the 429 itself as RATE_LIMITED instead; see `lib/api.ts`.
    errorResponseBuilder: (_request, context) =>
      Object.assign(
        new Error(`Too many requests — try again in ${Math.ceil(context.ttl / 1000)}s`),
        { statusCode: 429 },
      ),
  });

  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
  });

  const ioAdapter = new RedisIoAdapter(app);
  await ioAdapter.connect(config.REDIS_URL);
  app.useWebSocketAdapter(ioAdapter);

  app.enableShutdownHooks();

  allowLargeKycUploads(app);

  // Initialise before listen: only after init() has Nest registered its own
  // JSON parser so it can be replaced, and Fastify has not yet frozen the
  // configuration with a ready() call.
  await app.init();
  overrideJsonBodyParser(app);

  await app.listen(config.API_PORT, '0.0.0.0');
  const log = new Logger('Bootstrap');
  log.log(`API listening on http://localhost:${config.API_PORT}`);
  log.log(
    `Rate limit: ${config.RATE_LIMIT_MAX} requests / ${config.RATE_LIMIT_WINDOW_SEC}s per address` +
      `; proxy headers ${config.TRUST_PROXY ? 'trusted' : 'ignored'}`,
  );
}

void bootstrap();
