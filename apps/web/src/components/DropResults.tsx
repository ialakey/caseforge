'use client';

import { useState } from 'react';
import { translateError, type OpenCaseResult } from '@caseforge/shared';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/store';
import { useSettings } from '../lib/settings';
import { ItemImage } from './ItemImage';
import { Money, useMoneyFormatter } from './Money';
import { RarityBadge, rarityColor } from './RarityBadge';

/**
 * The outcome of an opening: what dropped and what to do with it.
 *
 * The items are already in the inventory — selling from here only saves a trip
 * to the profile for the most common action. Sold entries fade rather than
 * vanish: a card disappearing where a knife just dropped reads as a bug.
 */
export function DropResults({ openings, spent }: { openings: OpenCaseResult[]; spent: number }) {
  const { setBalance } = useAuth();
  const { locale, t } = useSettings();
  const money = useMoneyFormatter();
  const [sold, setSold] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unsold = openings.filter((o) => !sold[o.inventoryItemId]);
  const totalWon = openings.reduce((sum, o) => sum + o.item.price, 0);
  const unsoldValue = unsold.reduce((sum, o) => sum + o.item.price, 0);
  const profit = totalWon - spent;

  async function sell(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ balance: number }>('/api/inventory/sell', {
        method: 'POST',
        body: JSON.stringify({ inventoryItemIds: ids }),
      });
      setBalance(res.balance);
      setSold((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, true])) }));
    } catch (err) {
      setError(
        err instanceof ApiError
          ? translateError(locale, err.code, err.message)
          : t('drops.sellFailed'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm">
        <span className="text-ink-faint">
          {t('drops.spent')}: <Money value={spent} className="text-ink-muted" />
        </span>
        <span className="text-ink-faint">
          {t('drops.won')}: <Money value={totalWon} className="text-accent" />
        </span>
        <span className={profit >= 0 ? 'font-medium text-positive' : 'font-medium text-negative'}>
          {profit >= 0 ? '+' : '−'}
          <Money value={Math.abs(profit)} />
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
        {openings.map((opening) => {
          const isSold = Boolean(sold[opening.inventoryItemId]);
          const color = rarityColor(opening.item.rarity);
          return (
            <div
              key={opening.openingId}
              className={`rounded-lg border-t-2 bg-surface-raised p-3 transition ${isSold ? 'opacity-40' : ''}`}
              style={{
                borderTopColor: color,
                boxShadow: isSold ? undefined : `0 0 18px -10px ${color}`,
              }}
            >
              <ItemImage
                src={opening.item.imageUrl}
                alt={opening.item.marketHashName}
                rarity={opening.item.rarity}
                className="mb-2 h-20 w-full"
              />
              <RarityBadge rarity={opening.item.rarity} />
              <div className="mt-1 truncate text-xs" title={opening.item.marketHashName}>
                {opening.item.marketHashName}
              </div>
              <Money value={opening.item.price} className="text-sm font-medium text-accent" />

              <button
                onClick={() => void sell([opening.inventoryItemId])}
                disabled={isSold || busy}
                className="mt-2 w-full rounded-lg bg-positive/20 py-1 text-xs font-medium text-positive transition hover:bg-positive/30 disabled:cursor-not-allowed disabled:bg-surface-overlay disabled:text-ink-faint"
              >
                {isSold ? t('drops.sold') : t('drops.sell')}
              </button>
            </div>
          );
        })}
      </div>

      {error && <p className="text-center text-sm text-negative">{error}</p>}

      {unsold.length > 0 && (
        <div className="flex flex-wrap justify-center gap-3">
          <button
            onClick={() => void sell(unsold.map((o) => o.inventoryItemId))}
            disabled={busy}
            className="cf-btn-primary px-5 py-2 text-sm"
          >
            {busy ? t('drops.selling') : `${t('drops.sellAll')} ${money(unsoldValue)}`}
          </button>
          <a
            href="/profile"
            className="rounded-lg bg-surface-overlay px-5 py-2 text-sm hover:bg-surface-hover"
          >
            {t('drops.keep')}
          </a>
        </div>
      )}
    </div>
  );
}
