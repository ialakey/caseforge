import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  type UpsertCaseInput,
  ErrorCode,
  calculateRtp,
  judgeRtp,
  validateTicketRanges,
} from '@caseforge/shared';
import { PrismaService } from '../common/prisma.service';
import { PRISMA_READ } from '../common/prisma-read';
import { SettingsService } from '../common/settings.service';
import { CasesService } from '../cases/cases.service';
import { MarketService } from '../market/market.service';
import { badRequest, notFound } from '../common/app-error';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    /**
     * Every report and every listing on this class reads through here, and a
     * configured replica is what stops them touching the game core: a
     * thirty-day dashboard aggregate over `case_openings` is the heaviest query
     * the site makes, and it runs while people are opening cases. What an
     * operator is looking at may be seconds out of date; a debit may not.
     */
    @Inject(PRISMA_READ) private readonly read: PrismaClient,
    private readonly cases: CasesService,
    private readonly settings: SettingsService,
    private readonly market: MarketService,
  ) {}

  /**
   * Dashboard summary.
   *
   * GGR (gross gaming revenue) = wagers minus wins. For cases that is the sum
   * of opened case prices minus the value of the items dropped: that number,
   * not turnover, says whether the project earns anything.
   */
  async dashboard(from: Date, to: Date) {
    const period = { gte: from, lte: to };

    const [openingAgg, deposits, withdrawalsCompleted, newUsers, activeUsers] = await Promise.all([
      this.read.caseOpening.aggregate({
        where: { createdAt: period },
        _sum: { casePrice: true, itemPrice: true },
        _count: true,
      }),
      this.read.transaction.aggregate({
        where: { type: 'DEPOSIT', createdAt: period },
        _sum: { amount: true },
        _count: true,
      }),
      this.read.withdrawal.aggregate({
        where: { status: 'COMPLETED', completedAt: period },
        _sum: { totalValue: true },
        _count: true,
      }),
      this.read.user.count({ where: { createdAt: period } }),
      this.read.caseOpening
        .findMany({ where: { createdAt: period }, select: { userId: true }, distinct: ['userId'] })
        .then((rows) => rows.length),
    ]);

    const wagered = openingAgg._sum.casePrice ?? 0;
    const won = openingAgg._sum.itemPrice ?? 0;

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      openings: openingAgg._count,
      wagered,
      won,
      ggr: wagered - won,
      /// Actual RTP for the period — a gap against the planned value means
      /// either a skew in which cases are popular or a bug in the ranges.
      actualRtp: wagered > 0 ? won / wagered : 0,
      deposits: { count: deposits._count, total: deposits._sum.amount ?? 0 },
      withdrawals: {
        count: withdrawalsCompleted._count,
        total: withdrawalsCompleted._sum.totalValue ?? 0,
      },
      newUsers,
      activeUsers,
    };
  }

  /** Per-case margin: where the site earns and where it loses. */
  async caseReport(from: Date, to: Date) {
    const grouped = await this.read.caseOpening.groupBy({
      by: ['caseId'],
      where: { createdAt: { gte: from, lte: to } },
      _sum: { casePrice: true, itemPrice: true },
      _count: true,
    });

    const cases = await this.read.case.findMany({
      where: { id: { in: grouped.map((g) => g.caseId) } },
      select: { id: true, name: true, slug: true, price: true, rtpCached: true },
    });
    const byId = new Map(cases.map((c) => [c.id, c]));

    return grouped
      .map((g) => {
        const wagered = g._sum.casePrice ?? 0;
        const won = g._sum.itemPrice ?? 0;
        const info = byId.get(g.caseId);
        return {
          caseId: g.caseId,
          name: info?.name ?? '—',
          slug: info?.slug ?? '',
          price: info?.price ?? 0,
          openings: g._count,
          wagered,
          won,
          ggr: wagered - won,
          actualRtp: wagered > 0 ? won / wagered : 0,
          plannedRtp: info?.rtpCached ?? null,
        };
      })
      .sort((a, b) => b.ggr - a.ggr);
  }

  /**
   * Creates or updates a case.
   *
   * Ranges must cover the whole ticket space with no gaps or overlaps —
   * without this check a case can produce a roll no item matches, and the
   * opening fails after the balance has already been debited.
   */
  async upsertCase(actorId: string, input: UpsertCaseInput, ip: string | null) {
    const validation = validateTicketRanges(input.items);
    if (!validation.valid) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Invalid ticket ranges',
        issues: validation.errors,
      });
    }

    const items = await this.prisma.item.findMany({
      where: { id: { in: input.items.map((i) => i.itemId) } },
    });
    if (items.length !== new Set(input.items.map((i) => i.itemId)).size) {
      throw new BadRequestException('Some items were not found');
    }

    // RTP is computed before writing: a case returning over 100% runs at a
    // loss, and that has to be caught here rather than in a report a month
    // later. The client shows the same number using the same function, but the
    // client cannot be trusted.
    const priceById = new Map(items.map((i) => [i.id, CasesService.resolvePrice(i)] as const));
    const plannedRtp = calculateRtp(
      input.items.map((i) => ({
        rangeFrom: i.rangeFrom,
        rangeTo: i.rangeTo,
        price: priceById.get(i.itemId) ?? 0,
      })),
      input.price,
    );

    const verdict = judgeRtp(plannedRtp);
    if (!verdict.allowed) {
      throw new BadRequestException({ message: verdict.message, rtp: plannedRtp });
    }

    const withoutPrice = input.items.filter((i) => (priceById.get(i.itemId) ?? 0) <= 0);
    if (withoutPrice.length > 0) {
      throw new BadRequestException(
        `${withoutPrice.length} item(s) have no price — sync prices from Steam before saving the case`,
      );
    }

    const before = await this.prisma.case.findUnique({
      where: { slug: input.slug },
      include: { items: true },
    });

    const saved = await this.prisma.$transaction(async (tx) => {
      const gameCase = await tx.case.upsert({
        where: { slug: input.slug },
        create: {
          slug: input.slug,
          name: input.name,
          nameEn: input.nameEn ?? null,
          price: input.price,
          imageUrl: input.imageUrl ?? null,
          isActive: input.isActive,
          sortOrder: input.sortOrder,
        },
        update: {
          name: input.name,
          nameEn: input.nameEn ?? null,
          price: input.price,
          imageUrl: input.imageUrl ?? null,
          isActive: input.isActive,
          sortOrder: input.sortOrder,
        },
      });

      // The contents are rewritten wholesale: partially updating ranges
      // inevitably leaves holes in the coverage.
      await tx.caseItem.deleteMany({ where: { caseId: gameCase.id } });
      await tx.caseItem.createMany({
        data: input.items.map((i) => ({
          caseId: gameCase.id,
          itemId: i.itemId,
          rangeFrom: i.rangeFrom,
          rangeTo: i.rangeTo,
        })),
      });

      return tx.case.update({
        where: { id: gameCase.id },
        data: { rtpCached: plannedRtp, rtpCalculatedAt: new Date() },
        include: { items: true },
      });
    });

    // The catalogue everybody reads is cached; the operator who just edited it
    // has to see their own change rather than the last minute of staleness.
    await this.cases.invalidateCatalogue();

    await this.audit(actorId, 'case.upsert', 'Case', saved.id, before, saved, ip);
    return saved;
  }

  /** Every case, disabled ones included — this is the operator's view, not the player's. */
  async listCases() {
    const cases = await this.read.case.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { items: { include: { item: true }, orderBy: { rangeFrom: 'asc' } } },
    });

    return cases.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      nameEn: c.nameEn,
      price: c.price,
      imageUrl: c.imageUrl,
      isActive: c.isActive,
      sortOrder: c.sortOrder,
      rtp: c.rtpCached,
      itemCount: c.items.length,
      // An item whose price Steam never confirmed carries an invented number
      // yet counts towards RTP like any other. That belongs in the list, not
      // in a post-mortem after the losses.
      unconfirmedPrices: c.items.filter((ci) => ci.item.priceUpdatedAt === null).length,
    }));
  }

  /** A full case for editing in the builder. */
  async getCase(slug: string) {
    const gameCase = await this.read.case.findUnique({
      where: { slug },
      include: { items: { include: { item: true }, orderBy: { rangeFrom: 'asc' } } },
    });
    if (!gameCase) throw new NotFoundException('Case not found');

    return {
      id: gameCase.id,
      slug: gameCase.slug,
      name: gameCase.name,
      nameEn: gameCase.nameEn,
      price: gameCase.price,
      imageUrl: gameCase.imageUrl,
      isActive: gameCase.isActive,
      sortOrder: gameCase.sortOrder,
      rtp: gameCase.rtpCached,
      items: gameCase.items.map((ci) => ({
        itemId: ci.itemId,
        marketHashName: ci.item.marketHashName,
        name: ci.item.name,
        imageUrl: ci.item.imageUrl,
        rarity: ci.item.rarity,
        price: CasesService.resolvePrice(ci.item),
        priceUpdatedAt: ci.item.priceUpdatedAt?.toISOString() ?? null,
        rangeFrom: ci.rangeFrom,
        rangeTo: ci.rangeTo,
      })),
    };
  }

  async listItems(search: string | undefined, page: number, perPage: number) {
    const where: Prisma.ItemWhereInput = search
      ? { marketHashName: { contains: search, mode: 'insensitive' } }
      : {};

    const [total, items] = await Promise.all([
      this.read.item.count({ where }),
      this.read.item.findMany({
        where,
        orderBy: { marketHashName: 'asc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
    ]);
    return { total, page, perPage, items };
  }

  async listUsers(search: string | undefined, page: number, perPage: number) {
    const where: Prisma.UserWhereInput = search
      ? {
          OR: [
            { username: { contains: search, mode: 'insensitive' } },
            { steamId64: { contains: search } },
          ],
        }
      : {};

    const [total, users] = await Promise.all([
      this.read.user.count({ where }),
      this.read.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        select: {
          id: true,
          steamId64: true,
          username: true,
          avatarUrl: true,
          role: true,
          balance: true,
          isBanned: true,
          createdAt: true,
          lastLoginAt: true,
        },
      }),
    ]);
    return { total, page, perPage, items: users };
  }

  /**
   * Manual balance adjustment.
   *
   * Goes through Transaction only — a direct balance UPDATE bypassing the
   * ledger breaks the nightly reconciliation and makes an incident impossible
   * to investigate.
   */
  async adjustBalance(
    actorId: string,
    userId: string,
    amount: number,
    reason: string,
    ip: string | null,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundException('User not found');
      if (user.balance + amount < 0) {
        throw new BadRequestException('The adjustment would drive the balance negative');
      }

      const updated = await tx.user.update({
        where: { id: userId },
        data: { balance: { increment: amount } },
        select: { balance: true },
      });

      await tx.transaction.create({
        data: {
          userId,
          type: 'ADMIN_ADJUSTMENT',
          amount,
          balanceAfter: updated.balance,
          comment: reason,
        },
      });

      return { before: user.balance, after: updated.balance };
    });

    await this.audit(
      actorId,
      'user.adjustBalance',
      'User',
      userId,
      { balance: result.before },
      { balance: result.after, amount, reason },
      ip,
    );
    return result;
  }

  async setBanned(
    actorId: string,
    userId: string,
    isBanned: boolean,
    reason: string | null,
    ip: string | null,
  ) {
    const before = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isBanned: true, banReason: true },
    });
    if (!before) throw new NotFoundException('User not found');

    const after = await this.prisma.user.update({
      where: { id: userId },
      data: { isBanned, banReason: isBanned ? reason : null },
      select: { isBanned: true, banReason: true },
    });

    await this.audit(actorId, 'user.setBanned', 'User', userId, before, after, ip);
    return after;
  }

  async listWithdrawals(status: string | undefined, page: number, perPage: number) {
    const where = status ? { status: status as Prisma.EnumWithdrawalStatusFilter['equals'] } : {};

    const [total, items] = await Promise.all([
      this.read.withdrawal.count({ where }),
      this.read.withdrawal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        include: {
          user: { select: { username: true, steamId64: true } },
          // The request's own lines, not the inventory rows it happens to still
          // be holding: a failed request holds none and would otherwise look
          // like it had been for nothing.
          items: { orderBy: { createdAt: 'asc' } },
          bot: { select: { username: true, steamId64: true } },
          purchases: true,
        },
      }),
    ]);
    return { total, page, perPage, items };
  }

  /**
   * The market channel at a glance.
   *
   * Three questions an operator actually has: can the account buy, what is it
   * in the middle of buying, and what has been paid for but not delivered. The
   * last one is the reason this page exists — a purchase is never written off
   * on a timer, so somebody has to be told about it.
   */
  async marketOverview() {
    const stuckMinutes = await this.settings.read<number>('withdrawals.market.stuckAfterMin');
    const cutoff = new Date(Date.now() - stuckMinutes * 60_000);

    const [accounts, spendable, counts, stuck, spent] = await Promise.all([
      this.market.accounts(),
      this.market.spendableBalance(),
      this.read.marketPurchase.groupBy({ by: ['status'], _count: { _all: true } }),
      this.read.marketPurchase.findMany({
        where: { status: 'BOUGHT', boughtAt: { lt: cutoff } },
        orderBy: { boughtAt: 'asc' },
        take: 50,
        include: {
          withdrawal: {
            select: { id: true, user: { select: { username: true, steamId64: true } } },
          },
          account: { select: { id: true, label: true } },
        },
      }),
      // What the channel has actually cost, against what the site valued the
      // items at. The gap is the margin the overpay ceiling is protecting.
      this.read.marketPurchase.aggregate({
        where: { status: 'DELIVERED' },
        _sum: { paidPrice: true, maxPrice: true },
        _count: { _all: true },
      }),
    ]);

    return {
      accounts,
      spendable,
      stuckAfterMin: stuckMinutes,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
      delivered: {
        count: spent._count._all,
        paid: spent._sum.paidPrice ?? 0,
        authorised: spent._sum.maxPrice ?? 0,
      },
      stuck,
    };
  }

  async listMarketPurchases(status: string | undefined, page: number, perPage: number) {
    const where = status
      ? { status: status as Prisma.EnumMarketPurchaseStatusFilter['equals'] }
      : {};

    const [total, items] = await Promise.all([
      this.read.marketPurchase.count({ where }),
      this.read.marketPurchase.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        include: {
          withdrawal: {
            select: {
              id: true,
              status: true,
              user: { select: { username: true, steamId64: true } },
            },
          },
          account: { select: { id: true, label: true } },
        },
      }),
    ]);
    return { total, page, perPage, items };
  }

  /**
   * Takes a market account out of rotation, or puts it back.
   *
   * Two transitions only, and neither of them ONLINE: the worker owns that, and
   * a panel that could declare an account healthy would be a second author of
   * the same fact — which is how an account ends up ONLINE in the table and
   * rejected by the market in reality. Re-enabling lands on OFFLINE, and the
   * worker's next refresh decides whether it deserves better.
   */
  async setMarketAccountStatus(
    actorId: string,
    accountId: string,
    status: 'DISABLED' | 'OFFLINE',
    ip: string | null,
  ) {
    const before = await this.prisma.marketAccount.findUnique({ where: { id: accountId } });
    if (!before) throw notFound(ErrorCode.VALIDATION_FAILED, 'Market account not found');

    const after = await this.prisma.marketAccount.update({
      where: { id: accountId },
      data: { status, lastError: status === 'OFFLINE' ? null : before.lastError },
    });
    await this.audit(
      actorId,
      'marketAccount.setStatus',
      'MarketAccount',
      accountId,
      { status: before.status },
      { status: after.status },
      ip,
    );
    return { id: after.id, status: after.status };
  }

  async listBots() {
    return this.read.steamBot.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        steamId64: true,
        username: true,
        label: true,
        status: true,
        maxItems: true,
        currentItems: true,
        lastOnlineAt: true,
        lastError: true,
      },
    });
  }

  async listAuditLog(page: number, perPage: number) {
    const [total, items] = await Promise.all([
      this.read.auditLog.count(),
      this.read.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
        include: { actor: { select: { username: true, steamId64: true } } },
      }),
    ]);
    return { total, page, perPage, items };
  }

  /**
   * Saves a batch of settings and records what changed.
   *
   * The audit entry holds the values that were actually stored rather than the
   * ones submitted, because validation coerces — an operator typing "60" into
   * a number field should see 60 in the log, not "60".
   */
  async saveSettings(
    actorId: string,
    entries: Record<string, unknown>,
    ip: string | null,
  ): Promise<Record<string, unknown>> {
    const before = await this.settings.all();
    const result = await this.settings.setMany(entries);
    if (!result.ok) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, result.errors.join('; '));
    }

    // Only the keys that moved: a diff of a dozen settings where one changed
    // is a log nobody reads.
    const changed = Object.fromEntries(
      Object.entries(result.saved).filter(
        ([k, v]) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify(v),
      ),
    );
    const previous = Object.fromEntries(
      Object.keys(changed).map((k) => [k, (before as Record<string, unknown>)[k]]),
    );

    if (Object.keys(changed).length > 0) {
      await this.audit(actorId, 'settings.update', 'Setting', null, previous, changed, ip);
    }
    return this.settings.all();
  }

  /**
   * Changes a bot's status by hand.
   *
   * The worker owns the lifecycle, so this exists for the two transitions an
   * operator genuinely needs: taking a misbehaving bot out of rotation, and
   * putting it back. Anything else would be fighting the worker.
   */
  async setBotStatus(
    actorId: string,
    botId: string,
    status: 'DISABLED' | 'OFFLINE',
    ip: string | null,
  ) {
    const before = await this.prisma.steamBot.findUnique({ where: { id: botId } });
    if (!before) throw notFound(ErrorCode.VALIDATION_FAILED, 'Bot not found');

    const after = await this.prisma.steamBot.update({
      where: { id: botId },
      data: { status },
    });
    await this.audit(
      actorId,
      'bot.setStatus',
      'SteamBot',
      botId,
      { status: before.status },
      { status: after.status },
      ip,
    );
    return { id: after.id, status: after.status };
  }

  private async audit(
    actorId: string,
    action: string,
    entityType: string,
    entityId: string | null,
    before: unknown,
    after: unknown,
    ip: string | null,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorId,
        action,
        entityType,
        entityId,
        before:
          before === null
            ? undefined
            : (JSON.parse(JSON.stringify(before)) as Prisma.InputJsonValue),
        after:
          after === null ? undefined : (JSON.parse(JSON.stringify(after)) as Prisma.InputJsonValue),
        ip,
      },
    });
  }
}
