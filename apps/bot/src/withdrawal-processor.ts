import type { PrismaClient } from '@prisma/client';
import type { BotPool } from './bot-pool.ts';
import { TradeOfferState } from './steam-bot.ts';

/**
 * Longest trade hold we will still send an offer for.
 * Zero means instant delivery only: an item stuck in escrow for a week
 * generates a stream of support tickets.
 */
const MAX_ESCROW_DAYS = 0;

export class WithdrawalProcessor {
  private readonly prisma: PrismaClient;
  private readonly pool: BotPool;

  constructor(prisma: PrismaClient, pool: BotPool) {
    this.prisma = prisma;
    this.pool = pool;
  }

  /**
   * Processes a single request.
   *
   * Idempotent by withdrawalId: BullMQ retries jobs, and a repeat run must not
   * send a second offer — otherwise the player receives the items twice while
   * the site writes them off once.
   */
  async process(withdrawalId: string): Promise<void> {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
      include: { items: true },
    });
    if (!withdrawal) {
      console.warn(`[withdrawal] ${withdrawalId} not found, skipping`);
      return;
    }

    // The request already left or is closed — reprocessing is not allowed.
    if (withdrawal.status !== 'PENDING') {
      console.log(`[withdrawal] ${withdrawalId} is ${withdrawal.status}, skipping`);
      return;
    }

    // Move to PROCESSING conditionally: if a parallel worker got there first
    // the count is 0 and the job is theirs, not ours.
    const claimed = await this.prisma.withdrawal.updateMany({
      where: { id: withdrawalId, status: 'PENDING' },
      data: { status: 'PROCESSING', attempts: { increment: 1 } },
    });
    if (claimed.count === 0) {
      console.log(`[withdrawal] ${withdrawalId} already claimed by another worker`);
      return;
    }

    try {
      const itemIds = withdrawal.items.map((i) => i.itemId);
      const match = await this.pool.findBotFor(itemIds);
      if (!match) {
        throw new Error('No bot holds every item in the request');
      }

      // The hold is checked BEFORE sending: otherwise the items go into
      // escrow and the request is formally "sent" while actually stuck for a
      // week.
      const escrowDays = await match.bot.getEscrowDays(withdrawal.tradeUrl);
      if (escrowDays > MAX_ESCROW_DAYS) {
        throw new Error(
          `Trade hold of ${escrowDays} day(s). Enable the Steam mobile authenticator and retry.`,
        );
      }

      const offer = await match.bot.sendOffer({
        tradeUrl: withdrawal.tradeUrl,
        assetIds: match.assetIds,
        message: `Item withdrawal, request ${withdrawal.id}`,
      });

      await this.prisma.withdrawal.update({
        where: { id: withdrawalId },
        data: {
          status: 'SENT',
          botId: match.bot.id,
          tradeOfferId: offer.tradeOfferId,
          sentAt: new Date(),
        },
      });

      console.log(`[withdrawal] ${withdrawalId}: offer ${offer.tradeOfferId} sent`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.fail(withdrawalId, message);
      throw err; // let BullMQ decide whether to retry
    }
  }

  /**
   * Polls the offers already sent.
   *
   * Steam sends no webhooks — offer state can only be polled.
   */
  async pollSentOffers(): Promise<void> {
    const sent = await this.prisma.withdrawal.findMany({
      where: { status: 'SENT', tradeOfferId: { not: null }, botId: { not: null } },
    });

    for (const withdrawal of sent) {
      const bot = this.pool.get(withdrawal.botId!);
      if (!bot?.isReady) continue;

      try {
        const state = await bot.getOfferState(withdrawal.tradeOfferId!);

        if (state === TradeOfferState.Accepted) {
          await this.complete(withdrawal.id);
        } else if (
          state === TradeOfferState.Declined ||
          state === TradeOfferState.Expired ||
          state === TradeOfferState.Canceled ||
          state === TradeOfferState.InvalidItems ||
          state === TradeOfferState.CanceledBySecondFactor
        ) {
          await this.fail(withdrawal.id, `Offer ended in state ${state}`);
        }
        // Active and InEscrow — keep waiting.
      } catch (err) {
        console.error(`[withdrawal] polling ${withdrawal.id}: ${String(err)}`);
      }
    }
  }

  private async complete(withdrawalId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.withdrawal.update({
        where: { id: withdrawalId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      await tx.inventoryItem.updateMany({
        where: { withdrawalId },
        data: { status: 'WITHDRAWN' },
      });
    });
    console.log(`[withdrawal] ${withdrawalId}: the player accepted the offer`);
  }

  /**
   * Failing a request: the items must return to the player's site inventory.
   * Leaving them LOCKED would quietly confiscate a drop already paid for.
   */
  private async fail(withdrawalId: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.withdrawal.update({
        where: { id: withdrawalId },
        data: { status: 'FAILED', failureReason: reason },
      });
      await tx.inventoryItem.updateMany({
        where: { withdrawalId },
        data: { status: 'AVAILABLE', withdrawalId: null },
      });
    });
    console.error(`[withdrawal] ${withdrawalId} failed: ${reason}`);
  }
}
