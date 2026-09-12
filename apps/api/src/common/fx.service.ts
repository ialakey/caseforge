import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import Redis from 'ioredis';
import { BASE_CURRENCY, DISPLAY_CURRENCIES, type FxRates } from '@caseforge/shared';
import { REDIS_CLIENT } from './redis.module';

const CACHE_KEY = 'fx:rates';
const CACHE_TTL_SEC = 24 * 60 * 60;

/**
 * The Central Bank of Russia publishes an official daily rate as plain JSON,
 * without a key or a quota. Since settlement happens in roubles, its rate is
 * the natural reference — and one fewer third-party dependency to sign up for.
 */
const CBR_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';

/**
 * Fallback used when the rate has never been fetched.
 *
 * A rough constant is deliberately better than showing nothing: with no rate
 * at all the interface would fall back to roubles while the currency switch
 * says dollars, which reads as a broken page rather than as stale data.
 */
const FALLBACK_USD_RATE = 90;

/**
 * Exchange rates for displaying prices.
 *
 * Conversion is presentation only. Balances, item prices and case prices stay
 * in the settlement currency; nothing is re-priced and no ledger entry ever
 * holds a converted amount. Treating a display rate as a settlement rate is
 * how a site ends up selling items below cost after a currency move.
 */
@Injectable()
export class FxService implements OnModuleInit {
  private readonly logger = new Logger(FxService.name);

  /** In-process copy so a price lookup never waits on Redis. */
  private rates: FxRates = { [BASE_CURRENCY]: 1, USD: FALLBACK_USD_RATE };

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleInit(): Promise<void> {
    const cached = await this.redis.get(CACHE_KEY).catch(() => null);
    if (cached) {
      try {
        this.rates = { ...this.rates, ...(JSON.parse(cached) as FxRates) };
      } catch {
        this.logger.warn('Cached FX rates are unreadable, refreshing');
      }
    }
    // Do not block startup on a third-party request.
    void this.refresh();
  }

  /** Current rates: how many base-currency units one display unit costs. */
  getRates(): FxRates {
    return { ...this.rates, [BASE_CURRENCY]: 1 };
  }

  @Cron(CronExpression.EVERY_6_HOURS)
  async refresh(): Promise<FxRates> {
    try {
      const response = await fetch(CBR_URL, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`CBR returned ${response.status}`);

      const payload = (await response.json()) as {
        Valute?: Record<string, { Value?: number; Nominal?: number }>;
      };

      const next: FxRates = { [BASE_CURRENCY]: 1 };
      for (const currency of DISPLAY_CURRENCIES) {
        if (currency === BASE_CURRENCY) continue;
        const quote = payload.Valute?.[currency];
        if (!quote?.Value || !Number.isFinite(quote.Value)) continue;
        // CBR quotes a nominal (some currencies are priced per 10 or per 100).
        next[currency] = quote.Value / (quote.Nominal || 1);
      }

      this.rates = { ...this.rates, ...next };
      await this.redis.set(CACHE_KEY, JSON.stringify(this.rates), 'EX', CACHE_TTL_SEC);
      this.logger.log(`FX rates updated: ${JSON.stringify(this.rates)}`);
    } catch (err) {
      // Keep serving the previous rate: a stale rate beats a broken price list.
      this.logger.warn(`Could not refresh FX rates, keeping the previous ones: ${String(err)}`);
    }
    return this.getRates();
  }
}
