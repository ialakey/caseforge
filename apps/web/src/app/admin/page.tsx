'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/store';
import { useSettings } from '../../lib/settings';
import { Money } from '../../components/Money';

interface Dashboard {
  openings: number;
  wagered: number;
  won: number;
  ggr: number;
  actualRtp: number;
  deposits: { count: number; total: number };
  withdrawals: { count: number; total: number };
  newUsers: number;
  activeUsers: number;
}

interface CaseRow {
  caseId: string;
  name: string;
  openings: number;
  wagered: number;
  won: number;
  ggr: number;
  actualRtp: number;
  plannedRtp: number | null;
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-xl font-semibold">{children}</div>
    </div>
  );
}

export default function AdminPage() {
  const { user } = useAuth();
  const { t, locale } = useSettings();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      try {
        const [d, c] = await Promise.all([
          api<Dashboard>('/api/admin/dashboard'),
          api<CaseRow[]>('/api/admin/reports/cases'),
        ]);
        setDashboard(d);
        setCases(c);
      } catch (err) {
        setError(
          err instanceof ApiError && err.status === 403
            ? t('admin.noPermission')
            : err instanceof Error
              ? err.message
              : t('admin.loadFailed'),
        );
      }
    })();
  }, [user, t]);

  if (!user) return <p className="text-neutral-400">{t('admin.signInRequired')}</p>;
  if (error) return <p className="text-red-400">{error}</p>;
  if (!dashboard) return <p className="text-neutral-400">{t('admin.loading')}</p>;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{t('admin.dashboard.title')}</h1>
      </div>
      <div>
        <p className="mt-1 text-sm text-neutral-500">{t('admin.dashboard.ggrHint')}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t('admin.dashboard.ggr')}>
          <Money
            value={dashboard.ggr}
            className={dashboard.ggr >= 0 ? 'text-emerald-400' : 'text-red-400'}
          />
        </Stat>
        <Stat label={t('admin.dashboard.wagered')}>
          <Money value={dashboard.wagered} />
        </Stat>
        <Stat label={t('admin.dashboard.won')}>
          <Money value={dashboard.won} />
        </Stat>
        <Stat label={t('admin.dashboard.actualRtp')}>
          {(dashboard.actualRtp * 100).toFixed(1)}%
        </Stat>
        <Stat label={t('admin.dashboard.openings')}>
          {dashboard.openings.toLocaleString(locale)}
        </Stat>
        <Stat label={t('admin.dashboard.newUsers')}>{dashboard.newUsers}</Stat>
        <Stat label={t('admin.dashboard.activeUsers')}>{dashboard.activeUsers}</Stat>
        <Stat label={t('admin.dashboard.withdrawals')}>
          <Money value={dashboard.withdrawals.total} />
        </Stat>
      </div>

      <section>
        <h2 className="mb-3 text-lg font-semibold">{t('admin.dashboard.perCase')}</h2>
        <div className="overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-900 text-xs uppercase text-neutral-500">
              <tr>
                <th className="px-3 py-2">{t('admin.dashboard.case')}</th>
                <th className="px-3 py-2">{t('admin.dashboard.openings')}</th>
                <th className="px-3 py-2">{t('admin.dashboard.wagered')}</th>
                <th className="px-3 py-2">{t('admin.dashboard.won')}</th>
                <th className="px-3 py-2">{t('admin.dashboard.ggr')}</th>
                <th className="px-3 py-2">{t('admin.dashboard.rtpColumn')}</th>
              </tr>
            </thead>
            <tbody>
              {cases.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-neutral-500">
                    {t('admin.dashboard.empty')}
                  </td>
                </tr>
              ) : (
                cases.map((row) => (
                  <tr key={row.caseId} className="border-t border-neutral-800">
                    <td className="px-3 py-2">{row.name}</td>
                    <td className="px-3 py-2 text-neutral-400">{row.openings}</td>
                    <td className="px-3 py-2">
                      <Money value={row.wagered} />
                    </td>
                    <td className="px-3 py-2">
                      <Money value={row.won} />
                    </td>
                    <td className="px-3 py-2">
                      <Money
                        value={row.ggr}
                        className={row.ggr >= 0 ? 'text-emerald-400' : 'text-red-400'}
                      />
                    </td>
                    <td className="px-3 py-2 text-neutral-400">
                      {(row.actualRtp * 100).toFixed(1)}% /{' '}
                      {row.plannedRtp === null ? '—' : `${(row.plannedRtp * 100).toFixed(1)}%`}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-neutral-600">{t('admin.dashboard.rtpHint')}</p>
      </section>
    </div>
  );
}
