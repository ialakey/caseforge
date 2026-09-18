import type { PrismaClient, SteamBot } from '@prisma/client';
import { SteamBotClient } from './steam-bot.ts';

/**
 * The bot farm.
 *
 * A request cannot go to "any free" bot: the items physically sit in one
 * specific account's inventory. The pool answers the question "who exactly can
 * hand out this particular set of items right now".
 */
export class BotPool {
  private readonly clients = new Map<string, SteamBotClient>();
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  get size(): number {
    return this.clients.size;
  }

  /** Signs in every enabled bot. One failed login does not take down the rest. */
  async start(): Promise<void> {
    const bots = await this.prisma.steamBot.findMany({
      where: { status: { not: 'DISABLED' } },
    });

    for (const bot of bots) {
      await this.login(bot);
    }
  }

  private async login(bot: SteamBot): Promise<void> {
    try {
      const client = new SteamBotClient(bot);
      await client.login();
      this.clients.set(bot.id, client);

      await this.syncInventory(bot.id);
      await this.prisma.steamBot.update({
        where: { id: bot.id },
        data: { status: 'ONLINE', lastOnlineAt: new Date(), lastError: null },
      });
      console.log(`[bot] ${bot.username} online`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.steamBot.update({
        where: { id: bot.id },
        data: { status: 'ERROR', lastError: message },
      });
      console.error(`[bot] ${bot.username}: login failed — ${message}`);
    }
  }

  /**
   * Brings the database mirror of the inventory in line with the real Steam one.
   *
   * The mirror exists so a bot can be chosen for a request without hitting
   * Steam every time, but Steam is always the truth: assetId changes on every
   * transfer, so the list is rewritten wholesale.
   */
  async syncInventory(botId: string): Promise<void> {
    const client = this.clients.get(botId);
    if (!client) return;

    const contents = await client.loadInventory();

    const items = await this.prisma.item.findMany({
      where: { marketHashName: { in: contents.map((c) => c.marketHashName) } },
      select: { id: true, marketHashName: true },
    });
    const itemIdByName = new Map(items.map((i) => [i.marketHashName, i.id]));

    await this.prisma.$transaction(async (tx) => {
      await tx.botInventoryItem.deleteMany({ where: { botId } });
      await tx.botInventoryItem.createMany({
        data: contents
          .filter((c) => itemIdByName.has(c.marketHashName))
          .map((c) => ({
            botId,
            itemId: itemIdByName.get(c.marketHashName)!,
            assetId: c.assetId,
          })),
      });
      await tx.steamBot.update({
        where: { id: botId },
        data: { currentItems: contents.length },
      });
    });
  }

  /**
   * Finds a bot holding ALL the required items — one offer beats several: the
   * player confirms once, and a partial refusal cannot leave the request
   * half-finished.
   */
  async findBotFor(itemIds: string[]): Promise<{ bot: SteamBotClient; assetIds: string[] } | null> {
    for (const [botId, client] of this.clients) {
      if (!client.isReady) continue;

      const assetIds: string[] = [];
      const taken = new Set<string>();
      let complete = true;

      for (const itemId of itemIds) {
        const candidate = await this.prisma.botInventoryItem.findFirst({
          where: { botId, itemId, isReserved: false, id: { notIn: [...taken] } },
        });
        if (!candidate) {
          complete = false;
          break;
        }
        taken.add(candidate.id);
        assetIds.push(candidate.assetId);
      }

      if (complete) return { bot: client, assetIds };
    }
    return null;
  }

  /**
   * A bot with room to receive `count` more items.
   *
   * Capacity is the whole question for an incoming trade: a Steam inventory
   * holds a thousand slots, and an offer sent to a full bot is one Steam
   * refuses after the player has already agreed to it — the worst moment to
   * find out. The counts come from the database rather than a live inventory
   * read, so they are as fresh as the last mirror; the headroom in `maxItems`
   * is what absorbs that lag.
   */
  async withCapacity(count: number): Promise<SteamBotClient | null> {
    const records = await this.prisma.steamBot.findMany({
      where: { status: 'ONLINE' },
      orderBy: { currentItems: 'asc' },
      select: { id: true, currentItems: true, maxItems: true },
    });

    for (const record of records) {
      if (record.currentItems + count > record.maxItems) continue;
      const client = this.clients.get(record.id);
      if (client?.isReady) return client;
    }
    return null;
  }

  get(botId: string): SteamBotClient | undefined {
    return this.clients.get(botId);
  }

  stop(): void {
    for (const client of this.clients.values()) client.logout();
    this.clients.clear();
  }
}
