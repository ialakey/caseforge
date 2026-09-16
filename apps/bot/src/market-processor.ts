import type { MarketPurchase, PrismaClient } from '@prisma/client';
import {
  BASE_CURRENCY,
  type MarketBuyInfo,
  MarketError,
  classifyStage,
  describeCancellation,
  fromMarketMajor,
  fromMarketPrice,
  maxPayable,
  parseTradeUrl,
  pickOffer,
  resolveItemPrice,
  toMarketPrice,
} from '@caseforge/shared';
import { NoMarketAccountError } from './market-pool.ts';
import type { MarketPool, PooledAccount } from './market-pool.ts';
import type { SettingsReader } from './settings-reader.ts';

/**
 * Withdrawals filled by buying on market.csgo.com.
 *
 * The site owns no skins. A request turns into one purchase per item: the
 * market account pays for the exact item and names the player's trade link as
 * the recipient, so the seller delivers straight to them. Nothing passes
 * through an account of ours, which is the whole reason for doing it this way —
 * no inventory to fund, no 1000-slot ceiling, no "sorry, no bot has that skin".
 *
 * What it buys in exchange is that a request is no longer atomic. Three items
 * are three sellers, and one of them can vanish while the other two deliver. So
 * the unit of truth here is the purchase, not the request: the request's status
 * is computed from its purchases every time one of them moves, and an item goes
 * back to the player's inventory only when the purchase for it demonstrably did
 * not happen.
 *
 * Read `settle` first — everything else exists to feed it.
 */

/**
 * How long a purchase we tried to make may stay unaccounted for before it is
 * treated as never having happened.
 *
 * The market's own guidance is to wait ten to fifteen minutes before reading
 * back the status of a purchase, so anything shorter would routinely conclude
 * "never bought" about a purchase that was about to appear — and hand the
 * player their item back while a seller was delivering the real one.
 */
const UNCONFIRMED_GRACE_MS = 15 * 60_000;

/** How many purchases to ask about in one `get-list-buy-info-by-custom-id`. */
const POLL_BATCH = 20;

interface TradeTarget {
  partner: string;
  token: string;
}

export class MarketWithdrawalProcessor {
  // Fields declared and assigned rather than written as constructor parameter
  // properties: the worker runs straight off the .ts sources under Node's
  // strip-only type removal, which cannot desugar them.
  private readonly prisma: PrismaClient;
  private readonly pool: MarketPool;
  private readonly settings: SettingsReader;

  constructor(prisma: PrismaClient, pool: MarketPool, settings: SettingsReader) {
    this.prisma = prisma;
    this.pool = pool;
    this.settings = settings;
  }

  /**
   * Fills one request.
   *
   * Re-entrant on purpose. A job that dies halfway leaves some items bought and
   * some not, and the retry has to pick up where it stopped rather than start
   * again — which is why the loop skips any purchase that is no longer PENDING
   * instead of trusting the request's own status.
   */
  async process(withdrawalId: string): Promise<void> {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
      include: { items: { include: { inventoryItem: { include: { item: true } } } } },
    });
    if (!withdrawal) {
      console.warn(`[market] withdrawal ${withdrawalId} not found, skipping`);
      return;
    }
    if (withdrawal.provider !== 'MARKET') {
      console.log(`[market] ${withdrawalId} belongs to the ${withdrawal.provider} channel`);
      return;
    }
    if (withdrawal.status !== 'PENDING' && withdrawal.status !== 'PROCESSING') {
      console.log(`[market] ${withdrawalId} is ${withdrawal.status}, skipping`);
      return;
    }

    // BullMQ never runs two jobs with the same id at once, so this is not the
    // mutex — it is the record that an attempt started, and the attempt counter
    // the back office reports on.
    const claimed = await this.prisma.withdrawal.updateMany({
      where: { id: withdrawalId, status: { in: ['PENDING', 'PROCESSING'] } },
      data: { status: 'PROCESSING', attempts: { increment: 1 } },
    });
    if (claimed.count === 0) {
      console.log(`[market] ${withdrawalId} moved on before it could be claimed`);
      return;
    }

    const target = parseTradeUrl(withdrawal.tradeUrl);
    if (!target) {
      // Stored trade URLs are validated on the way in, so this means the row was
      // edited by hand. Nothing has been bought yet, so refusing costs nothing.
      await this.abandon(withdrawalId, 'The trade URL on the request cannot be parsed');
      return;
    }

    // Health is read from the pool's snapshot rather than by asking the market
    // here: with several accounts that would be two requests per account per
    // withdrawal, spent on a question the pool already refreshes on a timer.
    await this.pool.refresh();

    const overpayBps = await this.settings.read<number>('withdrawals.market.maxOverpayBps');
    const minChance = await this.settings.read<number>('withdrawals.market.minSellerChance');

    let uncertain = false;

    try {
      for (const line of withdrawal.items) {
        const purchase = await this.ensurePurchase(withdrawalId, line.inventoryItem, overpayBps);
        if (purchase.status !== 'PENDING') continue;

        try {
          await this.buy(purchase, target, minChance);
        } catch (err) {
          if (err instanceof MarketError && err.marketError !== null) {
            // The market answered and said no: nothing was charged, so this one
            // item is refused and the rest of the request carries on.
            await this.failPurchase(purchase.id, err.marketError);
            continue;
          }
          if (err instanceof NoMarketAccountError) {
            // Nothing was charged either, and the reason is one the player is
            // owed: leaving it only in the log would hand them their item back
            // with "failed" and no explanation at all.
            await this.failPurchase(purchase.id, err.message);
            continue;
          }
          // Anything else — a timeout, a dropped connection — leaves us not
          // knowing whether the account was charged. The row stays PENDING with
          // its attempt recorded, and the poller resolves it by custom id.
          uncertain = true;
          console.error(`[market] purchase ${purchase.id} is unresolved: ${String(err)}`);
        }
      }
    } finally {
      // Whatever went wrong, the request and its items are brought back into
      // agreement with the purchases before this returns. Skipping it would
      // leave items locked against a request that says nothing is happening.
      await this.settle(withdrawalId).catch((err) =>
        console.error(`[market] settling ${withdrawalId}: ${String(err)}`),
      );
    }

    if (uncertain) {
      // Surfaces in the queue as a failed job, which is the honest signal: the
      // request is not finished and somebody should know.
      throw new Error(`Withdrawal ${withdrawalId} has purchases the market has not confirmed`);
    }
  }

  /**
   * Buys one item.
   *
   * The order matters. The attempt is recorded before the request goes out,
   * because a purchase we cannot prove we made has to be findable afterwards,
   * and the only handle on it is the row's own id travelling as `custom_id`.
   */
  private async buy(
    purchase: MarketPurchase,
    target: TradeTarget,
    minChance: number,
  ): Promise<void> {
    // A retry goes back to the account that made the first attempt and to no
    // other. The market answers `get-buy-info-by-custom-id` for the key that
    // made the purchase only, so asking a different account would truthfully
    // report "never heard of it" about a purchase that had been paid for — and
    // this method would then buy the skin a second time.
    if (purchase.attempts > 0 && purchase.accountId) {
      const previous = this.pool.clientFor(purchase.accountId);
      if (!previous) {
        // The account was deleted between the attempt and the retry. Nothing
        // here can establish whether the money moved, so the purchase is left
        // alone for a human rather than resolved by guessing.
        throw new Error(
          `Purchase ${purchase.id} was attempted on account ${purchase.accountId}, which is gone`,
        );
      }
      await this.pool.noteUsed(purchase.accountId);
      const info = (await previous.buyInfoByCustomId([purchase.id])).get(purchase.id);
      if (info) {
        await this.applyBuyInfo(purchase, info);
        return;
      }
    }

    const { record, client } = this.claimFor(purchase);
    const currency = record.currency ?? BASE_CURRENCY;

    const capUnits = toMarketPrice(purchase.maxPrice, currency);
    const { offers } = await client.searchByHashName(purchase.marketHashName);
    const offer = pickOffer(offers, capUnits);
    if (!offer) {
      const cheapest = offers.length > 0 ? Math.min(...offers.map((o) => o.price)) : null;
      await this.failPurchase(
        purchase.id,
        cheapest === null
          ? 'Nobody is selling this item on the market right now'
          : `The cheapest offer is ${fromMarketPrice(cheapest, currency)} against a ceiling of ${purchase.maxPrice}`,
      );
      return;
    }

    // The account is written down before the money can move, together with the
    // attempt. Buying first and recording afterwards would, on a dropped
    // connection, leave a charge nobody can trace to the key that made it.
    await this.prisma.marketPurchase.update({
      where: { id: purchase.id },
      data: { accountId: record.id, attempts: { increment: 1 } },
    });
    await this.pool.noteUsed(record.id);

    // The cap rather than the offer's own price: the market reads `price` as a
    // maximum, and the listing we found is regularly gone by the time the buy
    // lands. Passing the ceiling lets it take the next-cheapest seller instead
    // of failing, and the ceiling is the number the operator actually chose.
    const { marketId } = await client.buyFor({
      hashName: purchase.marketHashName,
      price: capUnits,
      partner: target.partner,
      token: target.token,
      customId: purchase.id,
      minChance,
    });

    await this.prisma.marketPurchase.update({
      where: { id: purchase.id },
      data: { status: 'BOUGHT', marketId, boughtAt: new Date(), failureReason: null },
    });
    console.log(
      `[market] purchase ${purchase.id}: bought ${purchase.marketHashName} (${marketId}) on ${record.label}`,
    );
  }

  /**
   * The account that will pay for this purchase.
   *
   * Throws a NoMarketAccountError, which the caller turns into a failed
   * purchase with the reason attached. Nothing has been charged at this point,
   * so the item can go back honestly — and the reason says which of the three
   * operator problems it is: no key registered, none online, or none funded.
   */
  private claimFor(purchase: MarketPurchase): PooledAccount {
    const claimed = this.pool.claim(purchase.maxPrice);
    if (!claimed) throw new NoMarketAccountError(this.pool.explain(purchase.maxPrice));
    return claimed;
  }

  /**
   * The row that says "this item is being bought".
   *
   * Keyed by the inventory item and unique on it, which is what makes paying
   * twice for one skin a database error rather than a discovery on the bank
   * statement. A row left over from a withdrawal that failed is reused: the
   * item was never bought, so the constraint is still telling the truth, and
   * the request keeps the history of what went wrong the first time.
   */
  private async ensurePurchase(
    withdrawalId: string,
    inv: {
      id: string;
      itemId: string;
      acquiredPrice: number;
      item: { marketHashName: string; marketPrice: number; priceOverride: number | null };
    },
    overpayBps: number,
  ): Promise<MarketPurchase> {
    const existing = await this.prisma.marketPurchase.findUnique({
      where: { inventoryItemId: inv.id },
    });

    // A row already belonging to this request is returned untouched. Rewriting
    // it — even just its ceiling — is how a retry loses track of a purchase
    // that has already been paid for.
    if (existing && existing.withdrawalId === withdrawalId) return existing;

    if (existing && existing.status !== 'FAILED' && existing.status !== 'PENDING') {
      // Unreachable by design: a bought item stays LOCKED and a delivered one
      // WITHDRAWN, so neither can be picked up by a new request. If it does
      // happen, something has released an item it should not have, and paying
      // for it a second time is the worst possible way to find out.
      throw new Error(
        `Inventory item ${inv.id} is in a new request but its purchase is ${existing.status}`,
      );
    }

    // The ceiling follows today's catalogue price, not the price the item was
    // credited at, because the player owns an item rather than an amount: a
    // skin that has doubled since it dropped must still be withdrawable. The
    // floor is what they were credited, so an item an operator has marked down
    // cannot become impossible to take out.
    const reference = Math.max(resolveItemPrice(inv.item), inv.acquiredPrice);
    const maxPrice = maxPayable(reference, overpayBps);

    // Anything else is a leftover from an earlier request that failed — the
    // item was never bought, so the row is reset onto this one. The unique
    // constraint on the inventory item is what keeps that the only possibility.
    return this.prisma.marketPurchase.upsert({
      where: { inventoryItemId: inv.id },
      create: {
        withdrawalId,
        inventoryItemId: inv.id,
        itemId: inv.itemId,
        marketHashName: inv.item.marketHashName,
        maxPrice,
      },
      update: {
        withdrawalId,
        maxPrice,
        marketHashName: inv.item.marketHashName,
        status: 'PENDING',
        stage: null,
        marketId: null,
        tradeOfferId: null,
        paidPrice: null,
        failureReason: null,
        attempts: 0,
        boughtAt: null,
        deliveredAt: null,
      },
    });
  }

  /**
   * Polls everything still in flight.
   *
   * There is no webhook, so this is the only way an item ever becomes
   * delivered. It covers two populations: purchases we know were paid for and
   * are waiting on a seller, and purchases we tried to make and never got an
   * answer about. The second group is the expensive one to get wrong, so it is
   * resolved by asking the market rather than by assuming.
   */
  async pollOpenPurchases(): Promise<void> {
    const open = await this.prisma.marketPurchase.findMany({
      where: {
        OR: [{ status: 'BOUGHT' }, { status: 'PENDING', attempts: { gt: 0 } }],
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    if (open.length === 0) return;

    const touched = new Set<string>();

    // Grouped by account, because a key can only be asked about its own
    // purchases. Polling everything through one key would have it truthfully
    // answer "never heard of it" for every purchase made elsewhere, and the
    // grace period would then write off items that had been paid for.
    const byAccount = new Map<string, MarketPurchase[]>();
    for (const purchase of open) {
      if (!purchase.accountId) {
        console.warn(
          `[market] purchase ${purchase.id} has no account and cannot be polled; ` +
            'it predates the account pool and needs settling by hand',
        );
        continue;
      }
      const bucket = byAccount.get(purchase.accountId);
      if (bucket) bucket.push(purchase);
      else byAccount.set(purchase.accountId, [purchase]);
    }

    for (const [accountId, purchases] of byAccount) {
      const client = this.pool.clientFor(accountId);
      if (!client) {
        console.warn(
          `[market] account ${accountId} is gone; ${purchases.length} purchase(s) cannot be polled`,
        );
        continue;
      }
      await this.pollForAccount(accountId, client, purchases, touched);
    }

    for (const withdrawalId of touched) {
      await this.settle(withdrawalId).catch((err) =>
        console.error(`[market] settling ${withdrawalId}: ${String(err)}`),
      );
    }

    await this.reportStuck();
  }

  /** Asks one account about its own open purchases, in batches. */
  private async pollForAccount(
    accountId: string,
    client: { buyInfoByCustomId: (ids: string[]) => Promise<Map<string, MarketBuyInfo>> },
    purchases: MarketPurchase[],
    touched: Set<string>,
  ): Promise<void> {
    for (let i = 0; i < purchases.length; i += POLL_BATCH) {
      const batch = purchases.slice(i, i + POLL_BATCH);
      let infos: Map<string, MarketBuyInfo>;
      try {
        await this.pool.noteUsed(accountId);
        infos = await client.buyInfoByCustomId(batch.map((p) => p.id));
      } catch (err) {
        console.error(`[market] polling account ${accountId}: ${String(err)}`);
        return;
      }

      for (const purchase of batch) {
        const info = infos.get(purchase.id);

        if (!info) {
          if (purchase.status === 'PENDING' && this.isOlderThanGrace(purchase)) {
            // Long past the window in which the account that was asked would
            // have shown us a purchase it had taken money for. It never
            // happened.
            await this.failPurchase(purchase.id, 'The market has no record of this purchase');
            touched.add(purchase.withdrawalId);
          }
          continue;
        }

        const before = purchase.status;
        await this.applyBuyInfo(purchase, info);
        const after = classifyStage(info.stage);
        if (after !== 'PENDING' || before === 'PENDING') touched.add(purchase.withdrawalId);
      }
    }
  }

  /** Writes what the market says about a purchase onto our row. */
  private async applyBuyInfo(purchase: MarketPurchase, info: MarketBuyInfo): Promise<void> {
    const outcome = classifyStage(info.stage);

    await this.prisma.marketPurchase.update({
      where: { id: purchase.id },
      data: {
        // Seeing it at all means the money was taken, whatever stage it is in.
        status: outcome === 'PENDING' ? 'BOUGHT' : outcome,
        stage: info.stage ?? null,
        // `buy-for` and `get-buy-info` do not name the purchase with the same
        // id, so whichever we learnt first is kept: overwriting it would leave
        // support quoting an id the other endpoint has never heard of. The
        // fallback matters for an adopted purchase, where the reply to the buy
        // was lost and this is the only id we will ever have.
        marketId: purchase.marketId ?? info.item_id ?? undefined,
        tradeOfferId: info.trade_id ?? undefined,
        paidPrice: info.paid === undefined ? undefined : fromMarketMajor(info.paid),
        boughtAt: info.time ? new Date(info.time * 1000) : undefined,
        deliveredAt: outcome === 'DELIVERED' ? new Date() : undefined,
        failureReason: outcome === 'FAILED' ? describeCancellation(info) : null,
      },
    });
  }

  private async failPurchase(purchaseId: string, reason: string): Promise<void> {
    await this.prisma.marketPurchase.update({
      where: { id: purchaseId },
      data: { status: 'FAILED', failureReason: reason },
    });
    console.warn(`[market] purchase ${purchaseId} failed: ${reason}`);
  }

  private isOlderThanGrace(purchase: MarketPurchase): boolean {
    return Date.now() - purchase.updatedAt.getTime() > UNCONFIRMED_GRACE_MS;
  }

  /**
   * Recomputes a request from its purchases, and moves its items with it.
   *
   * This is the only place inventory items change hands, and the rule it
   * enforces is the one that keeps the site solvent in both directions: an item
   * is released back to the player only when the purchase for it is known not
   * to have happened. A purchase that is merely unfinished — paid for, or
   * attempted and unanswered — keeps its item locked, because releasing it
   * would hand the player a skin they are also about to receive in Steam.
   */
  private async settle(withdrawalId: string): Promise<void> {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
      include: {
        items: { select: { inventoryItemId: true } },
        inventoryItems: { select: { id: true } },
        purchases: true,
      },
    });
    if (!withdrawal) return;

    // The tally walks the request's own lines. Neither the purchases nor the
    // locked rows can stand in for them: a purchase only exists once buying has
    // started, and a locked row disappears the moment its item is given back —
    // which would let a request that refunded one item and delivered another
    // report itself COMPLETED. The lines are the list the request was made
    // from, and the only one that is still whole at the end.
    const byItem = new Map(withdrawal.purchases.map((p) => [p.inventoryItemId, p]));
    const attached = new Set(withdrawal.inventoryItems.map((i) => i.id));

    const release: string[] = [];
    const deliver: string[] = [];
    let delivered = 0;
    let failed = 0;
    let open = 0;
    let bought = 0;
    const reasons: string[] = [];

    for (const line of withdrawal.items) {
      const purchase = byItem.get(line.inventoryItemId);
      const stillOurs = attached.has(line.inventoryItemId);

      if (purchase?.status === 'DELIVERED') {
        delivered += 1;
        bought += 1;
        if (stillOurs) deliver.push(line.inventoryItemId);
        continue;
      }
      // No purchase at all, or one still PENDING with no attempt behind it,
      // means nothing was ever spent on this line. The status is checked as
      // well as the counter: releasing on `attempts === 0` alone would, if
      // anything ever set BOUGHT without incrementing it, hand back a skin that
      // had been paid for.
      if (
        !purchase ||
        purchase.status === 'FAILED' ||
        (purchase.status === 'PENDING' && purchase.attempts === 0)
      ) {
        failed += 1;
        if (purchase?.failureReason) reasons.push(purchase.failureReason);
        if (stillOurs) release.push(line.inventoryItemId);
        continue;
      }

      open += 1;
      if (purchase.status === 'BOUGHT') bought += 1;
    }

    const status =
      open > 0 ? 'SENT' : delivered === 0 ? 'FAILED' : failed === 0 ? 'COMPLETED' : 'PARTIAL';

    const finished = open === 0;

    await this.prisma.$transaction(async (tx) => {
      if (release.length > 0) {
        await tx.inventoryItem.updateMany({
          where: { id: { in: release }, withdrawalId },
          data: { status: 'AVAILABLE', withdrawalId: null },
        });
      }
      if (deliver.length > 0) {
        await tx.inventoryItem.updateMany({
          where: { id: { in: deliver }, withdrawalId },
          data: { status: 'WITHDRAWN' },
        });
      }

      await tx.withdrawal.update({
        where: { id: withdrawalId },
        data: {
          status,
          // The first purchase leaving marks the request as sent; it never
          // moves again, so the age of a stuck request stays readable.
          sentAt: withdrawal.sentAt ?? (bought > 0 ? new Date() : null),
          completedAt: finished ? (withdrawal.completedAt ?? new Date()) : null,
          failureReason: reasons.length > 0 ? reasons.join('; ').slice(0, 500) : null,
        },
      });
    });

    console.log(
      `[market] ${withdrawalId} -> ${status} (delivered ${delivered}, refunded ${failed}, open ${open})`,
    );
  }

  /**
   * Gives up on a request before any money has been spent.
   *
   * Only safe while every purchase is untouched, which is why it checks rather
   * than trusting its caller: the same wording applied one purchase later would
   * refund an item the player is already receiving.
   */
  private async abandon(withdrawalId: string, reason: string): Promise<void> {
    const spent = await this.prisma.marketPurchase.count({
      where: { withdrawalId, NOT: { status: 'PENDING', attempts: 0 } },
    });
    if (spent > 0) {
      console.error(`[market] ${withdrawalId}: ${reason}, but purchases are already open`);
      await this.settle(withdrawalId);
      return;
    }

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
    console.error(`[market] ${withdrawalId} abandoned: ${reason}`);
  }

  /** Logs purchases that have been paid for and are taking far too long. */
  private async reportStuck(): Promise<void> {
    const minutes = await this.settings.read<number>('withdrawals.market.stuckAfterMin');
    const cutoff = new Date(Date.now() - minutes * 60_000);

    const stuck = await this.prisma.marketPurchase.count({
      where: { status: 'BOUGHT', boughtAt: { lt: cutoff } },
    });
    if (stuck > 0) {
      // Never auto-failed: the money is spent and the seller may still deliver.
      // An operator decides, with the back office showing them the same count.
      console.warn(`[market] ${stuck} purchase(s) paid for and undelivered for over ${minutes}m`);
    }
  }
}
