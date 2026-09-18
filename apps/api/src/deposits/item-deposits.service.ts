import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import {
  type DepositCandidate,
  type DepositQuote,
  type ItemDepositView,
  ErrorCode,
  ItemRarity,
  parseTradeUrl,
  resolveItemPrice,
} from '@caseforge/shared';
import { PrismaService } from '../common/prisma.service';
import { SettingsService } from '../common/settings.service';
import { badRequest, forbidden, notFound } from '../common/app-error';
import { SteamInventoryService, type InventoryAsset } from '../steam/steam-inventory.service';

/**
 * A priced asset, plus the catalogue row it matched.
 *
 * `itemId` stays on this side of the wire. The browser has no use for the
 * site's internal id of a skin, and every field that leaves the server is a
 * field somebody has to keep meaning something.
 */
type PricedAsset = DepositCandidate & { itemId: string | null };

/**
 * Deposits of skins: a player hands items to a farm bot and is credited.
 *
 * The mirror of a withdrawal, and it inherits the same rule about money: the
 * valuation is frozen when the request is made, not when the items arrive. A
 * player who accepts an offer worth 4 200 gets 4 200 even if the market moved
 * while the offer sat in Steam. Re-pricing on arrival would mean the number
 * they agreed to was never the number that mattered — and it is the number
 * they agreed to that a dispute is about.
 *
 * Prices are always the site's own. The browser sends asset ids and nothing
 * else; a client that could name its own price could name any price.
 */
@Injectable()
export class ItemDepositsService {
  private readonly logger = new Logger(ItemDepositsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly inventory: SteamInventoryService,
  ) {}

  /**
   * The player's inventory, priced.
   *
   * Items the site cannot take are listed with a reason rather than filtered
   * out. A player whose knife is missing from the list needs to know it is a
   * trade hold and not a bug — an absence explains nothing.
   */
  async quote(userId: string): Promise<DepositQuote> {
    await this.ensureEnabled();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { steamId64: true, isBanned: true, banReason: true },
    });
    if (!user) throw notFound(ErrorCode.ACCOUNT_BANNED, 'User not found');
    if (user.isBanned) {
      throw forbidden(ErrorCode.ACCOUNT_BANNED, user.banReason ?? 'Account is banned');
    }

    const assets = await this.inventory.load(user.steamId64);
    const rateBps = this.settings.get<number>('deposits.itemRateBps');

    const priced = await this.priceAssets(assets, rateBps);

    return {
      items: priced.map(({ itemId: _itemId, ...candidate }) => candidate),
      total: priced.reduce((sum, i) => (i.blockedReason ? sum : sum + i.payout), 0),
      rateBps,
      minValue: this.settings.get<number>('deposits.itemMinValue'),
      maxItems: this.settings.get<number>('deposits.itemMaxPerOffer'),
    };
  }

  /**
   * Turns a selection into a request a bot can act on.
   *
   * The inventory is read again here rather than trusting the quote the browser
   * was shown: between the two the player may have traded the skin away, and an
   * offer built from an asset id that has moved is one Steam refuses. Reading
   * twice costs a cached request and removes a whole class of confusing
   * failures.
   */
  async create(userId: string, assetIds: string[]): Promise<ItemDepositView> {
    await this.ensureEnabled();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { steamId64: true, tradeUrl: true, isBanned: true, banReason: true },
    });
    if (!user) throw notFound(ErrorCode.ACCOUNT_BANNED, 'User not found');
    if (user.isBanned) {
      throw forbidden(ErrorCode.ACCOUNT_BANNED, user.banReason ?? 'Account is banned');
    }
    if (!user.tradeUrl || !parseTradeUrl(user.tradeUrl)) {
      throw badRequest(
        ErrorCode.TRADE_URL_INVALID,
        'Set a valid Steam trade URL in your profile first',
      );
    }

    // One at a time. Two live offers would be two claims on the same asset
    // ids, and the loser of that race is a player staring at an offer Steam
    // has already invalidated.
    const inFlight = await this.prisma.itemDeposit.findFirst({
      where: { userId, status: { in: ['PENDING', 'OFFER_SENT', 'ACCEPTED'] } },
      select: { id: true },
    });
    if (inFlight) {
      throw badRequest(
        ErrorCode.DEPOSIT_IN_PROGRESS,
        'You already have a deposit in progress — finish or cancel it first',
      );
    }

    const maxItems = this.settings.get<number>('deposits.itemMaxPerOffer');
    const wanted = [...new Set(assetIds)];
    if (wanted.length > maxItems) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        `At most ${maxItems} items can go in one deposit`,
      );
    }

    const rateBps = this.settings.get<number>('deposits.itemRateBps');
    const assets = await this.inventory.load(user.steamId64);
    const byAsset = new Map(assets.map((a) => [a.assetId, a] as const));

    const chosen = wanted.flatMap((id) => {
      const asset = byAsset.get(id);
      return asset ? [asset] : [];
    });
    if (chosen.length !== wanted.length) {
      throw badRequest(
        ErrorCode.INVENTORY_UNAVAILABLE,
        'Some of those items are no longer in your inventory — reload and try again',
      );
    }

    const priced = (await this.priceAssets(chosen, rateBps)).filter((i) => i.blockedReason === null);
    const total = priced.reduce((sum, i) => sum + i.payout, 0);
    const minValue = this.settings.get<number>('deposits.itemMinValue');

    if (priced.length === 0 || total < minValue) {
      throw badRequest(
        ErrorCode.DEPOSIT_TOO_SMALL,
        `A deposit must be worth at least ${(minValue / 100).toFixed(2)}`,
      );
    }

    const ttlMinutes = this.settings.get<number>('deposits.itemOfferTtlMin');
    const deposit = await this.prisma.itemDeposit.create({
      data: {
        userId,
        status: 'PENDING',
        totalValue: total,
        rateBps,
        // Copied, not referenced: a trade URL edited while the offer is in
        // flight must not redirect an offer already sent.
        tradeUrl: user.tradeUrl,
        expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
        items: {
          create: priced.map((i) => ({
            assetId: i.assetId,
            marketHashName: i.marketHashName,
            itemId: i.itemId,
            marketPrice: i.marketPrice,
            payout: i.payout,
          })),
        },
      },
      include: { items: { include: { item: true } } },
    });

    this.logger.log(
      `Deposit ${deposit.id}: ${priced.length} item(s), ${(total / 100).toFixed(2)} at ${rateBps} bps`,
    );
    return this.toView(deposit);
  }

  /** A player's own deposits, newest first. */
  async list(userId: string, limit = 20): Promise<ItemDepositView[]> {
    const rows = await this.prisma.itemDeposit.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { items: { include: { item: true } } },
    });
    return rows.map((row) => this.toView(row));
  }

  /**
   * Called off before the items have moved.
   *
   * Only while nothing has been handed over. Once a bot holds the skins the
   * player is owed money, and "cancel" would mean keeping both.
   */
  async cancel(userId: string, depositId: string): Promise<ItemDepositView> {
    const deposit = await this.prisma.itemDeposit.findFirst({
      where: { id: depositId, userId },
      include: { items: { include: { item: true } } },
    });
    if (!deposit) throw notFound(ErrorCode.VALIDATION_FAILED, 'No such deposit');

    if (deposit.status !== 'PENDING' && deposit.status !== 'OFFER_SENT') {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        'This deposit can no longer be cancelled — decline the trade offer in Steam instead',
      );
    }

    const updated = await this.prisma.itemDeposit.update({
      where: { id: deposit.id },
      data: { status: 'CANCELLED', completedAt: new Date() },
      include: { items: { include: { item: true } } },
    });
    return this.toView(updated);
  }

  /**
   * Credits a deposit whose items have arrived.
   *
   * The status change and the credit are one transaction, and the update is
   * conditional on the row still being `ACCEPTED`. That condition is the whole
   * idempotency story: the bot worker polls, and a poll that overlaps with the
   * previous one would otherwise pay twice for the same skins.
   */
  async credit(depositId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.itemDeposit.updateMany({
        where: { id: depositId, status: 'ACCEPTED' },
        data: { status: 'CREDITED', completedAt: new Date() },
      });
      if (claimed.count === 0) return;

      const deposit = await tx.itemDeposit.findUniqueOrThrow({
        where: { id: depositId },
        select: { userId: true, totalValue: true },
      });

      const updated = await tx.user.update({
        where: { id: deposit.userId },
        data: { balance: { increment: deposit.totalValue } },
        select: { balance: true },
      });

      // Its own transaction type, not DEPOSIT: money that arrived as skins and
      // money that arrived as money are different lines in a report, and one
      // that cannot tell them apart cannot say what the item channel is worth.
      await tx.transaction.create({
        data: {
          userId: deposit.userId,
          type: 'ITEM_DEPOSIT',
          amount: deposit.totalValue,
          balanceAfter: updated.balance,
          comment: `Item deposit ${depositId}`,
        },
      });
    });
  }

  /**
   * Credits every deposit the bot worker has marked as arrived.
   *
   * The handover between the two halves of this feature. The worker owns the
   * trade and stops at ACCEPTED; this owns the ledger and takes it from there.
   * Polled rather than pushed because the alternative is the worker calling
   * into the API to move money, which is exactly the coupling the split
   * avoids — and a minute's delay on a credit nobody is watching costs
   * nothing.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async creditAccepted(): Promise<void> {
    const accepted = await this.prisma.itemDeposit.findMany({
      where: { status: 'ACCEPTED' },
      select: { id: true },
      take: 50,
    });

    for (const { id } of accepted) {
      try {
        await this.credit(id);
      } catch (err) {
        // One deposit that cannot be credited must not stop the rest: the row
        // stays ACCEPTED and the next sweep tries again.
        this.logger.error(`Crediting deposit ${id}: ${String(err)}`);
      }
    }
  }

  /**
   * Prices a set of assets against the catalogue and the market.
   *
   * An item the site already carries is priced from its own catalogue row,
   * which is the same number the rest of the site trades on. One it has never
   * seen has no price here and is refused rather than guessed at — a deposit
   * credited from an invented price is money given away against nothing.
   */
  private async priceAssets(assets: InventoryAsset[], rateBps: number): Promise<PricedAsset[]> {
    const names = [...new Set(assets.map((a) => a.marketHashName))];
    const known = await this.prisma.item.findMany({
      where: { marketHashName: { in: names } },
      select: {
        id: true,
        marketHashName: true,
        marketPrice: true,
        priceOverride: true,
        imageUrl: true,
        rarity: true,
      },
    });
    const byName = new Map(known.map((i) => [i.marketHashName, i] as const));

    return assets.map((asset) => {
      const row = byName.get(asset.marketHashName);
      const marketPrice = row ? resolveItemPrice(row) : 0;
      const payout = Math.floor((marketPrice * rateBps) / 10_000);

      const blockedReason: DepositCandidate['blockedReason'] = !asset.tradable
        ? 'untradable'
        : marketPrice <= 0 || payout <= 0
          ? 'no-price'
          : null;

      return {
        assetId: asset.assetId,
        itemId: row?.id ?? null,
        marketHashName: asset.marketHashName,
        name: asset.name,
        // The catalogue's picture when there is one: it is the same image the
        // rest of the site shows for that skin, so an inventory and a case
        // grid do not disagree about what a Redline looks like.
        imageUrl: row?.imageUrl ?? asset.imageUrl,
        rarity: (row?.rarity as ItemRarity) ?? asset.rarity,
        exterior: asset.exterior,
        marketPrice,
        payout,
        blockedReason,
      };
    });
  }

  private async ensureEnabled(): Promise<void> {
    await this.settings.ensureFresh();
    if (this.settings.get<boolean>('deposits.itemsEnabled') !== true) {
      throw forbidden(ErrorCode.ITEM_DEPOSITS_DISABLED, 'Item deposits are switched off');
    }
  }

  private toView(
    deposit: Prisma.ItemDepositGetPayload<{ include: { items: { include: { item: true } } } }>,
  ): ItemDepositView {
    return {
      id: deposit.id,
      status: deposit.status,
      totalValue: deposit.totalValue,
      rateBps: deposit.rateBps,
      tradeOfferId: deposit.tradeOfferId,
      failureReason: deposit.failureReason,
      expiresAt: deposit.expiresAt.toISOString(),
      createdAt: deposit.createdAt.toISOString(),
      completedAt: deposit.completedAt?.toISOString() ?? null,
      items: deposit.items.map((i) => ({
        assetId: i.assetId,
        marketHashName: i.marketHashName,
        // From the catalogue row when the site carries the skin. A deposit of
        // something it has never seen shows no picture, which is honest: it
        // has none to show.
        imageUrl: i.item?.imageUrl ?? null,
        rarity: (i.item?.rarity as ItemRarity) ?? ItemRarity.CONSUMER,
        marketPrice: i.marketPrice,
        payout: i.payout,
      })),
    };
  }
}
