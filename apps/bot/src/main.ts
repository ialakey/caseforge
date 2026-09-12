import path from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { Worker } from 'bullmq';
import { BotPool } from './bot-pool.ts';
import { WithdrawalProcessor } from './withdrawal-processor.ts';

dotenvConfig({ path: path.join(import.meta.dirname, '../../../.env') });

const WITHDRAWAL_QUEUE = 'withdrawals';

const prisma = new PrismaClient();

function redisConnection(): { host: string; port: number } {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6380');
  return { host: url.hostname, port: Number(url.port || 6379) };
}

async function main(): Promise<void> {
  const pool = new BotPool(prisma);
  await pool.start();

  if (pool.size === 0) {
    console.warn(
      '[bot] No bot is active. The worker keeps running, but withdrawal ' +
        'requests will fail with "no bot". Register bots via scripts/add-bot.ts.',
    );
  }

  const processor = new WithdrawalProcessor(prisma, pool);

  const worker = new Worker(
    WITHDRAWAL_QUEUE,
    async (job) => processor.process(job.data.withdrawalId as string),
    {
      connection: redisConnection(),
      // Valve throttles offer creation: aggressive parallelism is not an option.
      concurrency: 2,
      limiter: { max: 10, duration: 60_000 },
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`[bot] job ${job?.id} failed: ${err.message}`);
  });

  // Steam sends no webhooks — offer state is polled.
  const pollInterval = Number(process.env.WITHDRAWAL_POLL_INTERVAL_MS ?? 10_000);
  const timer = setInterval(() => {
    void processor.pollSentOffers().catch((err) => console.error(`[bot] polling: ${String(err)}`));
  }, pollInterval);

  console.log(`[bot] worker started, bots online: ${pool.size}`);

  const shutdown = async (): Promise<void> => {
    console.log('[bot] shutting down...');
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
