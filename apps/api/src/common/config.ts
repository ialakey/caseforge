import { z } from 'zod';
import { loadEnv } from './load-env';

/**
 * The environment is validated at boot: the app must fail immediately rather
 * than an hour later in production on the first call to Steam.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_URL: z.string().url().default('http://localhost:4000'),
  WEB_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),
  /**
   * Read replica, optional. Unset — the normal case on one box — sends every
   * read to the primary. Set, it serves the reads that tolerate replication
   * lag: reports, the public catalogue, the lobby, the drop feed.
   */
  REPLICA_DATABASE_URL: z.string().default(''),
  REDIS_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET: at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET: at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  STEAM_API_KEY: z.string().default(''),
  STEAM_REALM: z.string().url().default('http://localhost:4000'),
  STEAM_RETURN_URL: z.string().url().default('http://localhost:4000/api/auth/steam/return'),

  CURRENCY: z.string().default('RUB'),

  /**
   * Stub top-up: credits the entered amount with no payment at all.
   * It exists so the gameplay loop can be exercised before payments are wired
   * in. Disabled by default in production and enabled only by an explicit
   * "true" — otherwise it is a hole any signed-in user can draw money through.
   */
  ENABLE_STUB_DEPOSITS: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  BOOTSTRAP_ADMIN_STEAM_ID: z.string().default(''),
});

export type AppConfig = z.infer<typeof envSchema> & { corsOrigins: string[] };

let cached: AppConfig | undefined;

/**
 * Validated configuration. Memoised: nearly every service asks for it, and
 * re-reading and re-validating the environment on each call buys nothing.
 * The .env file is loaded here too, which makes import order irrelevant.
 */
export function loadConfig(): AppConfig {
  if (cached) return cached;

  loadEnv();
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${details}`);
  }
  // On by default in development, in production only behind an explicit flag.
  const stubDeposits =
    process.env.ENABLE_STUB_DEPOSITS === undefined
      ? parsed.data.NODE_ENV !== 'production'
      : parsed.data.ENABLE_STUB_DEPOSITS;

  cached = {
    ...parsed.data,
    ENABLE_STUB_DEPOSITS: stubDeposits,
    corsOrigins: parsed.data.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
  return cached;
}
