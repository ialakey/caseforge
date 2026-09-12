/**
 * Baseline database seed.
 *
 * Only creates what Steam cannot supply: an administrator and their provably
 * fair seed pair.
 *
 * Items and cases are deliberately absent. The seed used to create them with
 * guessed prices, and that turned out to be a trap: after the very first sync
 * the real Steam prices differed by an order of magnitude, cases went into
 * loss, and re-running the seed silently overwrote fixes made in the CRM. The
 * catalogue is populated by a separate command that takes both items and
 * prices from Steam:
 *
 *   pnpm seed:cases
 */
import path from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  generateClientSeed,
  generateServerSeed,
  hashServerSeed,
} from '@caseforge/shared/node';

// import.meta.dirname rather than __dirname: Node runs this file as an ES module.
dotenvConfig({ path: path.join(import.meta.dirname, '../../../.env') });
dotenvConfig({ path: path.join(import.meta.dirname, '../.env') });

const prisma = new PrismaClient();

/** Starting balance of the demo administrator, in minor units. */
const DEMO_BALANCE = 10_000_000;

async function main(): Promise<void> {
  console.log('Seeding the database...');

  const demoSteamId = process.env.BOOTSTRAP_ADMIN_STEAM_ID || '76561197960287930';

  const demo = await prisma.user.upsert({
    where: { steamId64: demoSteamId },
    create: {
      steamId64: demoSteamId,
      username: `admin_${demoSteamId.slice(-6)}`,
      role: 'ADMIN',
      balance: DEMO_BALANCE,
    },
    // Leave an existing administrator's balance alone: re-running the seed
    // must not zero out or top up money on a live account.
    update: { role: 'ADMIN' },
  });

  const hasSeeds = await prisma.serverSeed.findFirst({
    where: { userId: demo.id, isActive: true },
  });
  if (!hasSeeds) {
    const serverSeed = generateServerSeed();
    await prisma.serverSeed.create({
      data: {
        userId: demo.id,
        seed: serverSeed,
        seedHash: hashServerSeed(serverSeed),
        isActive: true,
      },
    });
    await prisma.clientSeed.create({
      data: { userId: demo.id, seed: generateClientSeed(), isActive: true },
    });
  }

  // The balance must agree with the transaction ledger, otherwise the nightly
  // reconciliation raises a false alarm for nothing.
  const ledger = await prisma.transaction.aggregate({
    where: { userId: demo.id },
    _sum: { amount: true },
  });
  const current = await prisma.user.findUniqueOrThrow({
    where: { id: demo.id },
    select: { balance: true },
  });
  const recorded = ledger._sum.amount ?? 0;
  if (recorded !== current.balance) {
    await prisma.transaction.create({
      data: {
        userId: demo.id,
        type: 'ADMIN_ADJUSTMENT',
        amount: current.balance - recorded,
        balanceAfter: current.balance,
        comment: 'Ledger alignment for the demo administrator starting balance',
      },
    });
  }

  const cases = await prisma.case.count();
  console.log(`  administrator: ${demo.username} (steam ${demoSteamId})`);
  console.log(`  cases in the catalogue: ${cases}`);
  console.log('Done.');

  if (cases === 0) {
    console.log('');
    console.log('The catalogue is empty. Populate it with items and prices from Steam:');
    console.log('  pnpm seed:cases');
    console.log('The command takes about ten minutes — Steam throttles requests.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
