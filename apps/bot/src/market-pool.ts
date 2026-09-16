import type { MarketAccount, PrismaClient } from '@prisma/client';
import {
  MARKET_API_URL,
  MarketClient,
  type MarketAccountCandidate,
  explainNoAccount,
  fromMarketMajor,
  marketCurrencyProblem,
  pickAccount,
} from '@caseforge/shared';
import { decryptSecret } from './crypto.ts';

/**
 * The market accounts, and the reason there is more than one.
 *
 * market.csgo.com deletes an API key that goes over five requests a second.
 * That is not a throttle to back off from — it is the key ceasing to exist, and
 * with it every purchase that key could still have been asked about. So the
 * client never approaches the limit, which caps one key at about four requests
 * a second; and since a single withdrawal costs a search, a buy and then a poll
 * every few seconds until the seller delivers, one key caps the site.
 *
 * Several keys raise that ceiling because the limit is counted per key. Each
 * account therefore gets its own client with its own queue: sharing one queue
 * across keys would throttle them collectively and give back exactly the
 * ceiling the second key was bought to remove.
 *
 * The part that is easy to get wrong: accounts are not interchangeable after a
 * purchase. `get-buy-info-by-custom-id` answers for the key that made the
 * purchase and for no other, and the money came out of that account. A purchase
 * is bound to its account before the money moves, and every later question
 * about it goes back to the same one.
 */

/** How often to re-read balances and health. */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * No account could take a purchase.
 *
 * Its own type because the distinction matters to the caller: nothing was
 * charged, so this is a definite refusal the player can be told about, not the
 * "we may or may not have paid" case that has to be left alone for the poller.
 */
export class NoMarketAccountError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'NoMarketAccountError';
  }
}

export interface PooledAccount {
  record: MarketAccount;
  client: MarketClient;
}

export class MarketPool {
  private readonly prisma: PrismaClient;
  private readonly baseUrl: string;

  private readonly clients = new Map<string, MarketClient>();
  private accounts: MarketAccount[] = [];

  /**
   * When each account last had a request sent to it, in this process.
   *
   * Kept in memory rather than in the database because it changes several times
   * a second and is only ever used to answer "whose turn is it" — a column
   * would be a write per request for a value nobody reads afterwards.
   */
  private readonly lastUsedAt = new Map<string, number>();

  private refreshedAt = 0;

  constructor(prisma: PrismaClient, baseUrl: string = MARKET_API_URL) {
    this.prisma = prisma;
    this.baseUrl = baseUrl;
  }

  get size(): number {
    return this.accounts.filter((a) => a.status !== 'DISABLED').length;
  }

  get onlineCount(): number {
    return this.accounts.filter((a) => a.status === 'ONLINE').length;
  }

  /** Loads the accounts and checks each one. Safe to call again at any time. */
  async start(): Promise<void> {
    await this.reload();
    await this.refresh(true);
  }

  /**
   * Re-reads the account list.
   *
   * Clients are kept across reloads: a client owns the in-flight queue that
   * enforces the rate limit, and replacing it would let the new one fire
   * immediately while the old one's requests were still going out — which is
   * precisely the burst that costs a key.
   */
  async reload(): Promise<void> {
    this.accounts = await this.prisma.marketAccount.findMany({ orderBy: { createdAt: 'asc' } });

    for (const account of this.accounts) {
      if (this.clients.has(account.id)) continue;
      try {
        this.clients.set(
          account.id,
          new MarketClient({
            apiKey: decryptSecret(account.encryptedApiKey),
            baseUrl: this.baseUrl,
          }),
        );
      } catch (err) {
        await this.markError(account.id, `Could not decrypt the API key: ${String(err)}`);
      }
    }

    for (const id of [...this.clients.keys()]) {
      if (!this.accounts.some((a) => a.id === id)) this.clients.delete(id);
    }
  }

  /**
   * Re-reads balance and health for every account that is in rotation.
   *
   * Two requests per account, so it is on a timer rather than per purchase: at
   * one refresh a minute a pool of ten accounts spends twenty requests, which
   * is nothing against the limit, while checking before each purchase would
   * spend more on asking than on buying.
   */
  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.refreshedAt < REFRESH_INTERVAL_MS) return;
    this.refreshedAt = Date.now();

    for (const account of this.accounts) {
      if (account.status === 'DISABLED') continue;
      const client = this.clients.get(account.id);
      if (!client) continue;

      try {
        const [money, test] = await Promise.all([client.getMoney(), client.test()]);
        const currency = money.currency ?? null;
        const problem = marketCurrencyProblem(currency);

        await this.update(account.id, {
          // A wrong currency is not a transient fault — it is an account that
          // can never be used here — so it lands as ERROR rather than ONLINE
          // with a warning nobody reads.
          status: problem ? 'ERROR' : 'ONLINE',
          balance: money.money === undefined ? null : fromMarketMajor(money.money),
          currency,
          checks: (test.status ?? {}) as object,
          lastCheckedAt: new Date(),
          lastError: problem,
        });
      } catch (err) {
        await this.markError(account.id, err instanceof Error ? err.message : String(err));
      }
    }
  }

  /**
   * Reserves an account for a purchase of this price.
   *
   * The balance is debited locally at the same moment. The snapshot is up to a
   * minute old, so without it a burst of withdrawals would all look at the same
   * healthy balance and all pick the same account, and the later ones would be
   * refused for want of money that the earlier ones had already spent.
   */
  claim(price: number): PooledAccount | null {
    const chosen = pickAccount(this.candidates(), price);
    if (!chosen) return null;

    const record = this.accounts.find((a) => a.id === chosen.id);
    const client = this.clients.get(chosen.id);
    if (!record || !client) return null;

    this.lastUsedAt.set(chosen.id, Date.now());
    if (record.balance !== null) record.balance -= price;

    return { record, client };
  }

  /** Why `claim` came back empty, in words an operator can act on. */
  explain(price: number): string {
    return explainNoAccount(this.candidates(), price);
  }

  /** The client that made a purchase — the only one that can ask about it. */
  clientFor(accountId: string): MarketClient | undefined {
    return this.clients.get(accountId);
  }

  /** Records that an account was used, so the request counter stays honest. */
  async noteUsed(accountId: string): Promise<void> {
    this.lastUsedAt.set(accountId, Date.now());
    await this.prisma.marketAccount
      .update({ where: { id: accountId }, data: { requestCount: { increment: 1 } } })
      .catch(() => undefined);
  }

  async markError(accountId: string, reason: string): Promise<void> {
    await this.update(accountId, { status: 'ERROR', lastError: reason, lastCheckedAt: new Date() });
    console.error(`[market] account ${accountId}: ${reason}`);
  }

  private candidates(): MarketAccountCandidate[] {
    return this.accounts.map((a) => ({
      id: a.id,
      status: a.status,
      balance: a.balance,
      currency: a.currency,
      lastUsedAt: this.lastUsedAt.get(a.id) ?? 0,
    }));
  }

  private async update(accountId: string, data: Record<string, unknown>): Promise<void> {
    const updated = await this.prisma.marketAccount
      .update({ where: { id: accountId }, data: data as never })
      .catch(() => null);
    if (!updated) return;

    const index = this.accounts.findIndex((a) => a.id === accountId);
    if (index >= 0) this.accounts[index] = updated;
  }
}
