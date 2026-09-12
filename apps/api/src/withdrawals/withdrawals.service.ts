import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { ErrorCode } from '@caseforge/shared';
import { PrismaService } from '../common/prisma.service';
import { badRequest } from '../common/app-error';

export const WITHDRAWAL_QUEUE = 'withdrawals';

/** How many times the worker retries an offer before the request goes FAILED. */
const MAX_ATTEMPTS = 3;

@Injectable()
export class WithdrawalsService implements OnModuleDestroy {
  private readonly logger = new Logger(WithdrawalsService.name);
  private readonly queue: Queue;

  constructor(private readonly prisma: PrismaService) {
    const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6380');
    this.queue = new Queue(WITHDRAWAL_QUEUE, {
      connection: { host: url.hostname, port: Number(url.port || 6379) },
      defaultJobOptions: {
        attempts: MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }

  /**
   * The queue holds its own Redis connection and keeps the process alive. A
   * long-running API never notices; a one-shot script built on the same
   * AppModule simply hangs after finishing its work.
   */
  async onModuleDestroy(): Promise<void> {
    await this.queue.close().catch(() => undefined);
  }

  /**
   * Creates a withdrawal request.
   *
   * Items move to LOCKED in the same transaction that creates the request:
   * otherwise the player can sell an item while the bot is sending the offer,
   * and the site hands out something it has already paid a balance for.
   */
  async request(userId: string, inventoryItemIds: string[]) {
    const uniqueIds = [...new Set(inventoryItemIds)];

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tradeUrl: true, isBanned: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.isBanned) throw badRequest(ErrorCode.ACCOUNT_BANNED, 'Account is banned');
    if (!user.tradeUrl) throw badRequest(ErrorCode.TRADE_URL_MISSING, 'Set your Steam trade URL first');

    const withdrawal = await this.prisma.$transaction(async (tx) => {
      const items = await tx.inventoryItem.findMany({
        where: { id: { in: uniqueIds }, userId, status: 'AVAILABLE' },
      });
      if (items.length !== uniqueIds.length) {
        throw badRequest(ErrorCode.ITEM_UNAVAILABLE, 'Some items are not available for withdrawal');
      }

      const totalValue = items.reduce((sum, i) => sum + i.acquiredPrice, 0);

      const created = await tx.withdrawal.create({
        data: { userId, totalValue, tradeUrl: user.tradeUrl!, status: 'PENDING' },
      });

      const locked = await tx.inventoryItem.updateMany({
        where: { id: { in: uniqueIds }, userId, status: 'AVAILABLE' },
        data: { status: 'LOCKED', withdrawalId: created.id },
      });
      if (locked.count !== uniqueIds.length) {
        // Someone claimed an item between findMany and updateMany — roll the
        // whole transaction back, no request is created.
        throw badRequest(ErrorCode.ITEMS_CHANGED, 'Items changed, please try again');
      }

      return created;
    });

    // jobId = the request id: a repeat call creates no second offer even if
    // the client fires the request twice.
    await this.queue.add(
      'process',
      { withdrawalId: withdrawal.id },
      { jobId: withdrawal.id },
    );

    this.logger.log(`Withdrawal ${withdrawal.id} queued`);
    return withdrawal;
  }

  async list(userId: string) {
    return this.prisma.withdrawal.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { items: { include: { item: true } } },
    });
  }

  /**
   * Cancels a request. Possible while the bot has not sent the offer yet —
   * afterwards the items are in flight and the offer itself must be cancelled
   * in Steam.
   */
  async cancel(userId: string, withdrawalId: string) {
    return this.prisma.$transaction(async (tx) => {
      const withdrawal = await tx.withdrawal.findFirst({
        where: { id: withdrawalId, userId },
      });
      if (!withdrawal) throw new NotFoundException('Request not found');
      if (withdrawal.status !== 'PENDING') {
        throw badRequest(ErrorCode.WITHDRAWAL_NOT_CANCELLABLE, 'This request can no longer be cancelled');
      }

      const cancelled = await tx.withdrawal.updateMany({
        where: { id: withdrawalId, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      });
      if (cancelled.count === 0) {
        throw badRequest(ErrorCode.WITHDRAWAL_NOT_CANCELLABLE, 'The request is already being processed');
      }

      await tx.inventoryItem.updateMany({
        where: { withdrawalId, userId },
        data: { status: 'AVAILABLE', withdrawalId: null },
      });

      return { ok: true as const };
    });
  }
}
