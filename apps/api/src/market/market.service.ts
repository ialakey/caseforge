import { Injectable } from '@nestjs/common';
import { marketCurrencyProblem, type Minor } from '@caseforge/shared';
import { PrismaService } from '../common/prisma.service';

/**
 * The market accounts, as the back office sees them.
 *
 * The API never holds a key and never calls the market. That is not squeamish-
 * ness about an extra dependency: keys are encrypted under BOT_SECRETS_KEY and
 * decrypted in the worker alone, and the worker is also the one process allowed
 * to spend money — keeping both in one place is what makes "did we pay for this
 * twice" a question with a single place to look.
 *
 * So the panel reads what the worker last wrote: balance, currency, health
 * flags, when it was checked. Exactly the arrangement the Steam bot farm uses,
 * and the reason a status here can be a minute stale rather than live.
 */
export interface MarketAccountView {
  id: string;
  label: string;
  status: string;
  balance: Minor | null;
  currency: string | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
  requestCount: number;
  /** Set when the account cannot be used at all, whatever its status says. */
  problem: string | null;
  checks: {
    userToken: boolean | null;
    tradeCheck: boolean | null;
    siteOnline: boolean | null;
    noTempBan: boolean | null;
    steamApiKey: boolean | null;
  };
}

/** Flags as the market's `/test` sends them, before we rename anything. */
interface RawChecks {
  user_token?: boolean;
  trade_check?: boolean;
  site_online?: boolean;
  site_notmpban?: boolean;
  steam_web_api_key?: boolean;
}

@Injectable()
export class MarketService {
  constructor(private readonly prisma: PrismaService) {}

  async accounts(): Promise<MarketAccountView[]> {
    const rows = await this.prisma.marketAccount.findMany({ orderBy: { createdAt: 'asc' } });

    return rows.map((row) => {
      const checks = (row.checks ?? {}) as RawChecks;
      return {
        id: row.id,
        label: row.label,
        status: row.status,
        balance: row.balance,
        currency: row.currency,
        lastCheckedAt: row.lastCheckedAt,
        lastError: row.lastError,
        requestCount: row.requestCount,
        // Recomputed here rather than trusted from the row: an account whose
        // currency changed under the site should read as unusable the moment
        // the panel is opened, not after the worker next looks at it.
        problem: row.currency === null ? null : marketCurrencyProblem(row.currency),
        checks: {
          userToken: checks.user_token ?? null,
          tradeCheck: checks.trade_check ?? null,
          siteOnline: checks.site_online ?? null,
          noTempBan: checks.site_notmpban ?? null,
          steamApiKey: checks.steam_web_api_key ?? null,
        },
      };
    });
  }

  /** Total spendable balance across the accounts that can actually buy. */
  async spendableBalance(): Promise<Minor> {
    const rows = await this.prisma.marketAccount.findMany({
      where: { status: 'ONLINE' },
      select: { balance: true, currency: true },
    });
    return rows
      .filter((r) => !marketCurrencyProblem(r.currency))
      .reduce((sum, r) => sum + (r.balance ?? 0), 0);
  }
}
