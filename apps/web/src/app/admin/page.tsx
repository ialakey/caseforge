'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/store';
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
            ? 'Insufficient permissions for the CRM'
            : err instanceof Error
              ? err.message
              : 'Failed to load',
        );
      }
    })();
  }, [user]);

  if (!user) return <p className="text-neutral-400">Sign in through Steam.</p>;
  if (error) return <p className="text-red-400">{error}</p>;
  if (!dashboard) return <p className="text-neutral-400">Loading...</p>;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">CRM · last 30 days</h1>
        <Link
          href="/admin/cases"
          className="rounded bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700"
        >
          Cases
        </Link>
      </div>
      <div>
        <p className="mt-1 text-sm text-neutral-500">
          GGR is wagers minus wins. That is what shows earnings, not turnover.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="GGR">
          <Money value={dashboard.ggr} className={dashboard.ggr >= 0 ? 'text-emerald-400' : 'text-red-400'} />
        </Stat>
        <Stat label="Wagered">
          <Money value={dashboard.wagered} />
        </Stat>
        <Stat label="Won">
          <Money value={dashboard.won} />
        </Stat>
        <Stat label="Actual RTP">{(dashboard.actualRtp * 100).toFixed(1)}%</Stat>
        <Stat label="Openings">{dashboard.openings.toLocaleString('ru-RU')}</Stat>
        <Stat label="New players">{dashboard.newUsers}</Stat>
        <Stat label="Active players">{dashboard.activeUsers}</Stat>
        <Stat label="Withdrawals">
          <Money value={dashboard.withdrawals.total} />
        </Stat>
      </div>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Per-case margin</h2>
        <div className="overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-900 text-xs uppercase text-neutral-500">
              <tr>
                <th className="px-3 py-2">Case</th>
                <th className="px-3 py-2">Openings</th>
                <th className="px-3 py-2">Wagered</th>
                <th className="px-3 py-2">Won</th>
                <th className="px-3 py-2">GGR</th>
                <th className="px-3 py-2">RTP actual / planned</th>
              </tr>
            </thead>
            <tbody>
              {cases.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-neutral-500">
                    No openings in this period.
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
        <p className="mt-2 text-xs text-neutral-600">
          A gap between actual and planned RTP over a large sample means either
          item prices have shifted or the case ticket ranges are wrong.
        </p>
      </section>
    </div>
  );
}
