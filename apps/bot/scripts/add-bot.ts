/**
 * Registers a Steam bot in the farm.
 *
 * Secrets are never typed on the command line or stored in the clear: the
 * script reads them from environment variables and writes them encrypted.
 *
 * Example:
 *   BOT_USERNAME=mybot BOT_PASSWORD=... BOT_SHARED_SECRET=... \
 *   BOT_IDENTITY_SECRET=... BOT_STEAM_ID=7656119... \
 *   node --experimental-strip-types scripts/add-bot.ts
 *
 * shared_secret and identity_secret come from the Steam mobile authenticator's
 * maFile. Without them offers cannot be auto-confirmed.
 */
import path from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { encryptSecret } from '../src/crypto.ts';

dotenvConfig({ path: path.join(import.meta.dirname, '../../../.env') });

const prisma = new PrismaClient();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Environment variable ${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const steamId64 = required('BOT_STEAM_ID');
  const username = required('BOT_USERNAME');

  const bot = await prisma.steamBot.upsert({
    where: { steamId64 },
    create: {
      steamId64,
      username,
      label: process.env.BOT_LABEL ?? null,
      status: 'OFFLINE',
      encryptedPassword: encryptSecret(required('BOT_PASSWORD')),
      encryptedSharedSecret: encryptSecret(required('BOT_SHARED_SECRET')),
      encryptedIdentitySecret: encryptSecret(required('BOT_IDENTITY_SECRET')),
    },
    update: {
      username,
      encryptedPassword: encryptSecret(required('BOT_PASSWORD')),
      encryptedSharedSecret: encryptSecret(required('BOT_SHARED_SECRET')),
      encryptedIdentitySecret: encryptSecret(required('BOT_IDENTITY_SECRET')),
    },
  });

  console.log(`Bot ${bot.username} (${bot.steamId64}) saved with id ${bot.id}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
