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
}
