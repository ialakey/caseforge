import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';

/**
 * The .env file lives at the monorepo root: database and Redis settings are
 * shared by api, bot and web, and keeping three copies is a reliable way to
 * drift them apart. A local apps/api/.env, if present, wins.
 */
export function loadEnv(): void {
  for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
    if (existsSync(candidate)) dotenvConfig({ path: candidate });
  }

  // `directUrl` in the Prisma schema is what migrations and introspection use,
  // and it must resolve even when nobody has heard of it: a deployment behind
  // PgBouncer points DATABASE_URL at the pooler and DIRECT_DATABASE_URL at
  // Postgres itself, while a single-server setup sets neither and both are the
  // same string. Prisma refuses to start on an unset referenced variable, so
  // the default is filled in here rather than duplicated into every .env.
  process.env.DIRECT_DATABASE_URL ??= process.env.DATABASE_URL;
}
