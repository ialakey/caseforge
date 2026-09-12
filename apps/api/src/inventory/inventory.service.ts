import { Injectable } from '@nestjs/common';
import { ErrorCode, sellPrice } from '@caseforge/shared';
import { PrismaService } from '../common/prisma.service';
import { badRequest } from '../common/app-error';

/**
 * Fee taken when an item is sold back to the site, in basis points
 * (1 bps = 0.01%). A candidate for the settings table once the admin panel
 * needs to tune it.
 */
const SELL_FEE_BPS = 0;

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string) {
    const items = await this.prisma.inventoryItem.findMany({
      where: { userId, status: { in: ['AVAILABLE', 'LOCKED'] } },
      orderBy: { createdAt: 'desc' },
      include: { item: true },
    });

    return items.map((inv) => ({
      id: inv.id,
      status: inv.status,
      acquiredPrice: inv.acquiredPrice,
      sellPrice: sellPrice(inv.acquiredPrice, SELL_FEE_BPS),
      createdAt: inv.createdAt.toISOString(),
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
   * Sells items back to the site.
   *
   * `updateMany` with `status = AVAILABLE` is both the check and the claim: an
   * item already sold or locked for withdrawal by a concurrent request simply
   * falls out of the affected rows, and the mismatch between `count` and the
   * number of requested ids makes that visible.
   */
  async sell(userId: string, inventoryItemIds: string[]): Promise<{ sold: number; balance: number }> {
    const uniqueIds = [...new Set(inventoryItemIds)];

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

      const total = items.reduce((sum, i) => sum + sellPrice(i.acquiredPrice, SELL_FEE_BPS), 0);

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

      return { sold: items.length, balance: updated.balance };
    });
  }
}
