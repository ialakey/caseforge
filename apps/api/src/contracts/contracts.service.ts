import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  type CaseItemView,
  type ContractCandidate,
  type ContractOutcome,
  CONTRACT_RTP,
  ErrorCode,
  ItemRarity,
  buildContractPool,
  contractRewardPriceRange,
  isValidContractSize,
  pickContractOutcome,
} from '@caseforge/shared';
import { computeRoll } from '@caseforge/shared/node';
import { PrismaService } from '../common/prisma.service';
import { CasesService } from '../cases/cases.service';
import { badRequest, forbidden } from '../common/app-error';

/** A staked item, as the interface shows it back. */
export interface ContractStakeView {
  inventoryItemId: string;
  marketHashName: string;
  name: string;
  imageUrl: string | null;
  rarity: ItemRarity;
  price: number;
}

export interface ContractPoolView {
  stakeValue: number;
  /** What the outcome table was solved for: stakeValue * CONTRACT_RTP. */
  targetValue: number;
  rewardRange: { min: number; max: number };
  /** Realised RTP of the rounded table — should read 0.9. */
  rtp: number;
  /**
   * The outcomes in the shape the case reel already speaks, so the contract
   * reuses the opening animation instead of growing a second one.
   */
  outcomes: CaseItemView[];
}

export interface ContractResult extends ContractPoolView {
  contractId: string;
  roll: number;
  nonce: number;
  serverSeedHash: string;
  clientSeed: string;
  stakes: ContractStakeView[];
  reward: CaseItemView;
  rewardInventoryItemId: string;
}

/** The outcome table as it is stored on the contract row. */
type StoredOutcome = Pick<ContractOutcome, 'itemId' | 'price' | 'rangeFrom' | 'rangeTo'>;

@Injectable()
export class ContractsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Items the player may throw into a contract.
   *
   * The same set an upgrade can stake: anything sitting in the inventory and
   * not already spoken for by a withdrawal.
   */
  async listStakes(userId: string): Promise<ContractStakeView[]> {
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
   * The outcome table for a stake, with nothing consumed.
   *
   * The player is shown the very table the roll will run against — the same
   * function builds it here and in `run`, so a preview that disagreed with the
   * outcome would be a bug rather than a rounding difference.
   */
  async preview(userId: string, inventoryItemIds: string[]): Promise<ContractPoolView> {
    const stakes = await this.loadStakes(this.prisma, userId, inventoryItemIds);
    const stakeValue = stakes.reduce((sum, s) => sum + s.acquiredPrice, 0);
    return this.buildPoolView(this.prisma, stakeValue);
  }

  /**
   * Runs a contract.
   *
   * The staked items are always consumed — a contract has no losing branch to
   * refund, it simply returns something else. The roll comes from the same
   * seed pair and shared nonce counter as a case opening, so a contract is
   * verified exactly the way an opening is.
   */
  async run(userId: string, inventoryItemIds: string[]): Promise<ContractResult> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { isBanned: true, banReason: true },
      });
      if (!user) throw new NotFoundException('User not found');
      if (user.isBanned) {
        throw forbidden(ErrorCode.ACCOUNT_BANNED, user.banReason ?? 'Account is banned');
      }

      const stakes = await this.loadStakes(tx, userId, inventoryItemIds);
      const stakeValue = stakes.reduce((sum, s) => sum + s.acquiredPrice, 0);
      const pool = await this.buildPoolView(tx, stakeValue);

      // Claim the stakes with a conditional update: an item that has just gone
      // to a sale or a withdrawal falls out of the affected rows, and no
      // contract happens over a stake that is no longer there.
      const claimed = await tx.inventoryItem.updateMany({
        where: { id: { in: inventoryItemIds }, userId, status: 'AVAILABLE' },
        data: { status: 'CONTRACTED' },
      });
      if (claimed.count !== inventoryItemIds.length) {
        throw badRequest(ErrorCode.ITEMS_CHANGED, 'The items changed, please try again');
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
      const winner = pickContractOutcome(pool.outcomes, roll);

      const contract = await tx.contract.create({
        data: {
          userId,
          stakeCount: stakes.length,
          stakeValue,
          targetValue: pool.targetValue,
          rewardItemId: winner.itemId,
          rewardValue: winner.price,
          // Stored without the display fields: names and images live on the
          // items table and would only go stale here, while the ids, prices
          // and ticket ranges are what the roll is checked against.
          outcomes: pool.outcomes.map((o): StoredOutcome => ({
            itemId: o.itemId,
            price: o.price,
            rangeFrom: o.rangeFrom,
            rangeTo: o.rangeTo,
          })) satisfies Prisma.InputJsonValue,
          roll,
          serverSeedId: serverSeed.id,
          clientSeedId: clientSeed.id,
          nonce: serverSeed.nonce,
        },
      });

      await tx.inventoryItem.updateMany({
        where: { id: { in: inventoryItemIds } },
        data: { contractStakeId: contract.id },
      });

      const reward = await tx.inventoryItem.create({
        data: {
          userId,
          itemId: winner.itemId,
          acquiredPrice: winner.price,
          contractRewardId: contract.id,
        },
      });

      return {
        ...pool,
        contractId: contract.id,
        roll,
        nonce: serverSeed.nonce,
        serverSeedHash: serverSeed.seedHash,
        clientSeed: clientSeed.seed,
        stakes: stakes.map((s) => ({
          inventoryItemId: s.id,
          marketHashName: s.item.marketHashName,
          name: s.item.name,
          imageUrl: s.item.imageUrl,
          rarity: s.item.rarity as ItemRarity,
          price: s.acquiredPrice,
        })),
        reward: winner,
        rewardInventoryItemId: reward.id,
      };
    });
  }

  /** Contract history — the same verifiability an opening has. */
  async history(userId: string, page: number, perPage: number) {
    const [total, rows] = await Promise.all([
      this.prisma.contract.count({ where: { userId } }),
      this.prisma.contract.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        include: { rewardItem: true },
      }),
    ]);

    return {
      total,
      page,
      perPage,
      items: rows.map((c) => ({
        id: c.id,
        stakeCount: c.stakeCount,
        stakeValue: c.stakeValue,
        rewardValue: c.rewardValue,
        rewardName: c.rewardItem.marketHashName,
        rewardImageUrl: c.rewardItem.imageUrl,
        rewardRarity: c.rewardItem.rarity as ItemRarity,
        roll: c.roll,
        nonce: c.nonce,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Loads the staked rows and checks they are a legal contract.
   *
   * Runs against whichever client it is handed, so the preview can read
   * outside a transaction while `run` reads inside one.
   */
  private async loadStakes(
    client: Prisma.TransactionClient | PrismaService,
    userId: string,
    inventoryItemIds: string[],
  ) {
    if (!isValidContractSize(inventoryItemIds.length)) {
      throw badRequest(ErrorCode.CONTRACT_SIZE_INVALID, 'Invalid number of items for a contract');
    }

    const stakes = await client.inventoryItem.findMany({
      where: { id: { in: inventoryItemIds }, userId, status: 'AVAILABLE' },
      include: { item: true },
    });
    if (stakes.length !== inventoryItemIds.length) {
      throw badRequest(ErrorCode.ITEM_UNAVAILABLE, 'Some items are not available for a contract');
    }
    return stakes;
  }

  /**
   * Builds the outcome table for a staked sum.
   *
   * Candidates are read as a bare projection first and only the surviving
   * dozen are fetched in full. The band spans fifty-fold, so filtering by the
   * effective price — which no `where` can express, since an override beats
   * the market price — would otherwise mean pulling thousands of rows complete
   * with names and image URLs to throw nearly all of them away.
   */
  private async buildPoolView(
    client: Prisma.TransactionClient | PrismaService,
    stakeValue: number,
  ): Promise<ContractPoolView> {
    const { min, max } = contractRewardPriceRange(stakeValue);

    const priced = await client.item.findMany({
      where: {
        isActive: true,
        priceUpdatedAt: { not: null },
        // A wide net on the stored prices; the exact bound is applied to the
        // resolved price below.
        OR: [{ marketPrice: { gte: min, lte: max } }, { priceOverride: { gte: min, lte: max } }],
      },
      select: { id: true, marketPrice: true, priceOverride: true },
    });

    const candidates: ContractCandidate[] = priced.map((item) => ({
      itemId: item.id,
      price: CasesService.resolvePrice(item),
    }));

    const pool = buildContractPool(candidates, stakeValue);
    if (!pool.ok) throw badRequest(ErrorCode.CONTRACT_POOL_EMPTY, pool.reason);

    const items = await client.item.findMany({
      where: { id: { in: pool.outcomes.map((o) => o.itemId) } },
    });
    const byId = new Map(items.map((item) => [item.id, item]));

    return {
      stakeValue,
      targetValue: Math.round(stakeValue * CONTRACT_RTP),
      rewardRange: pool.rewardRange,
      rtp: pool.rtp,
      outcomes: pool.outcomes.map((outcome) => {
        const item = byId.get(outcome.itemId);
        if (!item) {
          // Unreachable: the ids were read from this same table moments ago.
          throw badRequest(
            ErrorCode.CONTRACT_REJECTED,
            'The reward pool changed, please try again',
          );
        }
        return {
          // The reel keys tiles by id; a contract outcome has no CaseItem row
          // of its own, so the item id serves as its identity.
          id: item.id,
          itemId: item.id,
          marketHashName: item.marketHashName,
          imageUrl: item.imageUrl,
          rarity: item.rarity as ItemRarity,
          price: outcome.price,
          chance: outcome.chance,
          rangeFrom: outcome.rangeFrom,
          rangeTo: outcome.rangeTo,
        };
      }),
    };
  }
}
