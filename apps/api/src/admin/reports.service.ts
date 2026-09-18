import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { PRISMA_READ } from '../common/prisma-read';

/** A reporting window. Both ends optional; absent means "since the beginning". */
export interface ReportPeriod {
  from?: Date;
  to?: Date;
}

/**
 * Reports an operator can take away.
 *
 * The dashboard answers "how are we doing"; this answers "show me the rows".
 * The difference matters at the point where somebody has to reconcile against a
 * bank statement, answer a chargeback, or hand an accountant something — none
 * of which a chart can do.
 *
 * Every figure comes from the transaction ledger rather than from the tables
 * the money passed through. A payment row says what a provider was asked for;
 * the ledger says what landed on a balance, and when the two disagree it is the
 * ledger that is right by construction.
 *
 * All of it goes through the read replica: a report is the definition of a
 * query nobody is waiting on, and a full-table scan belongs anywhere but the
 * primary.
 */
@Injectable()
export class ReportsService {
  constructor(@Inject(PRISMA_READ) private readonly read: PrismaClient) {}

  /**
   * Money in and money out, by channel, over a period.
   *
   * Channels are kept apart because they are not interchangeable: a card
   * top-up is cash with a processing fee, a skin deposit is inventory bought at
   * a discount, and a bonus is neither — it is a cost. Summing them into one
   * "revenue" number would hide the only thing the split is useful for.
   */
  async summary(period: ReportPeriod) {
    const createdAt = this.range(period);

    const byType = await this.read.transaction.groupBy({
      by: ['type'],
      where: { createdAt },
      _sum: { amount: true },
      _count: { _all: true },
    });

    const sum = (type: string): number =>
      byType.find((row) => row.type === type)?._sum.amount ?? 0;
    const count = (type: string): number =>
      byType.find((row) => row.type === type)?._count._all ?? 0;

    const moneyIn = sum('DEPOSIT');
    const itemsIn = sum('ITEM_DEPOSIT');
    const bonuses = sum('BONUS');
    // Case opens and battle entries are debits and arrive negative; flipped
    // here so the report reads in the direction an operator thinks in.
    const wagered = -(sum('CASE_OPEN') + sum('BATTLE_ENTRY'));
    const soldBack = sum('ITEM_SELL');

    return {
      period: { from: period.from?.toISOString() ?? null, to: period.to?.toISOString() ?? null },
      deposits: { money: moneyIn, items: itemsIn, count: count('DEPOSIT') + count('ITEM_DEPOSIT') },
      bonuses: { total: bonuses, count: count('BONUS') },
      wagered,
      soldBack,
      /**
       * What the site kept: what was staked, less what was handed back as
       * items sold in. Not a P&L — it says nothing about the cost of the skins
       * actually delivered — and named for what it measures rather than for
       * what somebody might hope it measures.
       */
      grossMargin: wagered - soldBack,
      referralPaid: sum('REFERRAL'),
      adminAdjustments: sum('ADMIN_ADJUSTMENT'),
    };
  }

  /** The ledger itself, row by row. The document an accountant asks for. */
  async transactionsCsv(period: ReportPeriod): Promise<string> {
    const rows = await this.read.transaction.findMany({
      where: { createdAt: this.range(period) },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { username: true, steamId64: true } } },
      // Capped rather than streamed: a window wide enough to exceed this is a
      // window that wants narrowing, and an unbounded export is how a report
      // takes the API down.
      take: 100_000,
    });

    return this.csv(
      ['id', 'createdAt', 'steamId64', 'username', 'type', 'amount', 'balanceAfter', 'comment'],
      rows.map((row) => [
        row.id,
        row.createdAt.toISOString(),
        row.user.steamId64,
        row.user.username,
        row.type,
        this.money(row.amount),
        this.money(row.balanceAfter),
        row.comment ?? '',
      ]),
    );
  }

  /** Top-ups as the provider saw them, for reconciling against a statement. */
  async paymentsCsv(period: ReportPeriod): Promise<string> {
    const rows = await this.read.payment.findMany({
      where: { createdAt: this.range(period) },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { username: true, steamId64: true } } },
      take: 100_000,
    });

    return this.csv(
      [
        'id',
        'createdAt',
        'completedAt',
        'steamId64',
        'username',
        'provider',
        'providerRef',
        'status',
        'amount',
        'bonus',
        'promoCode',
      ],
      rows.map((row) => [
        row.id,
        row.createdAt.toISOString(),
        row.completedAt?.toISOString() ?? '',
        row.user.steamId64,
        row.user.username,
        row.provider,
        row.providerRef ?? '',
        row.status,
        this.money(row.amount),
        this.money(row.bonus),
        row.promoCode ?? '',
      ]),
    );
  }

  /** What went out, and whether it arrived. */
  async withdrawalsCsv(period: ReportPeriod): Promise<string> {
    const rows = await this.read.withdrawal.findMany({
      where: { createdAt: this.range(period) },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { username: true, steamId64: true } },
        items: { select: { marketHashName: true, price: true } },
      },
      take: 100_000,
    });

    return this.csv(
      [
        'id',
        'createdAt',
        'completedAt',
        'steamId64',
        'username',
        'provider',
        'status',
        'totalValue',
        'itemCount',
        'items',
      ],
      rows.map((row) => [
        row.id,
        row.createdAt.toISOString(),
        row.completedAt?.toISOString() ?? '',
        row.user.steamId64,
        row.user.username,
        row.provider,
        row.status,
        this.money(row.totalValue),
        String(row.items.length),
        row.items.map((i) => i.marketHashName).join('; '),
      ]),
    );
  }

  /** Skins taken in, with what they were valued at and what was paid. */
  async itemDepositsCsv(period: ReportPeriod): Promise<string> {
    const rows = await this.read.itemDeposit.findMany({
      where: { createdAt: this.range(period) },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { username: true, steamId64: true } },
        items: { select: { marketHashName: true, marketPrice: true, payout: true } },
      },
      take: 100_000,
    });

    return this.csv(
      [
        'id',
        'createdAt',
        'completedAt',
        'steamId64',
        'username',
        'status',
        'rateBps',
        'marketValue',
        'paidOut',
        'itemCount',
        'items',
      ],
      rows.map((row) => [
        row.id,
        row.createdAt.toISOString(),
        row.completedAt?.toISOString() ?? '',
        row.user.steamId64,
        row.user.username,
        row.status,
        String(row.rateBps),
        this.money(row.items.reduce((s, i) => s + i.marketPrice, 0)),
        this.money(row.totalValue),
        String(row.items.length),
        row.items.map((i) => i.marketHashName).join('; '),
      ]),
    );
  }

  private range(period: ReportPeriod): { gte?: Date; lte?: Date } | undefined {
    if (!period.from && !period.to) return undefined;
    return { ...(period.from && { gte: period.from }), ...(period.to && { lte: period.to }) };
  }

  /** Minor units as a decimal, because a spreadsheet reads 12.34 and not 1234. */
  private money(minor: number): string {
    return (minor / 100).toFixed(2);
  }

  /**
   * Rows into CSV.
   *
   * Written here rather than pulled in as a dependency, because the whole of
   * the format that matters is this function: quote every field, double the
   * quotes inside it. The leading BOM is for Excel, which otherwise reads a
   * UTF-8 file as the local codepage and turns every Cyrillic nickname into
   * mojibake.
   */
  private csv(header: string[], rows: string[][]): string {
    const escape = (value: string): string => `"${value.replace(/"/g, '""')}"`;
    const lines = [header.map(escape).join(','), ...rows.map((r) => r.map(escape).join(','))];
    return '﻿' + lines.join('\r\n') + '\r\n';
  }
}
