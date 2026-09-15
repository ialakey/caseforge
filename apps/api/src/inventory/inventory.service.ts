import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  type InventoryFilter,
  type PriceBandKey,
  ErrorCode,
  findPriceBand,
  sellPrice,
  statusesForFilter,
} from '@caseforge/shared';
import { PrismaService } from '../common/prisma.service';
import { SettingsService } from '../common/settings.service';
import { badRequest } from '../common/app-error';

/** Fee taken when an item is sold back, in basis points (1 bps = 0.01%). */

/**
 * How many rows one inventory request may return.
 *
 * An account that has opened thousands of cases keeps every one of those items
 * as history, and shipping the lot down to a grid nobody scrolls to the end of
 * is a cost with no reader. The cap is generous enough that the filters, not
 * the limit, are what the player notices.
 */
const INVENTORY_PAGE_SIZE = 500;

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** The configured sell-back fee. Read once per operation, not per item. */
  private async sellFeeBps(): Promise<number> {
    return this.settings.read<number>('economy.sellFeeBps');
  }

  /**
   * The player's items.
   *
   * Returns spent items too — sold, withdrawn, staked — because an item is
   * never deleted, only moved to another status. The filter decides which slice
   * is asked for; the default is everything, so the interface can count the
   * tabs without issuing a request per tab.
   */
  async list(userId: string, filter: InventoryFilter = 'all', band: PriceBandKey = 'all') {
    const feeBps = await this.sellFeeBps();
    const where: Prisma.InventoryItemWhereInput = {
      userId,
      status: { in: statusesForFilter(filter) },
    };

    // The band is applied in the query rather than after the fact, so the page
    // cap counts rows the player asked for instead of rows thrown away.
    const priceBand = findPriceBand(band);
    if (priceBand) {
      where.acquiredPrice = {
        gte: priceBand.min,
        ...(priceBand.max === null ? {} : { lt: priceBand.max }),
      };
    }

    const items = await this.prisma.inventoryItem.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: INVENTORY_PAGE_SIZE,
      include: { item: true },
    });

    return items.map((inv) => ({
      id: inv.id,
      status: inv.status,
      acquiredPrice: inv.acquiredPrice,
      sellPrice: sellPrice(inv.acquiredPrice, feeBps),
      createdAt: inv.createdAt.toISOString(),
      // When the row last moved status — what the history is sorted and dated
      // by. soldAt is the exact moment for a sale; for everything else the row
      // has not been touched since it changed hands.
      settledAt: (inv.soldAt ?? inv.updatedAt).toISOString(),
      item: {
        id: inv.item.id,
        marketHashName: inv.item.marketHashName,
        name: inv.item.name,
        imageUrl: inv.item.imageUrl,
        rarity: inv.item.rarity,
      },
    }));
  }

  /**
   * Totals per tab and per band, for the filter chips.
   *
   * Counted in the database rather than by handing the browser every row to
   * tally: the counts have to describe the whole inventory, not the slice that
   * survived the page cap.
   */
  async summary(userId: string) {
    const grouped = await this.prisma.inventoryItem.groupBy({
      by: ['status'],
      where: { userId },
      _count: { _all: true },
      _sum: { acquiredPrice: true },
    });

    const byStatus = Object.fromEntries(
      grouped.map((g) => [g.status, { count: g._count._all, value: g._sum.acquiredPrice ?? 0 }]),
    ) as Record<string, { count: number; value: number }>;

    const totalFor = (filter: InventoryFilter) =>
      statusesForFilter(filter).reduce(
        (acc, status) => {
          const row = byStatus[status];
          return row ? { count: acc.count + row.count, value: acc.value + row.value } : acc;
        },
        { count: 0, value: 0 },
      );

    return {
      all: totalFor('all'),
      available: totalFor('available'),
      pending: totalFor('pending'),
      history: totalFor('history'),
    };
  }

  /**
   * Sells items back to the site.
   *
   * `updateMany` with `status = AVAILABLE` is both the check and the claim: an
   * item already sold or locked for withdrawal by a concurrent request simply
   * falls out of the affected rows, and the mismatch between `count` and the
   * number of requested ids makes that visible.
   */
  async sell(
    userId: string,
    inventoryItemIds: string[],
  ): Promise<{ sold: number; total: number; balance: number }> {
    const uniqueIds = [...new Set(inventoryItemIds)];
    const feeBps = await this.sellFeeBps();

    return this.prisma.$transaction(async (tx) => {
      const items = await tx.inventoryItem.findMany({
        where: { id: { in: uniqueIds }, userId, status: 'AVAILABLE' },
      });
      if (items.length !== uniqueIds.length) {
        throw badRequest(ErrorCode.ITEM_UNAVAILABLE, 'Some items are not available for sale');
      }

      const claimed = await tx.inventoryItem.updateMany({
        where: { id: { in: uniqueIds }, userId, status: 'AVAILABLE' },
        data: { status: 'SOLD', soldAt: new Date() },
      });
      if (claimed.count !== uniqueIds.length) {
        throw badRequest(ErrorCode.ITEM_ALREADY_SOLD, 'Some items have already been sold');
      }

      return this.credit(tx, userId, items, feeBps);
    });
  }

  /**
   * Sells everything the player is currently looking at.
   *
   * The set is resolved inside the transaction from the same filter the
   * interface was showing, not from a list of ids the browser had loaded. The
   * returned total is therefore what was actually sold, which is the number the
   * player is owed an answer about — the confirmation dialog only ever quoted
   * an estimate of it.
   */
  async sellAll(
    userId: string,
    band: PriceBandKey = 'all',
  ): Promise<{ sold: number; total: number; balance: number }> {
    const priceBand = findPriceBand(band);
    const feeBps = await this.sellFeeBps();

    return this.prisma.$transaction(async (tx) => {
      const where: Prisma.InventoryItemWhereInput = {
        userId,
        status: 'AVAILABLE',
        ...(priceBand
          ? {
              acquiredPrice: {
                gte: priceBand.min,
                ...(priceBand.max === null ? {} : { lt: priceBand.max }),
              },
            }
          : {}),
      };

      const items = await tx.inventoryItem.findMany({
        where,
        select: { id: true, acquiredPrice: true },
      });
      if (items.length === 0) {
        throw badRequest(ErrorCode.ITEM_UNAVAILABLE, 'There is nothing to sell');
      }

      const ids = items.map((i) => i.id);
      const claimed = await tx.inventoryItem.updateMany({
        where: { id: { in: ids }, userId, status: 'AVAILABLE' },
        data: { status: 'SOLD', soldAt: new Date() },
      });
      if (claimed.count !== ids.length) {
        throw badRequest(ErrorCode.ITEMS_CHANGED, 'The inventory changed, please try again');
      }

      return this.credit(tx, userId, items, feeBps);
    });
  }

  /**
   * Withdrawal placeholder.
   *
   * The real withdrawal — a bot, a trade offer, a queue and a trade URL — lives
   * in the withdrawals module and is untouched by this. What the interface
   * needs today is the inventory side of it: the item leaves the account and
   * stays on record as WITHDRAWN. This marks it and nothing else, the same way
   * the top-up dialog credits a balance without a payment provider behind it,
   * and it is deliberately the only path that does so, so that wiring the bot
   * farm up later means deleting this rather than untangling it.
   */
  async withdraw(
    userId: string,
    inventoryItemIds: string[],
  ): Promise<{ withdrawn: number; total: number }> {
    const uniqueIds = [...new Set(inventoryItemIds)];

    return this.prisma.$transaction(async (tx) => {
      const items = await tx.inventoryItem.findMany({
        where: { id: { in: uniqueIds }, userId, status: 'AVAILABLE' },
        select: { id: true, acquiredPrice: true },
      });
      if (items.length !== uniqueIds.length) {
        throw badRequest(ErrorCode.ITEM_UNAVAILABLE, 'Some items are not available for withdrawal');
      }

      const claimed = await tx.inventoryItem.updateMany({
        where: { id: { in: uniqueIds }, userId, status: 'AVAILABLE' },
        data: { status: 'WITHDRAWN' },
      });
      if (claimed.count !== uniqueIds.length) {
        throw badRequest(ErrorCode.ITEMS_CHANGED, 'The items changed, please try again');
      }

      return {
        withdrawn: claimed.count,
        total: items.reduce((sum, i) => sum + i.acquiredPrice, 0),
      };
    });
  }

  /** Credits a sale to the balance and writes the ledger entry for it. */
  private async credit(
    tx: Prisma.TransactionClient,
    userId: string,
    items: readonly { acquiredPrice: number }[],
    feeBps: number,
  ): Promise<{ sold: number; total: number; balance: number }> {
    const total = items.reduce((sum, i) => sum + sellPrice(i.acquiredPrice, feeBps), 0);

    const updated = await tx.user.update({
      where: { id: userId },
      data: { balance: { increment: total } },
      select: { balance: true },
    });

    await tx.transaction.create({
      data: {
        userId,
        type: 'ITEM_SELL',
        amount: total,
        balanceAfter: updated.balance,
        comment: `Sold ${items.length} item(s)`,
      },
    });

    return { sold: items.length, total, balance: updated.balance };
  }
}
