import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  type BonusKind,
  type ItemRarity,
  type WheelSegment,
  type WheelSlice,
  ErrorCode,
  buildWheel,
  isVoucher,
  nextSpinAt,
  pickWheelSlice,
  resolveItemPrice,
  voucherSaving,
} from '@caseforge/shared';
import { computeRoll } from '@caseforge/shared/node';
import { PrismaService } from '../common/prisma.service';
import { badRequest, forbidden } from '../common/app-error';
import { SettingsService } from '../common/settings.service';

/** A voucher sitting on the account, waiting to be spent on an opening. */
export interface VoucherView {
  id: string;
  kind: BonusKind;
  segmentKey: string;
  value: number;
  createdAt: string;
}

export interface BonusStatus {
  /** The wheel itself, so the interface draws what the server will roll. */
  wheel: readonly WheelSlice[];
  /** Whether the feature is switched on at all. */
  enabled: boolean;
  canSpin: boolean;
  lastSpinAt: string | null;
  nextSpinAt: string | null;
  vouchers: VoucherView[];
}

export interface SpinResult {
  bonusId: string;
  segmentKey: string;
  kind: BonusKind;
  value: number;
  roll: number;
  nonce: number;
  serverSeedHash: string;
  clientSeed: string;
  nextSpinAt: string;
  /** Present when the prize was money. */
  balance: number | null;
  /** Present when the prize was a skin. */
  item: {
    id: string;
    marketHashName: string;
    imageUrl: string | null;
    rarity: ItemRarity;
    price: number;
  } | null;
}

/** What a voucher took off an opening, resolved inside the opening's transaction. */
export interface AppliedBonus {
  bonusId: string;
  kind: BonusKind;
  segmentKey: string;
  value: number;
  /** Saving in minor units. */
  saving: number;
}

@Injectable()
export class BonusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * The wheel as currently configured, and how long between spins.
   *
   * Built through the same `buildWheel` the constant uses, so an operator's
   * slices get the identical ticket arithmetic — a second path for edited
   * wheels is how the drawn wheel and the rolled wheel start to disagree.
   */
  private async wheelConfig(): Promise<{ wheel: WheelSlice[]; cooldownMs: number }> {
    await this.settings.ensureFresh();
    return {
      wheel: buildWheel(this.settings.get<WheelSegment[]>('bonus.wheel')),
      cooldownMs: this.settings.get<number>('bonus.cooldownHours') * 60 * 60 * 1000,
    };
  }

  /** The wheel, the cooldown and whatever vouchers are still unspent. */
  async status(userId: string): Promise<BonusStatus> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { lastBonusAt: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const vouchers = await this.prisma.dailyBonus.findMany({
      where: { userId, consumedAt: null },
      orderBy: { createdAt: 'asc' },
    });

    const { wheel, cooldownMs } = await this.wheelConfig();
    const enabled = this.settings.get<boolean>('bonus.enabled');
    const next = nextSpinAt(user.lastBonusAt, cooldownMs);
    return {
      wheel,
      enabled,
      canSpin: enabled && (next === null || Date.now() >= next.getTime()),
      lastSpinAt: user.lastBonusAt?.toISOString() ?? null,
      nextSpinAt: next?.toISOString() ?? null,
      vouchers: vouchers.map((v) => ({
        id: v.id,
        kind: v.kind as BonusKind,
        segmentKey: v.segmentKey,
        value: v.value,
        createdAt: v.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Spins the wheel.
   *
   * The cooldown is claimed with a conditional UPDATE rather than checked and
   * then written: between a read and a write two requests fired together both
   * pass the check, and the player gets two spins out of one day. Zero affected
   * rows means somebody else already took today's spin.
   */
  async spin(userId: string): Promise<SpinResult> {
    const { wheel, cooldownMs } = await this.wheelConfig();
    if (!this.settings.get<boolean>('bonus.enabled')) {
      throw badRequest(ErrorCode.BONUS_DISABLED, 'The daily bonus is switched off');
    }

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { isBanned: true, banReason: true },
      });
      if (!user) throw new NotFoundException('User not found');
      if (user.isBanned) {
        throw forbidden(ErrorCode.ACCOUNT_BANNED, user.banReason ?? 'Account is banned');
      }

      const cutoff = new Date(Date.now() - cooldownMs);
      const claimed = await tx.user.updateMany({
        where: { id: userId, OR: [{ lastBonusAt: null }, { lastBonusAt: { lte: cutoff } }] },
        data: { lastBonusAt: new Date() },
      });
      if (claimed.count === 0) {
        throw badRequest(ErrorCode.BONUS_ON_COOLDOWN, 'The daily bonus is not ready yet');
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
      const slice = pickWheelSlice(roll, wheel);

      // A skin has to be picked before the row is written, because the row
      // records which one it was.
      const grantedItem =
        slice.kind === 'FREE_ITEM' ? await this.pickGrantItem(tx, slice.value, roll) : null;

      // A catalogue with nothing inside the ceiling would otherwise pay out
      // nothing at all, which is the one outcome the wheel must never have.
      // The slice is honoured in money instead, and the ledger comment says so.
      const payInsteadOfItem = slice.kind === 'FREE_ITEM' && grantedItem === null;
      const creditsBalance = slice.kind === 'BALANCE' || payInsteadOfItem;

      const bonus = await tx.dailyBonus.create({
        data: {
          userId,
          kind: slice.kind,
          segmentKey: slice.key,
          value: slice.value,
          itemId: grantedItem?.id ?? null,
          itemPrice: grantedItem?.price ?? null,
          serverSeedId: serverSeed.id,
          clientSeedId: clientSeed.id,
          nonce: serverSeed.nonce,
          roll,
          // A voucher stays open until it is spent; everything else is settled
          // here and now, so it is born consumed.
          consumedAt: isVoucher(slice.kind) ? null : new Date(),
        },
      });

      let balance: number | null = null;
      if (creditsBalance) {
        const updated = await tx.user.update({
          where: { id: userId },
          data: { balance: { increment: slice.value } },
          select: { balance: true },
        });
        balance = updated.balance;
        // Through the ledger like every other balance movement, so the nightly
        // reconciliation still adds up.
        await tx.transaction.create({
          data: {
            userId,
            type: 'BONUS',
            amount: slice.value,
            balanceAfter: updated.balance,
            referenceId: bonus.id,
            comment: payInsteadOfItem
              ? `Daily bonus: ${slice.key} (no item in range, paid in balance)`
              : `Daily bonus: ${slice.key}`,
          },
        });
      }

      if (grantedItem) {
        await tx.inventoryItem.create({
          data: {
            userId,
            itemId: grantedItem.id,
            acquiredPrice: grantedItem.price,
            bonusRewardId: bonus.id,
          },
        });
      }

      return {
        bonusId: bonus.id,
        segmentKey: slice.key,
        kind: slice.kind,
        value: slice.value,
        roll,
        nonce: serverSeed.nonce,
        serverSeedHash: serverSeed.seedHash,
        clientSeed: clientSeed.seed,
        nextSpinAt: new Date(Date.now() + cooldownMs).toISOString(),
        balance,
        item: grantedItem,
      };
    });
  }

  /** Past spins, so a player can check them once the seed is rotated. */
  async history(userId: string, page: number, perPage: number) {
    const [total, rows] = await Promise.all([
      this.prisma.dailyBonus.count({ where: { userId } }),
      this.prisma.dailyBonus.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        include: { item: true },
      }),
    ]);

    return {
      total,
      page,
      perPage,
      items: rows.map((b) => ({
        id: b.id,
        kind: b.kind as BonusKind,
        segmentKey: b.segmentKey,
        value: b.value,
        roll: b.roll,
        nonce: b.nonce,
        itemName: b.item?.marketHashName ?? null,
        itemPrice: b.itemPrice,
        consumedAt: b.consumedAt?.toISOString() ?? null,
        createdAt: b.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Spends the voucher that is worth most on this basket, if there is one.
   *
   * Called from inside the opening's transaction, before the debit. Picking by
   * saving rather than by age is the only rule that cannot annoy the player:
   * a first-in-first-out queue would burn a half-price voucher on the cheapest
   * case in the catalogue while a free opening sat behind it.
   *
   * Returns null when nothing applies, and the opening then pays full price.
   */
  async applyBest(
    tx: Prisma.TransactionClient,
    userId: string,
    casePrice: number,
    count: number,
  ): Promise<AppliedBonus | null> {
    const open = await tx.dailyBonus.findMany({
      where: { userId, consumedAt: null },
      orderBy: { createdAt: 'asc' },
    });

    let best: { row: (typeof open)[number]; saving: number } | null = null;
    for (const row of open) {
      const saving = voucherSaving(row.kind as BonusKind, row.value, casePrice, count);
      if (saving <= 0) continue;
      // Strictly greater, so the oldest wins a tie and vouchers do not pile up.
      if (best === null || saving > best.saving) best = { row, saving };
    }
    if (best === null) return null;

    // Conditional claim, the same pattern the inventory uses: if the voucher
    // was spent by a concurrent opening the count is zero and this one simply
    // pays full price rather than spending it twice.
    const claimed = await tx.dailyBonus.updateMany({
      where: { id: best.row.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (claimed.count === 0) return null;

    return {
      bonusId: best.row.id,
      kind: best.row.kind as BonusKind,
      segmentKey: best.row.segmentKey,
      value: best.row.value,
      saving: best.saving,
    };
  }

  /**
   * The skin a FREE_ITEM slice turns into.
   *
   * Chosen from the catalogue by the same roll that picked the slice, so the
   * grant is a function of the seed pair rather than of a second, hidden
   * random draw. The candidate list is ordered by id, which is stable across
   * calls in a way that ordering by a price that drifts is not.
   */
  private async pickGrantItem(
    tx: Prisma.TransactionClient,
    ceiling: number,
    roll: number,
  ): Promise<{
    id: string;
    marketHashName: string;
    imageUrl: string | null;
    rarity: ItemRarity;
    price: number;
  } | null> {
    const candidates = await tx.item.findMany({
      where: {
        isActive: true,
        priceUpdatedAt: { not: null },
        marketPrice: { gt: 0, lte: ceiling },
      },
      orderBy: { id: 'asc' },
    });

    const eligible = candidates
      .map((item) => ({ item, price: resolveItemPrice(item) }))
      .filter(({ price }) => price > 0 && price <= ceiling);
    if (eligible.length === 0) return null;

    const chosen = eligible[roll % eligible.length]!;
    return {
      id: chosen.item.id,
      marketHashName: chosen.item.marketHashName,
      imageUrl: chosen.item.imageUrl,
      rarity: chosen.item.rarity as ItemRarity,
      price: chosen.price,
    };
  }
}
