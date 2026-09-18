'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, downloadFile } from '../../../lib/api';
import { useSettings } from '../../../lib/settings';
import { Money } from '../../../components/Money';

interface PaymentRow {
  id: string;
  status: string;
  provider: string;
  amount: number;
  bonus: number;
  createdAt: string;
  completedAt: string | null;
  user: { username: string; steamId64: string };
}

interface DepositRow {
  id: string;
  status: string;
  totalValue: number;
  rateBps: number;
  tradeOfferId: string | null;
  failureReason: string | null;
  createdAt: string;
  user: { username: string; steamId64: string };
  items: Array<{ marketHashName: string; marketPrice: number; payout: number }>;
  bot: { username: string } | null;
}

type Tab = 'payments' | 'deposits';

/**
 * Where the money came in.
 *
 * Two channels that a single ledger line cannot describe together: cards and
 * skins have different margins, different risks and different failure modes.
 * They share a page because an operator's question spans both — "did today's
 * money arrive" — and separate tabs because the answer looks different.
 *
 * The count of deposits awaiting credit is the number worth watching. A row
 * stuck there means a bot took somebody's skins and nobody has paid for them,
 * which is the one state on this page that is actively somebody's problem.
 */
export default function AdminFinancePage() {
  const { locale, t } = useSettings();
  const [tab, setTab] = useState<Tab>('payments');
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [deposits, setDeposits] = useState<DepositRow[]>([]);
  const [awaitingCredit, setAwaitingCredit] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [p, d] = await Promise.all([
        api<{ items: PaymentRow[] }>('/api/admin/payments?perPage=50'),
        api<{ items: DepositRow[]; awaitingCredit: number }>(
          '/api/admin/item-deposits?perPage=50',
        ),
      ]);
      setPayments(p.items);
      setDeposits(d.items);
      setAwaitingCredit(d.awaitingCredit);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const when = (iso: string): string =>
    new Date(iso).toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{t('admin.finance.title')}</h1>
        {awaitingCredit > 0 && (
          <span className="rounded-full bg-amber-500/15 px-3 py-1 text-sm text-amber-400">
            {t('admin.finance.awaitingCredit').replace('{count}', String(awaitingCredit))}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <TabButton active={tab === 'payments'} onClick={() => setTab('payments')}>
            {t('admin.finance.payments')}
          </TabButton>
          <TabButton active={tab === 'deposits'} onClick={() => setTab('deposits')}>
            {t('admin.finance.itemDeposits')}
          </TabButton>
          {/* The export follows the tab: an operator asking for "this, as a
              file" means the thing they are looking at. */}
          <button
            onClick={() =>
              void downloadFile(
                tab === 'payments'
                  ? '/api/admin/reports/payments.csv'
                  : '/api/admin/reports/item-deposits.csv',
                tab === 'payments' ? 'payments.csv' : 'item-deposits.csv',
              )
            }
            className="rounded bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700"
          >
            {t('admin.finance.export')}
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-neutral-400">…</p>
      ) : tab === 'payments' ? (
        payments.length === 0 ? (
          <p className="text-neutral-400">{t('admin.finance.empty')}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-800">
            <table className="w-full text-sm">
              <thead className="bg-neutral-900 text-left text-neutral-400">
                <tr>
                  <Th>{t('admin.finance.when')}</Th>
                  <Th>{t('admin.finance.player')}</Th>
                  <Th>{t('admin.finance.provider')}</Th>
                  <Th>{t('admin.finance.amount')}</Th>
                  <Th>{t('admin.finance.status')}</Th>
                </tr>
              </thead>
              <tbody>
                {payments.map((row) => (
                  <tr key={row.id} className="border-t border-neutral-800">
                    <Td>{when(row.createdAt)}</Td>
                    <Td>{row.user.username}</Td>
                    <Td>{row.provider}</Td>
                    <Td>
                      <Money value={row.amount} />
                      {row.bonus > 0 && (
                        <span className="ml-1 text-emerald-400">
                          +<Money value={row.bonus} />
                        </span>
                      )}
                    </Td>
                    <Td>
                      <StatusPill status={row.status} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : deposits.length === 0 ? (
        <p className="text-neutral-400">{t('admin.finance.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900 text-left text-neutral-400">
              <tr>
                <Th>{t('admin.finance.when')}</Th>
                <Th>{t('admin.finance.player')}</Th>
                <Th>{t('admin.finance.items')}</Th>
                <Th>{t('admin.finance.rate')}</Th>
                <Th>{t('admin.finance.amount')}</Th>
                <Th>{t('admin.finance.status')}</Th>
              </tr>
            </thead>
            <tbody>
              {deposits.map((row) => (
                <tr key={row.id} className="border-t border-neutral-800">
                  <Td>{when(row.createdAt)}</Td>
                  <Td>{row.user.username}</Td>
                  <Td title={row.items.map((i) => i.marketHashName).join(', ')}>
                    {row.items.length}
                  </Td>
                  <Td>{(row.rateBps / 100).toFixed(0)}%</Td>
                  <Td>
                    <Money value={row.totalValue} />
                  </Td>
                  <Td>
                    <StatusPill status={row.status} />
                    {row.failureReason && (
                      <div className="text-xs text-neutral-500">{row.failureReason}</div>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      data-active={active}
      className="rounded px-3 py-1.5 text-sm text-neutral-400 transition hover:text-neutral-200 data-[active=true]:bg-neutral-800 data-[active=true]:text-neutral-100"
    >
      {children}
    </button>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium">{children}</th>;
}

function Td({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <td className="px-3 py-2" title={title}>
      {children}
    </td>
  );
}

/**
 * A status, coloured by whether it needs somebody.
 *
 * Three buckets rather than one colour per state: done, in flight, and wrong.
 * An operator scanning this page is looking for the last of those, and a
 * palette with seven entries makes that harder rather than easier.
 */
function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'CREDITED' || status === 'SUCCEEDED'
      ? 'bg-emerald-500/15 text-emerald-400'
      : status === 'FAILED' || status === 'DECLINED' || status === 'CANCELLED'
        ? 'bg-neutral-700/40 text-neutral-400'
        : 'bg-amber-500/15 text-amber-400';

  return <span className={`rounded-full px-2 py-0.5 text-xs ${tone}`}>{status}</span>;
}
