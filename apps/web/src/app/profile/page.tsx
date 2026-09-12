'use client';

import { useCallback, useEffect, useState } from 'react';
import { translateError, verifyOpeningAsync, type ItemRarity } from '@caseforge/shared';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/store';
import { useSettings } from '../../lib/settings';
import { ItemImage } from '../../components/ItemImage';
import { Money } from '../../components/Money';
import { RarityBadge } from '../../components/RarityBadge';
import { SteamAvatar } from '../../components/SteamAvatar';

interface InventoryEntry {
  id: string;
  status: string;
  acquiredPrice: number;
  sellPrice: number;
  item: { id: string; marketHashName: string; imageUrl: string | null; rarity: ItemRarity };
}

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
  const { user, setBalance, loadUser } = useAuth();
  const { locale, t } = useSettings();

  const [inventory, setInventory] = useState<InventoryEntry[]>([]);
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
      const [inv, sd, hist] = await Promise.all([
        api<InventoryEntry[]>('/api/inventory'),
        api<Seeds>('/api/me/seeds'),
        api<{ items: Opening[] }>('/api/me/openings?page=1&perPage=20'),
      ]);
      setInventory(inv);
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

  async function sell(id: string): Promise<void> {
    try {
      const res = await api<{ balance: number }>('/api/inventory/sell', {
        method: 'POST',
        body: JSON.stringify({ inventoryItemIds: [id] }),
      });
      setBalance(res.balance);
      await reload();
    } catch (err) {
      reportError(err, 'drops.sellFailed');
    }
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

  if (!user) return <p className="text-neutral-400">{t('common.signInRequired')}</p>;

  return (
    <div className="space-y-10">
      <section className="flex flex-wrap items-center gap-4 rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <SteamAvatar src={user.avatarUrl} name={user.username} size={72} />
        <div className="min-w-0">
          <div className="text-xl font-semibold">{user.username}</div>
          <div className="text-sm text-neutral-500">SteamID64: {user.steamId64}</div>
          <a
            href={`https://steamcommunity.com/profiles/${user.steamId64}`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-sm text-blue-400 hover:underline"
          >
            {t('profile.steamProfile')}
          </a>
        </div>
        <div className="ml-auto text-right">
          <div className="text-xs uppercase tracking-wide text-neutral-500">
            {t('common.balance')}
          </div>
          <Money value={user.balance} className="text-2xl font-semibold text-amber-400" />
        </div>
      </section>

      <section className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <h2 className="font-medium">{t('profile.tradeUrl')}</h2>
        <p className="text-sm text-neutral-500">{t('profile.tradeUrlHint')}</p>
        <div className="flex flex-wrap gap-2">
          <input
            value={tradeUrlDraft}
            onChange={(e) => setTradeUrlDraft(e.target.value)}
            placeholder="https://steamcommunity.com/tradeoffer/new/?partner=...&token=..."
            className="min-w-[280px] flex-1 rounded bg-neutral-800 px-3 py-2 text-sm"
          />
          <button
            onClick={() => void saveTradeUrl()}
            disabled={tradeUrlBusy || tradeUrlDraft.trim().length === 0}
            className="rounded bg-neutral-800 px-4 py-2 text-sm hover:bg-neutral-700 disabled:opacity-40"
          >
            {tradeUrlBusy ? t('common.saving') : t('common.save')}
          </button>
        </div>
        {user.tradeUrl && <p className="text-xs text-emerald-400">{t('profile.tradeUrlLinked')}</p>}
      </section>

      <section>
        <h1 className="mb-4 text-2xl font-semibold">{t('profile.inventory')}</h1>
        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
        {inventory.length === 0 ? (
          <p className="text-neutral-500">{t('profile.inventoryEmpty')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {inventory.map((entry) => (
              <div
                key={entry.id}
                className="rounded-lg border border-neutral-800 bg-neutral-900 p-3"
              >
                <ItemImage
                  src={entry.item.imageUrl}
                  alt={entry.item.marketHashName}
                  rarity={entry.item.rarity}
                  className="mb-2 h-20 w-full"
                />
                <RarityBadge rarity={entry.item.rarity} />
                <div className="mt-2 truncate text-sm">{entry.item.marketHashName}</div>
                <Money value={entry.acquiredPrice} className="text-xs text-amber-400" />
                <button
                  onClick={() => void sell(entry.id)}
                  disabled={entry.status !== 'AVAILABLE'}
                  className="mt-2 w-full rounded bg-neutral-800 py-1 text-xs hover:bg-neutral-700 disabled:opacity-40"
                >
                  {entry.status === 'AVAILABLE' ? t('profile.sell') : t('profile.inWithdrawal')}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-4 text-2xl font-semibold">{t('profile.fairness')}</h2>
        {seeds && (
          <div className="space-y-2 rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-sm">
            <p className="break-all">
              <span className="text-neutral-500">{t('profile.serverSeedHash')}: </span>
              {seeds.serverSeedHash}
            </p>
            <p>
              <span className="text-neutral-500">{t('profile.clientSeed')}: </span>
              {seeds.clientSeed}
            </p>
            <p>
              <span className="text-neutral-500">{t('profile.nonce')}: </span>
              {seeds.nonce}
            </p>
            <p className="text-xs text-neutral-500">{t('profile.fairnessHint')}</p>
            <button
              onClick={() => void rotateSeed()}
              className="rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700"
            >
              {t('profile.rotateSeed')}
            </button>
            {notice && <p className="break-all text-xs text-emerald-400">{notice}</p>}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-4 text-2xl font-semibold">{t('profile.openings')}</h2>
        <div className="overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-900 text-xs uppercase text-neutral-500">
              <tr>
                <th className="px-3 py-2">{t('profile.case')}</th>
                <th className="px-3 py-2">{t('profile.item')}</th>
                <th className="px-3 py-2">{t('profile.price')}</th>
                <th className="px-3 py-2">{t('profile.roll')}</th>
                <th className="px-3 py-2">{t('profile.verification')}</th>
              </tr>
            </thead>
            <tbody>
              {openings.map((o) => {
                const check = o.serverSeed === null ? null : verified[o.id];

                return (
                  <tr key={o.id} className="border-t border-neutral-800">
                    <td className="px-3 py-2 text-neutral-400">{o.caseName}</td>
                    <td className="px-3 py-2">{o.itemName}</td>
                    <td className="px-3 py-2">
                      <Money value={o.itemPrice} className="text-amber-400" />
                    </td>
                    <td className="px-3 py-2 text-neutral-400">{o.roll.toLocaleString(locale)}</td>
                    <td className="px-3 py-2 text-xs">
                      {check === null ? (
                        <span className="text-neutral-600">{t('profile.seedStillActive')}</span>
                      ) : check === undefined ? (
                        <span className="text-neutral-600">{t('profile.verifying')}</span>
                      ) : check ? (
                        <span className="text-emerald-400">{t('profile.verified')}</span>
                      ) : (
                        <span className="text-red-400">{t('profile.mismatch')}</span>
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
