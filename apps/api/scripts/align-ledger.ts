/**
 * Gives the ledger the entries that balance changes never wrote.
 *
 * `MaintenanceService.reconcileBalances` runs nightly and reports every
 * account whose `users.balance` disagrees with the sum of its transactions.
 * Reporting is all it does, deliberately — a mismatch is an incident, and an
 * incident that quietly repairs itself at four in the morning is one nobody
 * ever investigates. But once it *has* been investigated, something has to be
 * able to close it, and until now nothing could.
 *
 * Run:  pnpm align-ledger              # reports, writes nothing
 *       pnpm align-ledger --write      # writes the missing entries
 *
 * ## Which half is wrong
 *
 * The balance is left alone and the ledger is given the entry it is missing.
 * That is the same choice the seed makes for the demo administrator's starting
 * balance, and it is the conservative one: the balance is what a player can
 * actually spend, nothing here knows *why* the two disagree, and debiting an
 * account to settle a bookkeeping question would turn a discrepancy in the
 * records into a real loss for whoever holds it.
 *
 * So this is not a repair. It is a note saying the difference was seen,
 * accepted and dated — and the drift it closes stays visible for ever as an
 * ADMIN_ADJUSTMENT nobody can mistake for ordinary play.
 *
 * ## Why it defaults to writing nothing
 *
 * Every other operator script here changes one row that an operator named. In
 * this one the rows are whatever the query finds, the amounts are whatever the
 * drift happens to be, and the whole point is that nobody yet knows where they
 * came from. A run that has to be asked twice is worth the keystroke.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma.service';

/** One account the reconciliation query is unhappy about. */
interface Drift {
  id: string;
  username: string;
  balance: number;
  /** SUM() comes back from Postgres as a bigint however small it is. */
  ledger: bigint;
}

/**
 * The reconciliation query, word for word the one the nightly job runs.
 *
 * Shared by the report and the write so the second cannot act on a different
 * set from the one the first printed.
 */
function drifting(client: { $queryRaw: PrismaService['$queryRaw'] }): Promise<Drift[]> {
  return client.$queryRaw<Drift[]>`
    SELECT u.id, u.username, u.balance, COALESCE(SUM(t.amount), 0) AS ledger
    FROM users u
    LEFT JOIN transactions t ON t."userId" = u.id
    GROUP BY u.id, u.username, u.balance
    HAVING u.balance <> COALESCE(SUM(t.amount), 0)
  `;
}

/** Minor units as an operator reads them. */
function major(minor: number): string {
  return (minor / 100).toFixed(2);
}

async function main(): Promise<void> {
  const logger = new Logger('AlignLedger');
  const write = process.argv.slice(2).includes('--write');

  // 'log' has to be in the list: everything this script reports, it reports
  // through the Nest logger, and without it a successful run says nothing.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  const prisma = app.get(PrismaService);

  const found = await drifting(prisma);
  if (found.length === 0) {
    logger.log('Every balance already agrees with its ledger. Nothing to do.');
    await app.close();
    return;
  }

  logger.warn(`${found.length} account(s) out of step:`);
  for (const row of found) {
    const drift = row.balance - Number(row.ledger);
    logger.warn(
      `  ${row.username} (${row.id}): balance ${major(row.balance)}, ` +
        `ledger ${major(Number(row.ledger))}, drift ${drift > 0 ? '+' : ''}${major(drift)}`,
    );
  }

  if (!write) {
    logger.log('');
    logger.log('Nothing was written. Re-run with --write to record these as adjustments.');
    await app.close();
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  const written = await prisma.$transaction(async (tx) => {
    // Recomputed inside the transaction rather than reusing what was printed:
    // between the report and the write a player may have spent something, and
    // an entry for a drift that has since changed would create a new one.
    const rows = await drifting(tx);
    const entries: Array<{ username: string; amount: number }> = [];

    for (const row of rows) {
      const amount = row.balance - Number(row.ledger);
      if (amount === 0) continue;

      await tx.transaction.create({
        data: {
          userId: row.id,
          type: 'ADMIN_ADJUSTMENT',
          amount,
          // The balance is not touched, so this is what it already was.
          balanceAfter: row.balance,
          comment: `Ledger alignment on ${today}: a balance change that left no entry of its own`,
        },
      });
      entries.push({ username: row.username, amount });
    }

    return entries;
  });

  for (const entry of written) {
    logger.log(
      `${entry.username}: ADMIN_ADJUSTMENT ${entry.amount > 0 ? '+' : ''}${major(entry.amount)}`,
    );
  }

  const left = await drifting(prisma);
  if (left.length === 0) {
    logger.log(`Wrote ${written.length} entr(y/ies). Reconciliation is clean.`);
  } else {
    // Someone was mid-transaction while this ran. The next run picks up what
    // is left; nothing written above is wrong, it is simply not the whole of
    // it any more.
    logger.warn(
      `Wrote ${written.length} entr(y/ies), but ${left.length} account(s) still differ. ` +
        'Run it again once the site is quiet.',
    );
  }

  await app.close();
}

void main();
