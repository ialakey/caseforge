'use client';

import { useCallback, useEffect, useState } from 'react';
import type { TranslationKey } from '@caseforge/shared';
import { api, ApiError } from '../../../lib/api';
import { useSettings } from '../../../lib/settings';
import { Money } from '../../../components/Money';

interface AccountRow {
  id: string;
  label: string;
  status: string;
  balance: number | null;
  currency: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  requestCount: number;
  problem: string | null;
  checks: {
    userToken: boolean | null;
    tradeCheck: boolean | null;
    siteOnline: boolean | null;
    noTempBan: boolean | null;
    steamApiKey: boolean | null;
  };
}

interface PurchaseRow {
  id: string;
  marketHashName: string;
  status: string;
  maxPrice: number;
  paidPrice: number | null;
  stage: number | null;
  tradeOfferId: string | null;
  failureReason: string | null;
  createdAt: string;
  boughtAt: string | null;
  deliveredAt: string | null;
  account: { id: string; label: string } | null;
  withdrawal: {
    id: string;
    status?: string;
    user: { username: string; steamId64: string };
  };
}

interface Overview {
  accounts: AccountRow[];
  spendable: number;
  stuckAfterMin: number;
  counts: Record<string, number>;
  delivered: { count: number; paid: number; authorised: number };
  stuck: PurchaseRow[];
}

const PURCHASE_TONE: Record<string, string> = {
  PENDING: 'text-ink-faint',
  BOUGHT: 'text-accent',
  DELIVERED: 'text-positive',
  FAILED: 'text-negative',
};

/** Colour per account status, so a pool of ten reads at a glance. */
const ACCOUNT_TONE: Record<string, string> = {
  ONLINE: 'text-positive',
  OFFLINE: 'text-ink-faint',
  DISABLED: 'text-ink-faint',
  ERROR: 'text-negative',
};

const CHECK_LABELS: Array<[keyof AccountRow['checks'], TranslationKey]> = [
  ['siteOnline', 'admin.market.checkOnline'],
  ['userToken', 'admin.market.checkTradeLink'],
  ['tradeCheck', 'admin.market.checkTrades'],
  ['noTempBan', 'admin.market.checkNoBan'],
  ['steamApiKey', 'admin.market.checkSteamKey'],
];

/**
 * The market channel.
 *
 * Read-mostly, and deliberately so. The only thing an operator changes here is
 * whether an account is in rotation; there is no button to retry a purchase,
 * refund one, or declare an account healthy. All three spend or assert real
 * money, and the worker is the one process that should — a panel that could buy
 * would be a second author of the same bank balance.
 *
 * Everything shown about an account is a snapshot the worker wrote. The API
 * holds no market key at all, which is why a status here can be a minute old.
 */
export default function AdminMarketPage() {
  const { t } = useSettings();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [recent, setRecent] = useState<PurchaseRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [summary, purchases] = await Promise.all([
        api<Overview>('/api/admin/market'),
        api<{ items: PurchaseRow[] }>('/api/admin/market/purchases?perPage=25'),
      ]);
      setOverview(summary);
      setRecent(purchases.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('admin.market.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setStatus(id: string, status: 'DISABLED' | 'OFFLINE'): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await api(`/api/admin/market/accounts/${id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('admin.market.statusFailed'));
    } finally {
      setBusyId(null);
    }
  }

  if (!overview) return <p className="text-ink-muted">{error ?? t('admin.loading')}</p>;

  const { accounts, counts, delivered, stuck } = overview;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('admin.market.title')}</h1>

      {error && (
        <p className="rounded-lg bg-negative/15 px-3 py-2 text-sm text-negative">{error}</p>
      )}

      <section className="cf-panel overflow-hidden">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-edge-subtle px-5 py-4">
          <h2 className="font-medium">
            {t('admin.market.accounts')}{' '}
            <span className="text-ink-faint">
              {accounts.filter((a) => a.status === 'ONLINE').length}/{accounts.length}
            </span>
          </h2>
          <div className="text-sm">
            <span className="text-xs uppercase tracking-wide text-ink-faint">
              {t('admin.market.spendable')}{' '}
            </span>
            <Money value={overview.spendable} className="font-semibold text-accent" />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-overlay/60 text-xs uppercase tracking-wide text-ink-faint">
              <tr>
                <th className="px-5 py-2.5">{t('admin.market.colAccount')}</th>
                <th className="px-3 py-2.5">{t('admin.market.colStatus')}</th>
                <th className="px-3 py-2.5">{t('admin.market.colBalance')}</th>
                <th className="px-3 py-2.5">{t('admin.market.colChecks')}</th>
                <th className="px-3 py-2.5">{t('admin.market.colRequests')}</th>
                <th className="px-3 py-2.5">{t('admin.market.colChecked')}</th>
                <th className="px-3 py-2.5">{t('admin.market.colWhy')}</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id} className="border-t border-edge-subtle/60">
                  <td className="px-5 py-2.5">{account.label}</td>
                  <td
                    className={`px-3 py-2.5 font-medium ${ACCOUNT_TONE[account.status] ?? 'text-ink-muted'}`}
                  >
                    {account.status}
                  </td>
                  <td className="px-3 py-2.5">
                    {account.balance === null ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      <Money value={account.balance} className="text-accent" />
                    )}
                    {account.currency && (
                      <span className="ml-1 text-xs text-ink-faint">{account.currency}</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {CHECK_LABELS.map(([key, label]) => {
                        const value = account.checks[key];
                        return (
                          <span
                            key={key}
                            title={t(label)}
                            className={`rounded px-1.5 py-0.5 text-[10px] ${
                              value === null
                                ? 'bg-surface-overlay text-ink-faint'
                                : value
                                  ? 'bg-positive/15 text-positive'
                                  : 'bg-negative/15 text-negative'
                            }`}
                          >
                            {t(label).slice(0, 2)}
                          </span>
                        );
                      })}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-ink-muted">{account.requestCount}</td>
                  <td className="px-3 py-2.5 text-xs text-ink-muted">
                    {account.lastCheckedAt
                      ? account.lastCheckedAt.replace('T', ' ').slice(0, 16)
                      : t('admin.market.neverChecked')}
                  </td>
                  <td className="max-w-[220px] truncate px-3 py-2.5 text-xs text-negative">
                    {account.problem ?? account.lastError ?? ''}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {account.status === 'DISABLED' ? (
                      <button
                        onClick={() => void setStatus(account.id, 'OFFLINE')}
                        disabled={busyId === account.id}
                        className="text-xs text-ink-faint hover:text-positive"
                      >
                        {t('admin.enable')}
                      </button>
                    ) : (
                      <button
                        onClick={() => void setStatus(account.id, 'DISABLED')}
                        disabled={busyId === account.id}
                        className="text-xs text-ink-faint hover:text-negative"
                      >
                        {t('admin.disable')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {accounts.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-6 text-center text-ink-faint">
                    {t('admin.market.accountsEmpty')}{' '}
                    <code className="text-ink-muted">
                      pnpm --filter @caseforge/bot add-market-account
                    </code>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="border-t border-edge-subtle px-5 py-3 text-xs text-ink-muted">
          {t('admin.market.accountsHint')} {t('admin.market.spendableHint')}
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-4">
        {(['PENDING', 'BOUGHT', 'DELIVERED', 'FAILED'] as const).map((status) => (
          <div key={status} className="cf-panel p-4">
            <div className="text-xs uppercase tracking-wide text-ink-faint">{status}</div>
            <div className={`text-2xl font-semibold ${PURCHASE_TONE[status]}`}>
              {counts[status] ?? 0}
            </div>
          </div>
        ))}
      </section>

      <section className="cf-panel p-5">
        <h2 className="mb-3 font-medium">{t('admin.market.cost')}</h2>
        <div className="grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-ink-faint">
              {t('admin.market.itemsDelivered')}
            </div>
            <div className="text-lg font-semibold">{delivered.count}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-ink-faint">
              {t('admin.market.paidToSellers')}
            </div>
            <Money value={delivered.paid} className="text-lg font-semibold text-accent" />
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-ink-faint">
              {t('admin.market.ceilingAuthorised')}
            </div>
            <Money value={delivered.authorised} className="text-lg font-semibold text-ink-muted" />
          </div>
        </div>
        <p className="mt-3 text-xs text-ink-muted">{t('admin.market.costHint')}</p>
      </section>

      {stuck.length > 0 && (
        <section className="cf-panel overflow-hidden border-negative/40">
          <h2 className="border-b border-edge-subtle px-5 py-4 font-medium text-negative">
            {t('admin.market.stuckTitle', { minutes: overview.stuckAfterMin })}
            <span className="ml-2 text-ink-faint">{stuck.length}</span>
          </h2>
          <PurchaseTable rows={stuck} />
          <p className="px-5 py-3 text-xs text-ink-muted">{t('admin.market.stuckHint')}</p>
        </section>
      )}

      <section className="cf-panel overflow-hidden">
        <h2 className="border-b border-edge-subtle px-5 py-4 font-medium">
          {t('admin.market.recent')}
        </h2>
        <PurchaseTable rows={recent} />
      </section>
    </div>
  );
}

function PurchaseTable({ rows }: { rows: PurchaseRow[] }) {
  const { t } = useSettings();

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="bg-surface-overlay/60 text-xs uppercase tracking-wide text-ink-faint">
          <tr>
            <th className="px-5 py-2.5">{t('admin.market.colItem')}</th>
            <th className="px-3 py-2.5">{t('admin.market.colPlayer')}</th>
            <th className="px-3 py-2.5">{t('admin.market.colStatus')}</th>
            <th className="px-3 py-2.5">{t('admin.market.colPurchaseAccount')}</th>
            <th className="px-3 py-2.5">{t('admin.market.colPaid')}</th>
            <th className="px-3 py-2.5">{t('admin.market.colTrade')}</th>
            <th className="px-3 py-2.5">{t('admin.market.colBought')}</th>
            <th className="px-3 py-2.5">{t('admin.market.colWhy')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} className="border-t border-edge-subtle/60">
              <td className="max-w-[220px] truncate px-5 py-2.5" title={p.marketHashName}>
                {p.marketHashName}
              </td>
              <td className="px-3 py-2.5 text-ink-muted">{p.withdrawal.user.username}</td>
              <td
                className={`px-3 py-2.5 font-medium ${PURCHASE_TONE[p.status] ?? 'text-ink-muted'}`}
              >
                {p.status}
                {p.stage !== null && <span className="ml-1 text-ink-faint">#{p.stage}</span>}
              </td>
              {/* Which key paid, and therefore the only one that can be asked
                  about this purchase or chased through the market's support. */}
              <td className="px-3 py-2.5 text-ink-muted">{p.account?.label ?? '—'}</td>
              <td className="px-3 py-2.5 text-ink-muted">
                {p.paidPrice === null ? '—' : <Money value={p.paidPrice} />}
                <span className="text-ink-faint"> / </span>
                <Money value={p.maxPrice} className="text-ink-faint" />
              </td>
              <td className="px-3 py-2.5 font-mono text-xs text-ink-muted">
                {p.tradeOfferId ?? '—'}
              </td>
              <td className="px-3 py-2.5 text-ink-muted">
                {p.boughtAt ? p.boughtAt.replace('T', ' ').slice(0, 16) : '—'}
              </td>
              <td className="max-w-[240px] truncate px-3 py-2.5 text-xs text-negative">
                {p.failureReason ?? ''}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={8} className="px-5 py-6 text-center text-ink-faint">
                {t('admin.market.empty')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
