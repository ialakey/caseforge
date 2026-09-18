/**
 * Re-solves the odds of cases whose RTP has drifted out of the corridor.
 *
 * A case is balanced once, against the prices its items had that day. Then the
 * hourly synchronisation re-prices those items, and the case's real RTP moves
 * with them — quietly, because nothing re-solves it. Drift upwards past the
 * cap is the expensive direction: the case pays out more than it takes, and
 * the only sign is a line in the log.
 *
 * This walks the catalogue, recomputes each case's RTP from today's prices and
 * re-solves the ones that have drifted. The price is left alone and only the
 * odds move: a price is an operator's decision and a player may have seen it
 * yesterday, while the odds are a derived quantity that was already wrong.
 *
 * Run:  pnpm --filter @caseforge/api rebalance-cases -- [options]
 *
 *   --rtp=<0.9>     target to solve for (default 0.9, the middle of the corridor)
 *   --slug=<slug>   only this case, repeatable
 *   --all           re-solve every case, not only the drifted ones
 *   --dry-run       report what would change, write nothing
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  autoBalance,
  calculateRtp,
  judgeRtp,
  resolveItemPrice,
  RTP_CORRIDOR,
} from '@caseforge/shared';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma.service';
import { AdminService } from '../src/admin/admin.service';

function arg(name: string, fallback?: string): string | undefined {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (found) return found.slice(name.length + 3);
  return process.argv.includes(`--${name}`) ? 'true' : fallback;
}

async function main(): Promise<void> {
  const logger = new Logger('RebalanceCases');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  // The same reason the catalogue importer does it: the context starts the
  // application's cron jobs, and the price synchronisation re-pricing items
  // underneath this script is precisely the race it exists to repair.
  const scheduler = app.get(SchedulerRegistry);
  for (const [name] of scheduler.getCronJobs()) scheduler.deleteCronJob(name);

  const prisma = app.get(PrismaService);
  const admin = app.get(AdminService);

  const actor = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  if (!actor) throw new Error('No administrator exists — run pnpm db:seed first');

  const targetRtp = Number(arg('rtp', '0.9'));
  const dryRun = arg('dry-run') === 'true';
  const everything = arg('all') === 'true';
  const slugs = process.argv
    .filter((a) => a.startsWith('--slug='))
    .map((a) => a.slice('--slug='.length));

  const cases = await prisma.case.findMany({
    where: slugs.length > 0 ? { slug: { in: slugs } } : {},
    include: { items: { include: { item: true } } },
    orderBy: { sortOrder: 'asc' },
  });

  let fixed = 0;
  let healthy = 0;
  const problems: string[] = [];

  for (const gameCase of cases) {
    const priced = gameCase.items
      .map((ci) => ({
        itemId: ci.itemId,
        price: resolveItemPrice(ci.item),
        rangeFrom: ci.rangeFrom,
        rangeTo: ci.rangeTo,
      }))
      .filter((i) => i.price > 0);

    if (priced.length < 2) {
      problems.push(`${gameCase.slug}: ${priced.length} priced item(s) — nothing to solve`);
      continue;
    }

    // A free case has no RTP: nothing is staked, so there is no ratio to
    // drift. Its odds were shaped against a reference price that is not
    // recorded anywhere, and re-solving at a price of zero would divide by it.
    if (gameCase.isFree) {
      healthy += 1;
      continue;
    }

    // Today's RTP, not the cached one: the cached number is exactly what went
    // stale, so trusting it here would hide the drift this script looks for.
    const currentRtp = calculateRtp(priced, gameCase.price);
    const verdict = judgeRtp(currentRtp);

    const drifted = currentRtp > RTP_CORRIDOR.max || currentRtp < RTP_CORRIDOR.min;
    if (!drifted && !everything) {
      healthy += 1;
      continue;
    }

    const balanced = autoBalance(priced, gameCase.price, targetRtp);
    if (!balanced.ok) {
      // Unsolvable at this price is a decision for an operator, not for a
      // script: the fix is a different price or a different loot table, and
      // both change what the case is.
      problems.push(
        `${gameCase.slug} (${gameCase.name}): RTP ${(currentRtp * 100).toFixed(1)}% and ` +
          `not solvable at ${(gameCase.price / 100).toFixed(2)} — ${balanced.reason}`,
      );
      continue;
    }

    if (dryRun) {
      logger.log(
        `  [dry] ${gameCase.name}: ${(currentRtp * 100).toFixed(1)}% -> ` +
          `${(balanced.actualRtp * 100).toFixed(1)}% (${verdict.code})`,
      );
      fixed += 1;
      continue;
    }

    // Saved through the admin service rather than straight into the table: it
    // re-checks the ranges and the verdict, writes the audit entry and drops
    // the catalogue cache. A script that wrote odds directly would be the one
    // path into a case that skips every one of those.
    await admin.upsertCase(
      actor.id,
      {
        slug: gameCase.slug,
        name: gameCase.name,
        nameEn: gameCase.nameEn,
        price: gameCase.price,
        // Passed through rather than assumed: this script rewrites odds, and
        // it must not be the thing that quietly changes what a case costs.
        isFree: gameCase.isFree,
        imageUrl: gameCase.imageUrl,
        isActive: gameCase.isActive,
        sortOrder: gameCase.sortOrder,
        items: priced.map((p, i) => ({
          itemId: p.itemId,
          rangeFrom: balanced.ranges[i]!.rangeFrom,
          rangeTo: balanced.ranges[i]!.rangeTo,
        })),
      },
      null,
    );

    fixed += 1;
    logger.log(
      `  ${gameCase.name}: RTP ${(currentRtp * 100).toFixed(1)}% -> ` +
        `${(balanced.actualRtp * 100).toFixed(1)}%, price left at ` +
        `${(gameCase.price / 100).toFixed(2)}`,
    );
  }

  logger.log(
    `Done: ${fixed} case(s) re-solved, ${healthy} already inside the corridor, ` +
      `${problems.length} left alone`,
  );
  for (const problem of problems) logger.warn(`  ${problem}`);

  await app.close();
}

void main();
