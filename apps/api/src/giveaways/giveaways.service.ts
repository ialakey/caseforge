import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  type GiveawayStanding,
  type GiveawayView,
  ErrorCode,
  ItemRarity,
  TICKET_SPACE,
} from '@caseforge/shared';
import { computeRoll, generateServerSeed, hashServerSeed } from '@caseforge/shared/node';
import { PrismaService } from '../common/prisma.service';
import { badRequest, forbidden, notFound } from '../common/app-error';

/**
 * Skin giveaways.
 *
 * A prize, a deadline, and a rule about who may enter: topping up at least
 * `minDeposit` while the giveaway is open. Both halves of the entry matter —
 * the threshold is what the promotion is *for*, and pressing the button is what
 * keeps the entrant list to people who actually want the thing rather than
 * everybody who happened to deposit that week.
 *
 * ## How the winner is picked
 *
 * On the same machinery as a case opening, and for the same reason: this site's
 * claim is that its randomness can be checked by hand, and a raffle that drew
 * its winner some other way would be the one place that claim did not hold.
 *
 * - `serverSeed` is generated when the giveaway is created and its hash is
 *   published immediately. The seed itself is withheld until the draw.
 * - `clientSeed` is a hash of the entrant list, in entry order, computed at the
 *   moment of the draw. This is the half that matters: the house knows the seed
 *   but cannot know its effect, because the effect depends on who enters — and
 *   it cannot quietly re-draw, because the published hash pins the seed to one
 *   value from the start.
 * - `roll = HMAC_SHA256(serverSeed, clientSeed:0) % TICKET_SPACE`, and the
 *   winner is entry number `roll % entryCount`.
 *
 * Afterwards all three — seed, client seed and roll — are public, so anybody
 * can recompute the winner from the entrant list.
 *
 * The modulo introduces a bias: with 336 entries, 64 of them are 1/2976 more
 * likely than the rest, about 0.03%. It is the same bias the ticket ranges
 * already carry, it is far below the noise of who happens to enter, and it is
 * written down here rather than left for somebody to find.
 */
@Injectable()
export class GiveawaysService {
  private readonly logger = new Logger(GiveawaysService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Everything worth showing: open now, plus the last few that were drawn. */
  async list(): Promise<GiveawayView[]> {
    const rows = await this.prisma.giveaway.findMany({
      where: { status: { in: ['SCHEDULED', 'OPEN', 'DRAWN'] } },
      orderBy: [{ status: 'asc' }, { drawsAt: 'asc' }],
      take: 24,
      include: this.include,
    });
    return rows.map((row) => this.toView(row));
  }

  /** The ones already drawn — the winners page. */
  async history(limit = 50): Promise<GiveawayView[]> {
    const rows = await this.prisma.giveaway.findMany({
      where: { status: 'DRAWN' },
      orderBy: { drawnAt: 'desc' },
      take: limit,
      include: this.include,
    });
    return rows.map((row) => this.toView(row));
  }

  /**
   * How one player stands against every giveaway currently open.
   *
   * Answered for all of them at once because the landing page asks about all
   * of them at once, and one request per card is a request per card.
   */
  async standings(userId: string): Promise<GiveawayStanding[]> {
    const open = await this.prisma.giveaway.findMany({
      where: { status: { in: ['SCHEDULED', 'OPEN'] } },
      select: { id: true, minDeposit: true, opensAt: true, status: true },
    });
    if (open.length === 0) return [];

    const entries = await this.prisma.giveawayEntry.findMany({
      where: { userId, giveawayId: { in: open.map((g) => g.id) } },
      select: { giveawayId: true },
    });
    const entered = new Set(entries.map((e) => e.giveawayId));

    // Deposits are counted from each giveaway's own opening time, so they are
    // summed per giveaway rather than once: two promotions that opened on
    // different days are two different questions about the same player.
    return Promise.all(
      open.map(async (giveaway) => {
        const deposited = await this.depositedSince(userId, giveaway.opensAt);
        return {
          giveawayId: giveaway.id,
          deposited,
          entered: entered.has(giveaway.id),
          canEnter:
            giveaway.status === 'OPEN' &&
            !entered.has(giveaway.id) &&
            deposited >= giveaway.minDeposit,
        };
      }),
    );
  }

  /**
   * Enters a player.
   *
   * The unique index does the work of refusing a second entry: checking first
   * and inserting afterwards is a race two clicks can win, and the database
   * already knows how to say no exactly once.
   */
  async enter(userId: string, giveawayId: string): Promise<GiveawayStanding> {
    const giveaway = await this.prisma.giveaway.findUnique({ where: { id: giveawayId } });
    if (!giveaway) throw notFound(ErrorCode.VALIDATION_FAILED, 'No such giveaway');

    const now = new Date();
    if (giveaway.status !== 'OPEN' || giveaway.drawsAt <= now) {
      throw badRequest(ErrorCode.GIVEAWAY_CLOSED, 'This giveaway is not open for entries');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isBanned: true, banReason: true },
    });
    if (!user) throw notFound(ErrorCode.ACCOUNT_BANNED, 'User not found');
    if (user.isBanned) {
      throw forbidden(ErrorCode.ACCOUNT_BANNED, user.banReason ?? 'Account is banned');
    }

    const deposited = await this.depositedSince(userId, giveaway.opensAt);
    if (deposited < giveaway.minDeposit) {
      throw badRequest(
        ErrorCode.GIVEAWAY_DEPOSIT_REQUIRED,
        `This giveaway needs ${(giveaway.minDeposit / 100).toFixed(2)} topped up since it ` +
          `opened; you have ${(deposited / 100).toFixed(2)}`,
      );
    }

    try {
      await this.prisma.giveawayEntry.create({ data: { giveawayId, userId } });
    } catch (err) {
      // P2002: the unique index refused a second entry, which is the intended
      // outcome rather than an error worth a stack trace.
      if ((err as { code?: string }).code === 'P2002') {
        throw badRequest(ErrorCode.GIVEAWAY_ALREADY_ENTERED, 'You are already entered');
      }
      throw err;
    }

    return {
      giveawayId,
      deposited,
      entered: true,
      canEnter: false,
    };
  }

  /**
   * Opens what is due to open and draws what is due to be drawn.
   *
   * One sweep rather than two, because the two states are the same clock.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    const now = new Date();

    const opened = await this.prisma.giveaway.updateMany({
      where: { status: 'SCHEDULED', opensAt: { lte: now }, drawsAt: { gt: now } },
      data: { status: 'OPEN' },
    });
    if (opened.count > 0) this.logger.log(`${opened.count} giveaway(s) opened`);

    const due = await this.prisma.giveaway.findMany({
      where: { status: { in: ['SCHEDULED', 'OPEN'] }, drawsAt: { lte: now } },
      select: { id: true },
    });
    for (const { id } of due) {
      try {
        await this.draw(id);
      } catch (err) {
        // One giveaway that cannot be drawn must not hold up the rest; it stays
        // due and the next sweep tries again.
        this.logger.error(`Drawing giveaway ${id}: ${String(err)}`);
      }
    }
  }

  /**
   * Picks the winner and hands over the prize.
   *
   * The whole thing is one transaction claimed by a conditional update, so two
   * overlapping sweeps cannot draw the same giveaway twice — which would mean
   * two winners for one knife.
   */
  async draw(giveawayId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.giveaway.updateMany({
        where: { id: giveawayId, status: { in: ['SCHEDULED', 'OPEN'] } },
        data: { status: 'DRAWN', drawnAt: new Date() },
      });
      if (claimed.count === 0) return;

      const giveaway = await tx.giveaway.findUniqueOrThrow({
        where: { id: giveawayId },
        include: { item: true },
      });

      const entries = await tx.giveawayEntry.findMany({
        where: { giveawayId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, userId: true },
      });

      if (entries.length === 0) {
        // Nobody entered. Drawn with no winner rather than left open for ever:
        // the deadline passed, and a promotion that quietly never ends is worse
        // than one that visibly found no takers.
        this.logger.warn(`Giveaway ${giveawayId} drew with no entrants`);
        return;
      }

      // The entrant list, in the order it is published. Deriving the client
      // seed from it is what makes the draw depend on who entered rather than
      // on when the house chose to run it.
      const clientSeed = createHash('sha256')
        .update(entries.map((e) => e.id).join(','))
        .digest('hex');

      const roll = computeRoll(giveaway.serverSeed, clientSeed, 0);
      const winner = entries[roll % entries.length]!;

      await tx.giveaway.update({
        where: { id: giveawayId },
        data: { clientSeed, roll, winnerUserId: winner.userId },
      });

      // The prize is created at the price it is worth now, like every other
      // way an item reaches an inventory: the sell-back value is computed from
      // it, and a number frozen months ago would not be the one the player
      // could actually get for it.
      await tx.inventoryItem.create({
        data: {
          userId: winner.userId,
          itemId: giveaway.itemId,
          acquiredPrice: giveaway.item.priceOverride ?? giveaway.item.marketPrice,
        },
      });

      this.logger.log(
        `Giveaway ${giveawayId}: ${entries.length} entrant(s), roll ${roll}, ` +
          `winner ${winner.userId}`,
      );
    });
  }

  // --- operator side --------------------------------------------------------

  /**
   * Creates a giveaway, seed and all.
   *
   * The seed is generated here and never accepted from a caller: a seed an
   * operator could choose is a draw an operator could choose.
   */
  async create(input: {
    itemId: string;
    title: string;
    titleEn: string | null;
    minDeposit: number;
    opensAt: Date;
    drawsAt: Date;
  }): Promise<GiveawayView> {
    if (input.drawsAt <= input.opensAt) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'A giveaway must draw after it opens');
    }

    const item = await this.prisma.item.findUnique({ where: { id: input.itemId } });
    if (!item) throw notFound(ErrorCode.VALIDATION_FAILED, 'No such item');

    const serverSeed = generateServerSeed();
    const created = await this.prisma.giveaway.create({
      data: {
        itemId: input.itemId,
        title: input.title,
        titleEn: input.titleEn,
        minDeposit: input.minDeposit,
        opensAt: input.opensAt,
        drawsAt: input.drawsAt,
        serverSeed,
        serverSeedHash: hashServerSeed(serverSeed),
        status: input.opensAt <= new Date() ? 'OPEN' : 'SCHEDULED',
      },
      include: this.include,
    });

    return this.toView(created);
  }

  /**
   * There is deliberately no "draw now".
   *
   * The published hash stops the house changing the seed, but it cannot stop it
   * choosing a *moment*: the server holds the seed, so anybody with database
   * access could compute who would win for the entrant list as it stands and
   * then draw when the answer suits them. Binding the draw to `drawsAt` — a
   * time published with the giveaway — is what removes that choice. An operator
   * who wants it over sooner cancels it; they cannot bring the winner forward.
   */

  /** Calls one off. Only before it has been drawn — a prize given is given. */
  async cancel(giveawayId: string): Promise<void> {
    const cancelled = await this.prisma.giveaway.updateMany({
      where: { id: giveawayId, status: { in: ['SCHEDULED', 'OPEN'] } },
      data: { status: 'CANCELLED' },
    });
    if (cancelled.count === 0) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Only a giveaway that has not been drawn can be cancelled',
      );
    }
  }

  /** Every giveaway, for the operator's list. */
  async listAll(limit = 100): Promise<GiveawayView[]> {
    const rows = await this.prisma.giveaway.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: this.include,
    });
    return rows.map((row) => this.toView(row));
  }

  // --- internals ------------------------------------------------------------

  private get include() {
    return {
      item: true,
      winner: { select: { id: true, username: true, avatarUrl: true } },
      _count: { select: { entries: true } },
    } satisfies Prisma.GiveawayInclude;
  }

  private async depositedSince(userId: string, since: Date): Promise<number> {
    const sum = await this.prisma.transaction.aggregate({
      // Both channels count: money and skins are both a top-up as far as a
      // promotion for topping up is concerned.
      where: { userId, type: { in: ['DEPOSIT', 'ITEM_DEPOSIT'] }, createdAt: { gte: since } },
      _sum: { amount: true },
    });
    return Math.max(0, sum._sum.amount ?? 0);
  }

  private toView(
    row: Prisma.GiveawayGetPayload<{
      include: {
        item: true;
        winner: { select: { id: true; username: true; avatarUrl: true } };
        _count: { select: { entries: true } };
      };
    }>,
  ): GiveawayView {
    const drawn = row.status === 'DRAWN';

    return {
      id: row.id,
      status: row.status,
      title: row.title,
      titleEn: row.titleEn,
      prize: {
        itemName: row.item.name,
        imageUrl: row.item.imageUrl,
        rarity: row.item.rarity as ItemRarity,
        price: row.item.priceOverride ?? row.item.marketPrice,
      },
      minDeposit: row.minDeposit,
      opensAt: row.opensAt.toISOString(),
      drawsAt: row.drawsAt.toISOString(),
      entryCount: row._count.entries,
      serverSeedHash: row.serverSeedHash,
      // The seed is the one field whose absence is the promise. Withheld until
      // the draw, and unconditional on the status rather than on a caller's
      // role — an operator has no more business seeing it early than anybody
      // else, because the point is that nobody can.
      serverSeed: drawn ? row.serverSeed : null,
      clientSeed: drawn ? row.clientSeed : null,
      roll: drawn ? row.roll : null,
      winner: row.winner,
      drawnAt: row.drawnAt?.toISOString() ?? null,
    };
  }
}

/** Re-exported so the modulo note above has something to point at. */
export const GIVEAWAY_ROLL_SPACE = TICKET_SPACE;
