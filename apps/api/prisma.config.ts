import path from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { defineConfig } from 'prisma/config';

// With a prisma.config.ts present Prisma no longer loads .env itself — the
// canonical file lives at the monorepo root, so load it explicitly.
dotenvConfig({ path: path.join(__dirname, '../../.env') });
dotenvConfig({ path: path.join(__dirname, '.env') });

// Migrations must not go through PgBouncer, so the schema reads them from
// DIRECT_DATABASE_URL. It defaults to DATABASE_URL, which is the whole
// configuration a single-server setup needs.
process.env.DIRECT_DATABASE_URL ??= process.env.DATABASE_URL;

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    seed: 'node --experimental-strip-types prisma/seed.ts',
  },
});
