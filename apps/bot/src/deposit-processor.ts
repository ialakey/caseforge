import type { PrismaClient } from '@prisma/client';
import type { BotPool } from './bot-pool.ts';
import { TradeOfferState } from './steam-bot.ts';

/**
 * How many pending deposits are picked up in one sweep.
 *
 * Valve throttles offer creation, so a large batch would only queue up inside
 * the Steam client and make the sweep look faster than it is.
 */
const BATCH = 5;

/**
 * Deposits of skins, from the Steam side.
 *
 * This worker owns the trade and nothing else. It asks the player for the
 * items, watches the offer, and records what Steam said — but it never touches
 * a balance. Crediting belongs to the API, which owns the ledger; a bot worker
 * that could mint balance would be a second place where money is created, and
 * the reconciliation job would have two sources to argue with instead of one.
 *
 * So the handover is a status: this worker takes a deposit as far as ACCEPTED
 * and stops. The API turns ACCEPTED into CREDITED.
 */
export class DepositProcessor {
  private readonly prisma: PrismaClient;
  private readonly pool: BotPool;

  constructor(prisma: PrismaClient, pool: BotPool) {
    this.prisma = prisma;
    this.pool = pool;
  }

  /**
   * Sends offers for requests that do not have one yet.
   *
   * Polled rather than queued, unlike withdrawals. A withdrawal is created by
   * an act of the player and wants to leave at once; a deposit is already
   * waiting on that player to open Steam, so a few seconds at the front make no
   * difference and a sweep is one moving part fewer.
   */
  async sendPending(): Promise<void> {
    const pending = await this.prisma.itemDeposit.findMany({
      where: { status: 'PENDING', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
      include: { items: true },
    });

    for (const deposit of pending) {
      const bot = await this.pool.withCapacity(deposit.items.length);
      if (!bot) {
        // Not a failure: the request keeps its place and the next sweep tries
        // again, until it expires on its own.
        console.warn(`[deposit] ${deposit.id}: no bot online with room, leaving it pending`);
        continue;
      }

      try {
        // Claimed before the offer is built. Two sweeps overlapping would
        // otherwise each send an offer for the same asset ids, and the second
        // one is an offer Steam refuses in a way that reads like a bug.
        const claimed = await this.prisma.itemDeposit.updateMany({
          where: { id: deposit.id, status: 'PENDING' },
          data: { status: 'OFFER_SENT', botId: bot.id, attempts: { increment: 1 } },
        });
        if (claimed.count === 0) continue;

        const offer = await bot.requestItems({
          tradeUrl: deposit.tradeUrl,
          assetIds: deposit.items.map((i) => i.assetId),
          message: `Deposit ${deposit.id} — ${(deposit.totalValue / 100).toFixed(2)} will be credited once you accept`,
        });

        await this.prisma.itemDeposit.update({
          where: { id: deposit.id },
          data: { tradeOfferId: offer.tradeOfferId, sentAt: new Date() },
        });

        console.log(`[deposit] ${deposit.id}: offer ${offer.tradeOfferId} sent`);
      } catch (err) {
        // Back to PENDING rather than FAILED: the usual cause is a bot that
        // dropped its session, and the next sweep with another bot will work.
        // `attempts` is what stops that being an infinite retry.
        const reason = err instanceof Error ? err.message : String(err);
        await this.prisma.itemDeposit.update({
          where: { id: deposit.id },
          data:
            deposit.attempts >= 3
              ? { status: 'FAILED', failureReason: reason, completedAt: new Date() }
              : { status: 'PENDING', botId: null, failureReason: reason },
        });
        console.error(`[deposit] ${deposit.id}: ${reason}`);
      }
    }
  }

  /**
   * Watches the offers already with players.
   *
   * Steam sends no webhooks, so an accepted trade is only ever learnt by
   * asking. An offer that ended any way but Accepted is closed here: nothing
   * arrived, so nothing is owed.
   */
  async pollSentOffers(): Promise<void> {
    const sent = await this.prisma.itemDeposit.findMany({
      where: { status: 'OFFER_SENT', tradeOfferId: { not: null }, botId: { not: null } },
    });

    for (const deposit of sent) {
      const bot = this.pool.get(deposit.botId!);
      if (!bot?.isReady) continue;

      try {
        const state = await bot.getOfferState(deposit.tradeOfferId!);

        if (state === TradeOfferState.Accepted) {
          // ACCEPTED and no further: the API credits it. This worker has said
          // everything it knows, which is that the skins arrived.
          await this.prisma.itemDeposit.update({
            where: { id: deposit.id },
            data: { status: 'ACCEPTED' },
          });
          console.log(`[deposit] ${deposit.id}: accepted, awaiting credit`);
        } else if (
          state === TradeOfferState.Declined ||
          state === TradeOfferState.Expired ||
          state === TradeOfferState.Canceled ||
          state === TradeOfferState.InvalidItems ||
          state === TradeOfferState.CanceledBySecondFactor
        ) {
          await this.prisma.itemDeposit.update({
            where: { id: deposit.id },
            data: {
              status: 'DECLINED',
              failureReason: `Offer ended in state ${state}`,
              completedAt: new Date(),
            },
          });
          console.log(`[deposit] ${deposit.id}: declined (state ${state})`);
        }
        // Active and InEscrow — keep waiting. Escrow is the player's own doing
        // here: without a mobile authenticator Steam holds their skins for
        // days, and the deposit simply completes when it completes.
      } catch (err) {
        console.error(`[deposit] polling ${deposit.id}: ${String(err)}`);
      }
    }
  }

  /**
   * Closes requests nobody acted on.
   *
   * The quote is frozen at request time, so an offer left open indefinitely is
   * a promise at last week's prices. Expiring it is what keeps the frozen
   * valuation honest.
   */
  async expireStale(): Promise<void> {
    const expired = await this.prisma.itemDeposit.updateMany({
      where: { status: { in: ['PENDING', 'OFFER_SENT'] }, expiresAt: { lt: new Date() } },
      data: {
        status: 'DECLINED',
        failureReason: 'The offer expired before it was accepted',
        completedAt: new Date(),
      },
    });
    if (expired.count > 0) console.log(`[deposit] expired ${expired.count} stale request(s)`);
  }
}
