import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  type FeaturedPromo,
  type PromoKind,
  type UpsertPromoCodeInput,
  ErrorCode,
  checkPromoCode,
  normalisePromoCode,
} from '@caseforge/shared';
import { PrismaService } from '../common/prisma.service';
import { badRequest, notFound } from '../common/app-error';

export interface PromoPreview {
  code: string;
  kind: PromoKind;
  /** What the code would add to this deposit, in minor units. */
  bonus: number;
}

/** What a redemption took, resolved inside the deposit's transaction. */
export interface AppliedPromo {
  promoCodeId: string;
  code: string;
  bonus: number;
}

@Injectable()
export class PromoService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * What a code is worth on a deposit, without redeeming it.
   *
   * Used by the top-up dialog while the player types. It reads the same rules
   * the redemption does, so the quoted number and the credited one cannot
   * disagree — but it is only a quote: between the preview and the button the
   * code may run out, and only the redemption can say for sure.
   */
  async preview(userId: string, rawCode: string, amount: number): Promise<PromoPreview> {
    const code = normalisePromoCode(rawCode);
    const promo = await this.prisma.promoCode.findUnique({ where: { code } });
    if (!promo) throw notFound(ErrorCode.PROMO_INVALID, 'No such promo code');

    const usedByPlayer = await this.prisma.promoRedemption.count({
      where: { promoCodeId: promo.id, userId },
    });

    const check = checkPromoCode(promo, amount, usedByPlayer);
    if (!check.ok) throw badRequest(ErrorCode.PROMO_INVALID, promoRejectionMessage(check.reason));

    return { code: promo.code, kind: promo.kind as PromoKind, bonus: check.bonus };
  }

  /**
   * Redeems a code as part of a deposit.
   *
   * Runs inside the deposit's transaction. The global limit is enforced by a
   * conditional UPDATE on the counter rather than by counting rows and then
   * writing: between a count and an insert two deposits fired together both
   * see the last use available and both take it. Zero affected rows means
   * somebody else took the last one.
   */
  async redeem(
    tx: Prisma.TransactionClient,
    userId: string,
    rawCode: string,
    amount: number,
  ): Promise<AppliedPromo> {
    const code = normalisePromoCode(rawCode);
    const promo = await tx.promoCode.findUnique({ where: { code } });
    if (!promo) throw badRequest(ErrorCode.PROMO_INVALID, 'No such promo code');

    const usedByPlayer = await tx.promoRedemption.count({
      where: { promoCodeId: promo.id, userId },
    });

    const check = checkPromoCode(promo, amount, usedByPlayer);
    if (!check.ok) throw badRequest(ErrorCode.PROMO_INVALID, promoRejectionMessage(check.reason));

    const claimed = await tx.promoCode.updateMany({
      where: {
        id: promo.id,
        isActive: true,
        // `null` means unlimited, so the guard only applies to a real cap.
        ...(promo.maxUses === null ? {} : { usedCount: { lt: promo.maxUses } }),
      },
      data: { usedCount: { increment: 1 } },
    });
    if (claimed.count === 0) {
      throw badRequest(ErrorCode.PROMO_INVALID, 'This promo code has just run out');
    }

    await tx.promoRedemption.create({
      data: {
        promoCodeId: promo.id,
        userId,
        depositAmount: amount,
        bonusAmount: check.bonus,
      },
    });

    return { promoCodeId: promo.id, code: promo.code, bonus: check.bonus };
  }

  /** Every code, for the admin panel. */
  async list() {
    const rows = await this.prisma.promoCode.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((p) => ({
      id: p.id,
      code: p.code,
      kind: p.kind as PromoKind,
      value: p.value,
      minDeposit: p.minDeposit,
      maxBonus: p.maxBonus,
      maxUses: p.maxUses,
      usedCount: p.usedCount,
      perUserLimit: p.perUserLimit,
      isActive: p.isActive,
      startsAt: p.startsAt?.toISOString() ?? null,
      expiresAt: p.expiresAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
    }));
  }

  /**
   * Creates a code, or edits one that already exists.
   *
   * `usedCount` is deliberately never written here: editing a live code must
   * not reset how many times it has been redeemed, or a capped code becomes
   * uncapped every time somebody fixes a typo in it.
   */
  async upsert(input: UpsertPromoCodeInput) {
    const data = {
      kind: input.kind,
      value: input.value,
      minDeposit: input.minDeposit,
      maxBonus: input.maxBonus,
      maxUses: input.maxUses,
      perUserLimit: input.perUserLimit,
      isActive: input.isActive,
      isFeatured: input.isFeatured,
      startsAt: input.startsAt === null ? null : new Date(input.startsAt),
      expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt),
    };

    return this.prisma.promoCode.upsert({
      where: { code: input.code },
      create: { code: input.code, ...data },
      update: data,
    });
  }

  /**
   * The promotion the landing page advertises, or null.
   *
   * Featured *and* currently valid: a code an operator marked for the front
   * page months ago and let expire should stop being advertised on its own,
   * rather than waiting for somebody to notice. Exhausted codes drop out too —
   * an advertisement for something that will be refused is worse than no
   * advertisement.
   *
   * Newest first when several qualify, on the grounds that the most recent one
   * is the campaign somebody is currently running.
   */
  async featured(): Promise<FeaturedPromo | null> {
    const now = new Date();
    const code = await this.prisma.promoCode.findFirst({
      where: {
        isFeatured: true,
        isActive: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: { code: true, kind: true, value: true, minDeposit: true, maxUses: true, usedCount: true },
    });

    if (!code) return null;
    if (code.maxUses !== null && code.usedCount >= code.maxUses) return null;

    return {
      code: code.code,
      kind: code.kind as FeaturedPromo['kind'],
      value: code.value,
      minDeposit: code.minDeposit,
    };
  }

  /**
   * Switches a code off.
   *
   * Deactivating rather than deleting: the redemptions point at it, and a
   * player asking why their balance moved deserves a row that still explains it.
   */
  async deactivate(id: string) {
    return this.prisma.promoCode.update({ where: { id }, data: { isActive: false } });
  }
}

function promoRejectionMessage(reason: string): string {
  switch (reason) {
    case 'INACTIVE':
      return 'This promo code is no longer active';
    case 'NOT_STARTED':
      return 'This promo code is not active yet';
    case 'EXPIRED':
      return 'This promo code has expired';
    case 'EXHAUSTED':
      return 'This promo code has been used up';
    case 'ALREADY_USED':
      return 'You have already used this promo code';
    case 'DEPOSIT_TOO_SMALL':
      return 'The top-up is too small for this promo code';
    default:
      return 'This promo code cannot be used';
  }
}
