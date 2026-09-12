import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  ErrorCode,
  ItemRarity,
  calculateUpgradeOdds,
  isUpgradeWin,
  upgradeTargetPriceRange,
} from '@caseforge/shared';
import { computeRoll } from '@caseforge/shared/node';
import { PrismaService } from '../common/prisma.service';
import { CasesService } from '../cases/cases.service';
import { badRequest, forbidden, notFound } from '../common/app-error';

export interface UpgradeResult {
  upgradeId: string;
  isWin: boolean;
  chance: number;
  multiplier: number;
  roll: number;
  winThreshold: number;
  nonce: number;
  serverSeedHash: string;
  clientSeed: string;
  stake: { name: string; imageUrl: string | null; rarity: ItemRarity; price: number };
  target: { name: string; imageUrl: string | null; rarity: ItemRarity; price: number };
  /** The inventory item that appeared — only on a win. */
  rewardInventoryItemId: string | null;
}

@Injectable()
export class UpgradeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Items a stake of the given value can be upgraded into.
   *
   * The price range is not eyeballed: it follows from the same formula that
   * computes the chance. Offering a target the server will later refuse is the
   * worst kind of interface.
   */
  async listTargets(params: {
    stakeValue: number;
    search?: string;
    page: number;
    perPage: number;
  }) {
    const { min, max } = upgradeTargetPriceRange(params.stakeValue);

    // The effective price is priceOverride ?? marketPrice, which a single
    // `where` cannot filter on. So cast a wide net by market price and apply
    // the exact bounds to the resolved price afterwards.
    const where: Prisma.ItemWhereInput = {
      isActive: true,
      priceUpdatedAt: { not: null },
      marketPrice: { gt: 0 },
      ...(params.search
        ? { marketHashName: { contains: params.search, mode: 'insensitive' } }
        : {}),
    };

    const candidates = await this.prisma.item.findMany({
      where,
      orderBy: { marketPrice: 'asc' },
      take: 2000,
    });

    const eligible = candidates
      .map((item) => ({ item, price: CasesService.resolvePrice(item) }))
      .filter(({ price }) => price >= min && price <= max)
      .sort((a, b) => a.price - b.price);

    const start = (params.page - 1) * params.perPage;
    const pageItems = eligible.slice(start, start + params.perPage);

    return {
      total: eligible.length,
      page: params.page,
      perPage: params.perPage,
      priceRange: { min, max },
      items: pageItems.map(({ item, price }) => {
        const odds = calculateUpgradeOdds(params.stakeValue, price);
        return {
          itemId: item.id,
          marketHashName: item.marketHashName,
          name: item.name,
          imageUrl: item.imageUrl,
          rarity: item.rarity as ItemRarity,
          price,
          chance: odds.ok ? odds.chance : 0,
          multiplier: odds.ok ? odds.multiplier : 0,
        };
      }),
    };
  }

  /** Inventory items that may be staked in an upgrade. */
  async listStakes(userId: string) {
    const items = await this.prisma.inventoryItem.findMany({
      where: { userId, status: 'AVAILABLE' },
      orderBy: { acquiredPrice: 'desc' },
      include: { item: true },
    });

    return items.map((inv) => ({
      inventoryItemId: inv.id,
      marketHashName: inv.item.marketHashName,
      name: inv.item.name,
      imageUrl: inv.item.imageUrl,
      rarity: inv.item.rarity as ItemRarity,
      price: inv.acquiredPrice,
    }));
  }

  /**
   * Runs an upgrade.
   *
   * The stake is always consumed, win or lose: it is a stake, not a deposit.
   * The outcome comes from the same roll as a case opening, over the same seed
   * pair and shared nonce counter, so the upgrade is verified exactly the same
   * way and needs no fairness page of its own.
   */
  async upgrade(
    userId: string,
    inventoryItemId: string,
    targetItemId: string,
  ): Promise<UpgradeResult> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { isBanned: true, banReason: true },
      });
      if (!user) throw new NotFoundException('User not found');
      if (user.isBanned) throw forbidden(ErrorCode.ACCOUNT_BANNED, user.banReason ?? 'Account is banned');

      const stake = await tx.inventoryItem.findFirst({
        where: { id: inventoryItemId, userId, status: 'AVAILABLE' },
        include: { item: true },
      });
      if (!stake) throw badRequest(ErrorCode.ITEM_UNAVAILABLE, 'That item is not available for an upgrade');

      const target = await tx.item.findUnique({ where: { id: targetItemId } });
      if (!target || !target.isActive) throw notFound(ErrorCode.UPGRADE_TARGET_MISSING, 'Target item not found');

      const targetValue = CasesService.resolvePrice(target);
      const odds = calculateUpgradeOdds(stake.acquiredPrice, targetValue);
      if (!odds.ok) throw badRequest(ErrorCode.UPGRADE_REJECTED, odds.reason);

      // Claim the stake with a conditional update: if the item has just gone
      // to a sale or a withdrawal the count is zero and no upgrade happens.
      const claimed = await tx.inventoryItem.updateMany({
        where: { id: inventoryItemId, userId, status: 'AVAILABLE' },
        data: { status: 'UPGRADED' },
      });
      if (claimed.count === 0) {
        throw badRequest(ErrorCode.ITEMS_CHANGED, 'The item changed, please try again');
      }

      const seedRows = await tx.$queryRaw<
        Array<{ id: string; seed: string; seedHash: string; nonce: number }>
      >`
        UPDATE server_seeds
        SET nonce = nonce + 1
        WHERE "userId" = CAST(${userId} AS uuid) AND "isActive" = true
        RETURNING id, seed, "seedHash", nonce
      `;
      const serverSeed = seedRows[0];
      if (!serverSeed) {
        throw badRequest(ErrorCode.NO_ACTIVE_SEED, 'No active server seed — sign in again');
      }

      const clientSeed = await tx.clientSeed.findFirst({ where: { userId, isActive: true } });
      if (!clientSeed) throw badRequest(ErrorCode.NO_ACTIVE_SEED, 'No active client seed');

      const roll = computeRoll(serverSeed.seed, clientSeed.seed, serverSeed.nonce);
      const isWin = isUpgradeWin(roll, odds.winThreshold);

      const upgrade = await tx.upgrade.create({
        data: {
          userId,
          status: isWin ? 'WON' : 'LOST',
          targetItemId: target.id,
          stakeValue: stake.acquiredPrice,
          targetValue,
          chance: odds.chance,
          winThreshold: odds.winThreshold,
          roll,
          serverSeedId: serverSeed.id,
          clientSeedId: clientSeed.id,
          nonce: serverSeed.nonce,
        },
      });

      await tx.inventoryItem.update({
        where: { id: stake.id },
        data: { upgradeStakeId: upgrade.id },
      });

      let rewardInventoryItemId: string | null = null;
      if (isWin) {
        const reward = await tx.inventoryItem.create({
          data: {
            userId,
            itemId: target.id,
            acquiredPrice: targetValue,
            upgradeRewardId: upgrade.id,
          },
        });
        rewardInventoryItemId = reward.id;
      }

      return {
        upgradeId: upgrade.id,
        isWin,
        chance: odds.chance,
        multiplier: odds.multiplier,
        roll,
        winThreshold: odds.winThreshold,
        nonce: serverSeed.nonce,
        serverSeedHash: serverSeed.seedHash,
        clientSeed: clientSeed.seed,
        stake: {
          name: stake.item.marketHashName,
          imageUrl: stake.item.imageUrl,
          rarity: stake.item.rarity as ItemRarity,
          price: stake.acquiredPrice,
        },
        target: {
          name: target.marketHashName,
          imageUrl: target.imageUrl,
          rarity: target.rarity as ItemRarity,
          price: targetValue,
        },
        rewardInventoryItemId,
      };
    });
  }

  /** Upgrade history — the same verifiability as openings. */
  async history(userId: string, page: number, perPage: number) {
    const [total, rows] = await Promise.all([
      this.prisma.upgrade.count({ where: { userId } }),
      this.prisma.upgrade.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        include: { targetItem: true, stake: { include: { item: true } } },
      }),
    ]);

    return {
      total,
      page,
      perPage,
      items: rows.map((u) => ({
        id: u.id,
        status: u.status,
        chance: u.chance,
        roll: u.roll,
        winThreshold: u.winThreshold,
        stakeValue: u.stakeValue,
        targetValue: u.targetValue,
        stakeName: u.stake?.item.marketHashName ?? '—',
        targetName: u.targetItem.marketHashName,
        targetImageUrl: u.targetItem.imageUrl,
        createdAt: u.createdAt.toISOString(),
      })),
    };
  }
}
