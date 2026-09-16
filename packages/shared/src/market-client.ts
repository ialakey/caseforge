import {
  MARKET_API_URL,
  MARKET_MIN_REQUEST_INTERVAL_MS,
  type MarketBuyInfo,
  type MarketMoneyResponse,
  type MarketOffer,
  type MarketTestResponse,
  marketBuyListSchema,
  marketBuySchema,
  marketMoneySchema,
  marketSearchSchema,
  marketTestSchema,
} from './market.ts';

/**
 * The market.csgo.com HTTP client.
 *
 * Deliberately one class shared by the API and the worker. The worker spends
 * the money and the back office reports on it, and two clients would be two
 * sets of assumptions about units, throttling and what counts as an error —
 * which is exactly the kind of drift that shows up as a wrong price.
 *
 * Nothing here retries. A failed read can be repeated by the caller for free;
 * a repeated `buy-for` is a second skin bought with real money, and only the
 * caller knows whether it already holds one. See `MarketClient.buyFor`.
 */

export class MarketError extends Error {
  constructor(
    message: string,
    readonly method: string,
    /** The market's own error string, when it sent one. */
    readonly marketError: string | null = null,
  ) {
    super(message);
    this.name = 'MarketError';
  }
}

export interface MarketClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface BuyForParams {
  hashName: string;
  /** Ceiling in market price units — the market never pays above it. */
  price: number;
  /** Recipient, taken from the player's trade link. */
  partner: string;
  token: string;
  /** Our own id for the purchase, and the only way to ask about it later. */
  customId: string;
  /** Refuse sellers whose delivery rate is below this percentage. */
  minChance?: number;
}

export class MarketClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  /**
   * The throttle. Requests are chained rather than counted: a token bucket
   * would let five calls leave in the same millisecond, and the documented
   * penalty for exceeding the rate is not a 429 but the key being deleted.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private lastCallAt = 0;

  constructor(options: MarketClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? MARKET_API_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  get isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /** Whether the account is in a state where it can actually buy and deliver. */
  async test(): Promise<MarketTestResponse> {
    return this.call('test', {}, marketTestSchema);
  }

  /**
   * The account balance.
   *
   * Reported as a float in whole currency units, unlike prices. It is shown in
   * the back office and used to warn, never to decide: the market's own
   * refusal is the authority on whether a purchase is affordable, and a
   * balance check that is wrong about units would block withdrawals that would
   * have gone through perfectly well.
   */
  async getMoney(): Promise<MarketMoneyResponse> {
    return this.call('get-money', {}, marketMoneySchema);
  }

  /** Live offers for one skin, cheapest first is not guaranteed — see pickOffer. */
  async searchByHashName(
    hashName: string,
  ): Promise<{ offers: MarketOffer[]; currency: string | null }> {
    const response = await this.call(
      'search-item-by-hash-name',
      { hash_name: hashName },
      marketSearchSchema,
    );
    return {
      offers: (response.data ?? []).map((entry) => ({
        price: entry.price,
        // A missing count means the listing exists; only an explicit zero is
        // the market saying it has already gone.
        count: entry.count ?? 1,
        class: entry.class ?? null,
        instance: entry.instance ?? null,
      })),
      currency: response.currency ?? null,
    };
  }

  /**
   * Buys one item and has it delivered to the player.
   *
   * `customId` is the caller's idempotency key, and the reason this method is
   * safe to build a retrying worker on: if the request dies between the market
   * charging the account and us reading the reply, the purchase is still
   * findable by that id. A caller that retries without checking
   * `buyInfoByCustomId` first buys the skin twice and pays for both.
   */
  async buyFor(params: BuyForParams): Promise<{ marketId: string }> {
    const response = await this.call(
      'buy-for',
      {
        hash_name: params.hashName,
        price: String(params.price),
        partner: params.partner,
        token: params.token,
        custom_id: params.customId,
        ...(params.minChance === undefined ? {} : { chance_to_transfer: String(params.minChance) }),
      },
      marketBuySchema,
    );
    if (!response.id) {
      throw new MarketError('The market accepted the purchase but returned no id', 'buy-for');
    }
    return { marketId: response.id };
  }

  /**
   * The state of purchases we started, looked up by our own ids.
   *
   * Batched because polling is the only way to learn that a seller has
   * delivered — the market sends no webhook — and one request per open
   * purchase would eat the rate limit long before it ate the latency budget.
   */
  async buyInfoByCustomId(customIds: string[]): Promise<Map<string, MarketBuyInfo>> {
    if (customIds.length === 0) return new Map();

    const response = await this.call(
      'get-list-buy-info-by-custom-id',
      { 'custom_id[]': customIds },
      marketBuyListSchema,
    );
    return new Map(Object.entries(response.data ?? {}));
  }

  /**
   * One request, behind the throttle.
   *
   * `success: false` is folded into a thrown MarketError so that a caller
   * cannot accidentally read a failed response as an empty one — the shape of
   * a refusal and the shape of "no offers" are otherwise almost identical.
   */
  private async call<T>(
    method: string,
    params: Record<string, string | string[]>,
    schema: { parse: (input: unknown) => T },
  ): Promise<T> {
    if (!this.isConfigured) {
      throw new MarketError('The market account has no API key', method);
    }

    return this.enqueue(async () => {
      const url = new URL(`${this.baseUrl}/${method}`);
      url.searchParams.set('key', this.apiKey);
      for (const [name, value] of Object.entries(params)) {
        if (Array.isArray(value)) for (const v of value) url.searchParams.append(name, v);
        else url.searchParams.set(name, value);
      }

      let response: Response;
      try {
        response = await fetch(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        throw new MarketError(
          `${method}: ${err instanceof Error ? err.message : String(err)}`,
          method,
        );
      }

      if (!response.ok) {
        throw new MarketError(`${method}: the market returned ${response.status}`, method);
      }

      const payload: unknown = await response.json().catch(() => null);
      if (payload === null) {
        throw new MarketError(`${method}: the market returned something that is not JSON`, method);
      }

      const envelope = payload as { success?: unknown; error?: unknown };
      if (envelope.success === false || envelope.success === 'false') {
        const detail = typeof envelope.error === 'string' ? envelope.error : 'no reason given';
        throw new MarketError(`${method}: ${detail}`, method, detail);
      }

      return schema.parse(payload);
    });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const wait = this.lastCallAt + MARKET_MIN_REQUEST_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastCallAt = Date.now();
      return work();
    });
    // The chain must survive a rejected call, or one failure stops every
    // request that comes after it.
    this.queue = result.catch(() => undefined);
    return result;
  }
}
