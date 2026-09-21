import path from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { Worker } from 'bullmq';
import { MARKET_API_URL, parseRedisUrl, type RedisConnectionOptions } from '@caseforge/shared';
import { BotPool } from './bot-pool.ts';
import { MarketPool } from './market-pool.ts';
import { WithdrawalProcessor } from './withdrawal-processor.ts';
import { MarketWithdrawalProcessor } from './market-processor.ts';
import { DepositProcessor } from './deposit-processor.ts';
import { SettingsReader } from './settings-reader.ts';

dotenvConfig({ path: path.join(import.meta.dirname, '../../../.env') });

const WITHDRAWAL_QUEUE = 'withdrawals';

const prisma = new PrismaClient();

/**
 * The whole URL, not just its host and port. A worker that dropped the
 * password would connect to nothing, and one that dropped the database number
 * would sit listening to a queue the API never writes to — both of which look
 * like withdrawals that are simply never processed.
 */
function redisConnection(): RedisConnectionOptions {
  return parseRedisUrl(process.env.REDIS_URL ?? 'redis://localhost:6380');
}

/**
 * The withdrawal worker.
 *
 * It consumes one queue and can fill a request through either channel. Which
 * one is decided when the request is made, not here: the row carries its own
 * `provider`, so a request already in flight keeps being handled by the half of
 * the worker that started it even after an operator flips the setting.
 *
 * The market channel is the one the site runs on by default — a single
 * market.csgo.com account buying each skin and having the seller deliver it
 * straight to the player. The bot farm is still here because a site that has
 * already funded one should not be forced off it, and because an account that
 * holds its own inventory is the only way to deliver something the market is
 * not selling.
 */
async function main(): Promise<void> {
  const settings = new SettingsReader(prisma);

  // Several market accounts, each throttled on its own: the five-requests-a-
  // second limit that deletes a key is counted per key, so one queue per key is
  // what turns a second account into extra throughput rather than decoration.
  const market = new MarketPool(prisma, process.env.MARKET_API_URL ?? MARKET_API_URL);
  await market.start();
  const marketProcessor = new MarketWithdrawalProcessor(prisma, market, settings);

  // The pool logs in whatever bots are registered. On a market-only site there
  // are none, and it costs nothing; the alternative — starting it on a setting
  // — would leave bot requests made a minute ago with nobody to answer them.
  const pool = new BotPool(prisma);
  await pool.start();
  const botProcessor = new WithdrawalProcessor(prisma, pool);
  // Deposits ride the same pool and the same poll loop. They have no queue of
  // their own: nothing about a deposit is urgent once it is created, because
  // the next move is the player's.
  const depositProcessor = new DepositProcessor(prisma, pool);

  if (market.size === 0) {
    console.warn(
      '[worker] no market account registered. Requests on the market channel will fail ' +
        'until one is; get a key at https://market.csgo.com/api and register it with ' +
        'pnpm --filter @caseforge/bot add-market-account.',
    );
  } else if (market.onlineCount === 0) {
    console.warn('[worker] market accounts are registered but none is answering');
  }
  if (pool.size === 0) {
    console.log('[worker] no Steam bots registered — the bot channel is unavailable');
  }

  const worker = new Worker(
    WITHDRAWAL_QUEUE,
    async (job) => {
      const withdrawalId = job.data.withdrawalId as string;
      const withdrawal = await prisma.withdrawal.findUnique({
        where: { id: withdrawalId },
        select: { provider: true },
      });
      if (!withdrawal) return;

      return withdrawal.provider === 'MARKET'
        ? marketProcessor.process(withdrawalId)
        : botProcessor.process(withdrawalId);
    },
    {
      connection: redisConnection(),
      // Both channels are throttled upstream — Valve on offer creation, the
      // market on requests per second — so parallelism here buys nothing.
      concurrency: 2,
      limiter: { max: 10, duration: 60_000 },
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`[worker] job ${job?.id} failed: ${err.message}`);
  });

  // Neither Steam nor the market sends a webhook: delivery is only ever learnt
  // by asking.
  const pollInterval = Number(process.env.WITHDRAWAL_POLL_INTERVAL_MS ?? 10_000);
  const timer = setInterval(() => {
    void botProcessor
      .pollSentOffers()
      .catch((err) => console.error(`[worker] polling offers: ${String(err)}`));
    void marketProcessor
      .pollOpenPurchases()
      .catch((err) => console.error(`[worker] polling purchases: ${String(err)}`));
    void depositProcessor
      .sendPending()
      .then(() => depositProcessor.pollSentOffers())
      .then(() => depositProcessor.expireStale())
      .catch((err) => console.error(`[worker] deposits: ${String(err)}`));
    // Picks up accounts an operator added or disabled while the worker ran.
    void market
      .reload()
      .then(() => market.refresh())
      .catch((err) => console.error(`[worker] refreshing market accounts: ${String(err)}`));
  }, pollInterval);

  console.log(
    `[worker] started, bots online: ${pool.size}, ` +
      `market accounts online: ${market.onlineCount}/${market.size}`,
  );

  const shutdown = async (): Promise<void> => {
    console.log('[worker] shutting down...');
    clearInterval(timer);
    await worker.close();
    pool.stop();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
