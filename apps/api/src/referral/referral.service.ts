import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  type ReferralClaimResult,
  type ReferralEarningKind,
  type ReferralSummary,
  ErrorCode,
  REFERRAL_CODE_LENGTH,
  ReferralRejection,
  checkReferralBinding,
  checkReferralClaim,
  normaliseReferralCode,
  referralCodeFromBytes,
  referralCommission,
} from '@caseforge/shared';
import { PrismaService } from '../common/prisma.service';
import { SettingsService } from '../common/settings.service';
import { badRequest, notFound } from '../common/app-error';

/** How many invitees and accruals the page shows before it is a report, not a page. */
const INVITEE_LIMIT = 50;
const EARNING_LIMIT = 50;

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * The referral page in one response.
   *
   * The commission rates travel with it rather than being baked into the front
   * end: they are settings, and a page quoting a percentage the server no
   * longer pays is worse than a page that says nothing.
   */
  async summary(userId: string): Promise<ReferralSummary> {
    await this.settings.ensureFresh();
    const code = await this.ensureCode(userId);

    const [pendingAgg, claimedAgg, links, earnings, origin] = await Promise.all([
      this.prisma.referralEarning.aggregate({
        where: { referrerId: userId, claimedAt: null },
        _sum: { amount: true },
      }),
      this.prisma.referralEarning.aggregate({
        where: { referrerId: userId, claimedAt: { not: null } },
        _sum: { amount: true },
      }),
      this.prisma.referral.findMany({
        where: { referrerId: userId },
        orderBy: { createdAt: 'desc' },
        take: INVITEE_LIMIT,
        include: { referee: { select: { id: true, username: true, avatarUrl: true } } },
      }),
      this.prisma.referralEarning.findMany({
        where: { referrerId: userId },
        orderBy: { createdAt: 'desc' },
        take: EARNING_LIMIT,
        include: { referee: { select: { username: true } } },
      }),
      this.prisma.referral.findUnique({
        where: { refereeId: userId },
        include: { referrer: { select: { username: true, avatarUrl: true } } },
      }),
    ]);

    // What each invitee has brought in, claimed or not. Grouped rather than
    // counted per row: an inviter with fifty recruits would otherwise be fifty
    // queries.
    const perReferee = await this.prisma.referralEarning.groupBy({
      by: ['refereeId'],
      where: { referrerId: userId },
      _sum: { amount: true },
    });
    const earnedByReferee = new Map(perReferee.map((row) => [row.refereeId, row._sum.amount ?? 0]));

    return {
      enabled: this.settings.get<boolean>('referral.enabled'),
      code,
      depositBps: this.settings.get<number>('referral.depositBps'),
      wagerBps: this.settings.get<number>('referral.wagerBps'),
      minClaim: this.settings.get<number>('referral.minClaim'),

      invited: await this.prisma.referral.count({ where: { referrerId: userId } }),
      pending: pendingAgg._sum.amount ?? 0,
      claimed: claimedAgg._sum.amount ?? 0,

      invitedBy: origin
        ? { username: origin.referrer.username, avatarUrl: origin.referrer.avatarUrl }
        : null,

      invitees: links.map((link) => ({
        userId: link.refereeId,
        username: link.referee.username,
        avatarUrl: link.referee.avatarUrl,
        joinedAt: link.createdAt.toISOString(),
        earned: earnedByReferee.get(link.refereeId) ?? 0,
      })),

      earnings: earnings.map((row) => ({
        id: row.id,
        kind: row.kind as ReferralEarningKind,
        username: row.referee.username,
        sourceAmount: row.sourceAmount,
        rateBps: row.rateBps,
        amount: row.amount,
        claimedAt: row.claimedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Applies an invite to this account.
   *
   * Called by the browser moments after sign-in, which is the only moment it
   * can be: the invite is known to the page, and the page only gets a turn once
   * the Steam redirect is over. `checkReferralBinding` carries the rules; the
   * only thing resolved here is what the database has to say about them.
   */
  async bind(userId: string, rawCode: string, ip: string | null): Promise<{ code: string }> {
    await this.settings.ensureFresh();
    const code = normaliseReferralCode(rawCode);

    const [inviter, self, alreadyBound, transactions, openings] = await Promise.all([
      this.prisma.user.findUnique({
        where: { referralCode: code },
        select: { id: true, isBanned: true, registrationIp: true },
      }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { registrationIp: true } }),
      this.prisma.referral.findUnique({ where: { refereeId: userId } }),
      this.prisma.transaction.count({ where: { userId } }),
      this.prisma.caseOpening.count({ where: { userId } }),
    ]);
    if (!self) throw new NotFoundException('User not found');

    const check = checkReferralBinding({
      enabled: this.settings.get<boolean>('referral.enabled'),
      // A banned inviter is treated as no inviter at all rather than as a
      // separate error: the recruit has done nothing wrong and does not need
      // to be told whose account is in trouble.
      found: inviter !== null && !inviter.isBanned,
      isSelf: inviter?.id === userId,
      alreadyBound: alreadyBound !== null,
      accountActive: transactions > 0 || openings > 0,
    });
    if (!check.ok) throw referralRejection(check.reason);

    try {
      await this.prisma.referral.create({
        data: {
          referrerId: inviter!.id,
          refereeId: userId,
          code,
          sameIp: self.registrationIp !== null && self.registrationIp === inviter!.registrationIp,
        },
      });
    } catch (err) {
      // Two claims fired together: the unique `refereeId` is what actually
      // enforces "one inviter per player", and the loser of the race sees the
      // same answer it would have seen a moment later.
      if (isUniqueViolation(err)) throw referralRejection(ReferralRejection.ALREADY_BOUND);
      throw err;
    }

    return { code };
  }

  /** Replaces the generated code with one the player chose. */
  async setCode(userId: string, rawCode: string): Promise<{ code: string }> {
    const code = normaliseReferralCode(rawCode);
    try {
      await this.prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw badRequest(ErrorCode.REFERRAL_CODE_TAKEN, 'That code is already taken');
      }
      throw err;
    }
    return { code };
  }

  /**
   * Pays the pending pot onto the balance.
   *
   * The rows are claimed first and the floor is checked against what was
   * actually claimed. The other order — sum, check, then update — pays out a
   * different number from the one it checked whenever an accrual lands in
   * between, and an accrual landing in between is the normal case for an
   * inviter with active recruits. A throw here rolls the claim back, so a
   * refusal leaves the pot exactly as it was.
   */
  async claim(userId: string): Promise<ReferralClaimResult> {
    await this.settings.ensureFresh();
    const minClaim = this.settings.get<number>('referral.minClaim');

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<Array<{ amount: number }>>`
        UPDATE referral_earnings
        SET "claimedAt" = NOW()
        WHERE "referrerId" = CAST(${userId} AS uuid) AND "claimedAt" IS NULL
        RETURNING amount
      `;
      const pending = claimed.reduce((sum, row) => sum + row.amount, 0);

      const check = checkReferralClaim(pending, minClaim);
      if (!check.ok) {
        throw check.reason === 'NOTHING'
          ? badRequest(ErrorCode.REFERRAL_NOTHING_TO_CLAIM, 'There is nothing to pay out yet')
          : badRequest(
              ErrorCode.REFERRAL_BELOW_MIN_CLAIM,
              `The smallest payout is ${check.required}`,
            );
      }

      const updated = await tx.user.update({
        where: { id: userId },
        data: { balance: { increment: check.amount } },
        select: { balance: true },
      });

      // Through the ledger like every other balance movement — this is the one
      // point at which accrued commission becomes money.
      await tx.transaction.create({
        data: {
          userId,
          type: 'REFERRAL',
          amount: check.amount,
          balanceAfter: updated.balance,
          comment: `Referral commission, ${claimed.length} accruals`,
        },
      });

      return { amount: check.amount, balanceAfter: updated.balance };
    });
  }

  /** A share of a top-up. Called inside the deposit's transaction. */
  async accrueDeposit(
    tx: Prisma.TransactionClient,
    refereeId: string,
    amount: number,
    referenceId: string | null,
  ): Promise<number> {
    return this.accrue(tx, 'DEPOSIT', refereeId, amount, 'referral.depositBps', referenceId);
  }

  /**
   * A share of what the player spent on cases. Called inside the opening's or
   * the battle seat's transaction.
   */
  async accrueWager(
    tx: Prisma.TransactionClient,
    refereeId: string,
    amount: number,
    referenceId: string | null,
  ): Promise<number> {
    return this.accrue(tx, 'WAGER', refereeId, amount, 'referral.wagerBps', referenceId);
  }

  /**
   * Undoes accruals made against something that did not end up happening — a
   * battle that never filled and was refunded.
   *
   * Only pending rows are removed. An accrual that has already been paid out
   * is money on somebody's balance, and clawing that back would mean a debit
   * the inviter never agreed to; the far smaller risk is that a refunded seat
   * leaves a few kopecks paid. Without this, though, creating and cancelling
   * battles would be a free commission generator.
   */
  async reverseWager(tx: Prisma.TransactionClient, referenceId: string): Promise<number> {
    const removed = await tx.referralEarning.deleteMany({
      where: { referenceId, kind: 'WAGER', claimedAt: null },
    });
    return removed.count;
  }

  private async accrue(
    tx: Prisma.TransactionClient,
    kind: ReferralEarningKind,
    refereeId: string,
    sourceAmount: number,
    rateKey: 'referral.depositBps' | 'referral.wagerBps',
    referenceId: string | null,
  ): Promise<number> {
    // Read synchronously from the settings cache: this runs inside somebody
    // else's transaction, and whoever opened it has already refreshed.
    if (!this.settings.get<boolean>('referral.enabled')) return 0;
    const rateBps = this.settings.get<number>(rateKey);

    const amount = referralCommission(sourceAmount, rateBps);
    if (amount <= 0) return 0;

    // One indexed lookup on a unique column, and only players who were invited
    // by somebody pay for it.
    const link = await tx.referral.findUnique({
      where: { refereeId },
      select: { referrerId: true },
    });
    if (!link) return 0;

    await tx.referralEarning.create({
      data: {
        referrerId: link.referrerId,
        refereeId,
        kind,
        sourceAmount,
        rateBps,
        amount,
        referenceId,
      },
    });
    return amount;
  }

  /**
   * The player's own code, minted on first use.
   *
   * Lazily rather than at sign-up: accounts created before referrals existed
   * have none, and backfilling every one of them would hand out codes to people
   * who never open the page. Retried on a collision — with 31^8 possibilities
   * that is not expected, and it is one `catch` against a duplicate-key error
   * reaching the player.
   */
  private async ensureCode(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { referralCode: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.referralCode) return user.referralCode;

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = referralCodeFromBytes(randomBytes(REFERRAL_CODE_LENGTH));
      try {
        await this.prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
        return code;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        this.logger.warn(`Referral code ${code} was already taken, minting another`);
      }
    }
    throw new Error(`Could not mint a unique referral code for ${userId}`);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** The refusal reasons the domain returns, as API errors. */
function referralRejection(reason: ReferralRejection) {
  switch (reason) {
    case ReferralRejection.DISABLED:
      return badRequest(ErrorCode.REFERRAL_DISABLED, 'The referral programme is switched off');
    case ReferralRejection.NOT_FOUND:
      return notFound(ErrorCode.REFERRAL_CODE_INVALID, 'No such referral code');
    case ReferralRejection.SELF:
      return badRequest(ErrorCode.REFERRAL_SELF, 'You cannot invite yourself');
    case ReferralRejection.ALREADY_BOUND:
      return badRequest(ErrorCode.REFERRAL_ALREADY_BOUND, 'Somebody else has already invited you');
    case ReferralRejection.ACCOUNT_ACTIVE:
      return badRequest(
        ErrorCode.REFERRAL_ACCOUNT_ACTIVE,
        'This account has already played — an invite only applies to a new one',
      );
  }
}
