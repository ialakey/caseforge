import path from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { defineConfig } from 'prisma/config';

// With a prisma.config.ts present Prisma no longer loads .env itself — the
// canonical file lives at the monorepo root, so load it explicitly.
dotenvConfig({ path: path.join(__dirname, '../../.env') });
dotenvConfig({ path: path.join(__dirname, '.env') });

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    seed: 'node --experimental-strip-types prisma/seed.ts',
  },
});
