'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import { useSettings } from '../../../lib/settings';

interface BotRow {
  id: string;
  steamId64: string;
  username: string;
  label: string | null;
  status: string;
  maxItems: number;
  currentItems: number;
  lastOnlineAt: string | null;
  lastError: string | null;
}

/** Colour per status, so a farm of twenty reads at a glance. */
const TONE: Record<string, string> = {
  ONLINE: 'text-positive',
  BUSY: 'text-accent',
  OFFLINE: 'text-ink-faint',
  DISABLED: 'text-ink-faint',
  ERROR: 'text-negative',
};

/**
 * The bot farm.
 *
 * Read-mostly on purpose. The worker owns a bot's lifecycle — it logs in, goes
 * BUSY while an offer is out, and records its own errors — so the panel offers
 * the two transitions an operator actually needs: take a misbehaving bot out of
 * rotation, and put it back. Anything more would be a second author of the same
 * state, which is how a bot ends up ONLINE in the table and logged out in fact.
 *
 * Adding a bot stays a script (`pnpm --filter @caseforge/bot add-bot`): it needs
 * the Steam password and both secrets, and those should not travel through a
 * browser form.
 */
export default function AdminBotsPage() {
  const { t } = useSettings();
  const [rows, setRows] = useState<BotRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api<BotRow[]>('/api/admin/bots'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('admin.bots.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setStatus(id: string, status: 'DISABLED' | 'OFFLINE'): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await api(`/api/admin/bots/${id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('admin.bots.statusFailed'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('admin.bots.title')}</h1>

      {error && (
        <p className="rounded-lg bg-negative/15 px-3 py-2 text-sm text-negative">{error}</p>
      )}

      <section className="cf-panel overflow-hidden">
        <h2 className="border-b border-edge-subtle px-5 py-4 font-medium">
          {t('admin.bots.farm')} <span className="text-ink-faint">{rows.length}</span>
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-overlay/60 text-xs uppercase tracking-wide text-ink-faint">
              <tr>
                <th className="px-5 py-2.5">{t('admin.bots.bot')}</th>
                <th className="px-3 py-2.5">{t('admin.bots.steamId')}</th>
                <th className="px-3 py-2.5">{t('admin.bots.status')}</th>
                <th className="px-3 py-2.5">{t('admin.bots.inventory')}</th>
                <th className="px-3 py-2.5">{t('admin.bots.lastOnline')}</th>
                <th className="px-3 py-2.5">{t('admin.bots.lastError')}</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} className="border-t border-edge-subtle/60">
                  <td className="px-5 py-2.5">
                    {b.label ?? b.username}
                    {b.label && <span className="ml-2 text-ink-faint">{b.username}</span>}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs text-ink-muted">{b.steamId64}</td>
                  <td className={`px-3 py-2.5 font-medium ${TONE[b.status] ?? 'text-ink-muted'}`}>
                    {b.status}
                  </td>
                  <td className="px-3 py-2.5 text-ink-muted">
                    {b.currentItems} / {b.maxItems}
                  </td>
                  <td className="px-3 py-2.5 text-ink-muted">
                    {b.lastOnlineAt ? b.lastOnlineAt.replace('T', ' ').slice(0, 16) : '—'}
                  </td>
                  <td className="max-w-[260px] truncate px-3 py-2.5 text-xs text-negative">
                    {b.lastError ?? ''}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {b.status === 'DISABLED' ? (
                      <button
                        onClick={() => void setStatus(b.id, 'OFFLINE')}
                        disabled={busyId === b.id}
                        className="text-xs text-ink-faint hover:text-positive"
                      >
                        {t('admin.enable')}
                      </button>
                    ) : (
                      <button
                        onClick={() => void setStatus(b.id, 'DISABLED')}
                        disabled={busyId === b.id}
                        className="text-xs text-ink-faint hover:text-negative"
                      >
                        {t('admin.disable')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-6 text-center text-ink-faint">
                    {t('admin.bots.empty')}{' '}
                    <code className="text-ink-muted">pnpm --filter @caseforge/bot add-bot</code>.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
