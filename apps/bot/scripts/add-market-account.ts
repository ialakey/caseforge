/**
 * Registers a market.csgo.com account the site buys withdrawals through.
 *
 * More than one is normal and is the point: the market deletes an API key that
 * exceeds five requests a second, so a single key caps how fast the site can
 * hand items out. Each account is throttled on its own, because the limit is
 * counted per key.
 *
 * The key is never typed on the command line — it would land in the shell
 * history — and never stored in the clear. It is read from the environment and
 * written encrypted under BOT_SECRETS_KEY, the same as the Steam bots' secrets,
 * and decrypted only inside the worker.
 *
 * Example:
 *   MARKET_ACCOUNT_LABEL=main MARKET_ACCOUNT_KEY=... \
 *   node --experimental-strip-types scripts/add-market-account.ts
 *
 * Get a key at https://market.csgo.com/api. The account must be topped up and
 * settle in the same currency as the site.
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
  const label = required('MARKET_ACCOUNT_LABEL');
  const apiKey = required('MARKET_ACCOUNT_KEY');

  // Keyed by label rather than by the key itself: the ciphertext differs on
  // every encryption, so matching on it would add a duplicate account each time
  // the same key was registered. The label is what an operator recognises in
  // the panel anyway.
  const existing = await prisma.marketAccount.findFirst({ where: { label } });

  const account = existing
    ? await prisma.marketAccount.update({
        where: { id: existing.id },
        data: {
          encryptedApiKey: encryptSecret(apiKey),
          // A replaced key is unproven until the worker checks it, and leaving
          // it ONLINE would let the pool spend purchases on a key that may not
          // work.
          status: 'OFFLINE',
          lastError: null,
        },
      })
    : await prisma.marketAccount.create({
        data: { label, encryptedApiKey: encryptSecret(apiKey), status: 'OFFLINE' },
      });

  console.log(
    `Market account "${account.label}" saved with id ${account.id}. ` +
      'The worker checks its balance and health on its next refresh.',
  );
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
