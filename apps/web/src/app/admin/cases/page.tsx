'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { judgeRtp } from '@caseforge/shared';
import { api, ApiError } from '../../../lib/api';
import { useAuth } from '../../../lib/store';
import { Money } from '../../../components/Money';

interface CaseRow {
  id: string;
  slug: string;
  name: string;
  price: number;
  isActive: boolean;
  sortOrder: number;
  rtp: number | null;
  itemCount: number;
  unconfirmedPrices: number;
  imageUrl: string | null;
}

export default function AdminCasesPage() {
  const { user } = useAuth();
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    void api<CaseRow[]>('/api/admin/cases')
      .then(setCases)
      .catch((err) =>
        setError(
          err instanceof ApiError && err.status === 403
            ? 'Insufficient permissions for the CRM'
            : 'Could not load the cases',
        ),
      );
  }, [user]);

  async function syncPrices(): Promise<void> {
    setSyncing(true);
    setNotice(null);
    setError(null);
    try {
      const res = await api<{ checked: number; changed: number }>('/api/admin/items/sync-prices', {
        method: 'POST',
      });
      setNotice(`Items checked: ${res.checked}, prices updated: ${res.changed}`);
      setCases(await api<CaseRow[]>('/api/admin/cases'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Synchronisation failed');
    } finally {
      setSyncing(false);
    }
  }

  if (!user) return <p className="text-neutral-400">Sign in through Steam.</p>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Cases</h1>
        <Link
          href="/admin/cases/new"
          className="rounded bg-amber-500 px-3 py-1.5 text-sm font-medium text-neutral-950 hover:bg-amber-400"
        >
          New case
        </Link>
        <button
          onClick={() => void syncPrices()}
          disabled={syncing}
          className="rounded bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700 disabled:opacity-40"
        >
          {syncing ? 'Synchronising...' : 'Refresh prices from Steam'}
        </button>
      </div>

      <p className="text-sm text-neutral-500">
        Item prices drift: a case assembled at 90% RTP can go into loss after a knife's price
        jumps. Synchronisation recomputes the RTP of every active case.
      </p>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {notice && <p className="text-sm text-emerald-400">{notice}</p>}

      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-900 text-xs uppercase text-neutral-500">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Price</th>
              <th className="px-3 py-2">Items</th>
              <th className="px-3 py-2">RTP</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {cases.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-neutral-500">
                  No cases yet.
                </td>
              </tr>
            ) : (
              cases.map((row) => {
                const verdict = row.rtp === null ? null : judgeRtp(row.rtp);
                return (
                  <tr key={row.id} className="border-t border-neutral-800">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-9 w-12 shrink-0 overflow-hidden rounded bg-neutral-950">
                          {row.imageUrl ? (
                            <img
                              src={row.imageUrl}
                              alt=""
                              loading="lazy"
                              className="h-full w-full object-contain"
                            />
                          ) : (
                            <div className="flex h-full items-center justify-center text-sm opacity-40">
                              📦
                            </div>
                          )}
                        </div>
                        <span>{row.name}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <Money value={row.price} />
                    </td>
                    <td className="px-3 py-2 text-neutral-400">
                      {row.itemCount}
                      {row.unconfirmedPrices > 0 && (
                        <span
                          className="ml-2 text-amber-400"
                          title="Steam never confirmed the price of these items — an invented number is feeding the RTP"
                        >
                          {row.unconfirmedPrices} without a Steam price
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {verdict === null ? (
                        <span className="text-neutral-600">—</span>
                      ) : (
                        <span
                          className={
                            !verdict.allowed
                              ? 'text-red-400'
                              : verdict.healthy
                                ? 'text-emerald-400'
                                : 'text-amber-400'
                          }
                          title={verdict.message}
                        >
                          {(row.rtp! * 100).toFixed(1)}%
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {row.isActive ? (
                        <span className="text-emerald-400">active</span>
                      ) : (
                        <span className="text-neutral-600">disabled</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Link
                        href={`/admin/cases/${row.slug}`}
                        className="text-amber-400 hover:underline"
                      >
                        Edit
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
