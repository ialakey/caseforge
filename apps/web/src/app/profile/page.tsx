'use client';

import { useCallback, useEffect, useState } from 'react';
import { translateError, verifyOpeningAsync, type ItemRarity } from '@caseforge/shared';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/store';
import { useSettings } from '../../lib/settings';
import { InventoryPanel } from '../../components/InventoryPanel';
import { Money } from '../../components/Money';
import { SteamAvatar } from '../../components/SteamAvatar';

interface Seeds {
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
}

interface Opening {
  id: string;
  caseName: string;
  itemName: string;
  rarity: ItemRarity;
  itemPrice: number;
  roll: number;
  nonce: number;
  clientSeed: string;
  serverSeedHash: string;
  serverSeed: string | null;
  createdAt: string;
}

export default function ProfilePage() {
  const { user, loadUser } = useAuth();
  const { locale, t } = useSettings();

  const [seeds, setSeeds] = useState<Seeds | null>(null);
  const [openings, setOpenings] = useState<Opening[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tradeUrlDraft, setTradeUrlDraft] = useState('');
  const [tradeUrlBusy, setTradeUrlBusy] = useState(false);

  /** openingId -> whether the check passed. Computed in the browser on Web Crypto. */
  const [verified, setVerified] = useState<Record<string, boolean>>({});

  const reload = useCallback(async () => {
    try {
      const [sd, hist] = await Promise.all([
        api<Seeds>('/api/me/seeds'),
        api<{ items: Opening[] }>('/api/me/openings?page=1&perPage=20'),
      ]);
      setSeeds(sd);
      setOpenings(hist.items);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(t('profile.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    if (user) void reload();
  }, [user, reload]);

  useEffect(() => {
    if (user?.tradeUrl) setTradeUrlDraft(user.tradeUrl);
  }, [user?.tradeUrl]);

  useEffect(() => {
    // Openings are recomputed right here in the browser, with the same
    // algorithm the server used. Web Crypto is async, so the result goes into
    // state rather than being computed inline in the markup.
    const revealed = openings.filter((o) => o.serverSeed !== null);
    if (revealed.length === 0) return;

    let cancelled = false;
    void Promise.all(
      revealed.map(async (o) => {
        const check = await verifyOpeningAsync({
          serverSeed: o.serverSeed!,
          serverSeedHash: o.serverSeedHash,
          clientSeed: o.clientSeed,
          nonce: o.nonce,
          expectedRoll: o.roll,
        });
        return [o.id, check.hashMatches && check.rollMatches] as const;
      }),
    ).then((pairs) => {
      if (!cancelled) setVerified(Object.fromEntries(pairs));
    });

    return () => {
      cancelled = true;
    };
  }, [openings]);

  function reportError(err: unknown, fallbackKey: Parameters<typeof t>[0]): void {
    setError(
      err instanceof ApiError ? translateError(locale, err.code, err.message) : t(fallbackKey),
    );
  }

  async function saveTradeUrl(): Promise<void> {
    setTradeUrlBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api('/api/me/trade-url', {
        method: 'POST',
        body: JSON.stringify({ tradeUrl: tradeUrlDraft.trim() }),
      });
      await loadUser();
      setNotice(t('profile.tradeUrlSaved'));
    } catch (err) {
      reportError(err, 'profile.tradeUrlFailed');
    } finally {
      setTradeUrlBusy(false);
    }
  }

  async function rotateSeed(): Promise<void> {
    try {
      const res = await api<{ revealedServerSeed: string }>('/api/me/seeds/rotate', {
        method: 'POST',
      });
      setNotice(`${t('profile.seedRevealed')}: ${res.revealedServerSeed}`);
      await reload();
    } catch (err) {
      reportError(err, 'profile.rotateFailed');
    }
  }

  if (!user) return <p className="text-ink-muted">{t('common.signInRequired')}</p>;

  return (
    <div className="space-y-6">
      <section className="cf-panel flex flex-wrap items-center gap-4 p-5">
        <SteamAvatar src={user.avatarUrl} name={user.username} size={72} />
        <div className="min-w-0">
          <div className="text-xl font-semibold">{user.username}</div>
          <div className="text-sm text-ink-faint">SteamID64: {user.steamId64}</div>
          <a
            href={`https://steamcommunity.com/profiles/${user.steamId64}`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-sm text-sky-400 hover:underline"
          >
            {t('profile.steamProfile')}
          </a>
        </div>
        <div className="ml-auto text-right">
          <div className="text-xs uppercase tracking-wide text-ink-faint">
            {t('common.balance')}
          </div>
          <Money value={user.balance} className="text-2xl font-semibold text-accent" />
        </div>
      </section>

      {error && (
        <p className="rounded-lg bg-negative/15 px-3 py-2 text-sm text-negative">{error}</p>
      )}

      {/* Selling and withdrawing live together in one panel — the inventory is
          the only place an item can be acted on. */}
      <InventoryPanel />

      <section className="cf-panel space-y-2 p-5">
        <h2 className="font-medium">{t('profile.tradeUrl')}</h2>
        <p className="text-sm text-ink-muted">{t('profile.tradeUrlHint')}</p>
        <div className="flex flex-wrap gap-2">
          <input
            value={tradeUrlDraft}
            onChange={(e) => setTradeUrlDraft(e.target.value)}
            placeholder="https://steamcommunity.com/tradeoffer/new/?partner=...&token=..."
            className="min-w-[280px] flex-1 rounded-lg border border-edge-subtle bg-surface-overlay px-3 py-2 text-sm outline-none focus:border-accent/60"
          />
          <button
            onClick={() => void saveTradeUrl()}
            disabled={tradeUrlBusy || tradeUrlDraft.trim().length === 0}
            className="cf-btn-ghost px-4 py-2 text-sm"
          >
            {tradeUrlBusy ? t('common.saving') : t('common.save')}
          </button>
        </div>
        {user.tradeUrl && <p className="text-xs text-positive">{t('profile.tradeUrlLinked')}</p>}
      </section>

      <section className="cf-panel p-5">
        <h2 className="mb-3 font-medium">{t('profile.fairness')}</h2>
        {seeds && (
          <div className="space-y-2 text-sm">
            <p className="break-all">
              <span className="text-ink-faint">{t('profile.serverSeedHash')}: </span>
              {seeds.serverSeedHash}
            </p>
            <p>
              <span className="text-ink-faint">{t('profile.clientSeed')}: </span>
              {seeds.clientSeed}
            </p>
            <p>
              <span className="text-ink-faint">{t('profile.nonce')}: </span>
              {seeds.nonce}
            </p>
            <p className="text-xs text-ink-faint">{t('profile.fairnessHint')}</p>
            <button onClick={() => void rotateSeed()} className="cf-btn-ghost px-3 py-1.5 text-xs">
              {t('profile.rotateSeed')}
            </button>
            {notice && <p className="break-all text-xs text-positive">{notice}</p>}
          </div>
        )}
      </section>

      <section className="cf-panel overflow-hidden">
        <h2 className="border-b border-edge-subtle px-5 py-4 font-medium">
          {t('profile.openings')}
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-overlay/60 text-xs uppercase tracking-wide text-ink-faint">
              <tr>
                <th className="px-5 py-2.5">{t('profile.case')}</th>
                <th className="px-3 py-2.5">{t('profile.item')}</th>
                <th className="px-3 py-2.5">{t('profile.price')}</th>
                <th className="px-3 py-2.5">{t('profile.roll')}</th>
                <th className="px-3 py-2.5">{t('profile.verification')}</th>
              </tr>
            </thead>
            <tbody>
              {openings.map((o) => {
                const check = o.serverSeed === null ? null : verified[o.id];

                return (
                  <tr key={o.id} className="border-t border-edge-subtle/60">
                    <td className="px-5 py-2.5 text-ink-muted">{o.caseName}</td>
                    <td className="px-3 py-2.5">{o.itemName}</td>
                    <td className="px-3 py-2.5">
                      <Money value={o.itemPrice} className="text-accent" />
                    </td>
                    <td className="px-3 py-2.5 text-ink-muted">{o.roll.toLocaleString(locale)}</td>
                    <td className="px-3 py-2.5 text-xs">
                      {check === null ? (
                        <span className="text-ink-faint">{t('profile.seedStillActive')}</span>
                      ) : check === undefined ? (
                        <span className="text-ink-faint">{t('profile.verifying')}</span>
                      ) : check ? (
                        <span className="text-positive">{t('profile.verified')}</span>
                      ) : (
                        <span className="text-negative">{t('profile.mismatch')}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
