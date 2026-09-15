'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  type InventoryFilter,
  type ItemRarity,
  type PriceBandKey,
  type TranslationKey,
  INVENTORY_FILTERS,
  PRICE_BANDS,
  isActionable,
  translateError,
} from '@caseforge/shared';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/store';
import { useSettings } from '../lib/settings';
import { ItemImage } from './ItemImage';
import { Money, useMoneyFormatter } from './Money';
import { rarityColor } from './RarityBadge';

export interface InventoryEntry {
  id: string;
  status: string;
  acquiredPrice: number;
  sellPrice: number;
  createdAt: string;
  settledAt: string;
  item: {
    id: string;
    marketHashName: string;
    name: string;
    imageUrl: string | null;
    rarity: ItemRarity;
  };
}

interface Summary {
  all: { count: number; value: number };
  available: { count: number; value: number };
  pending: { count: number; value: number };
  history: { count: number; value: number };
}

const FILTER_LABELS: Record<InventoryFilter, TranslationKey> = {
  all: 'inventory.filterAll',
  available: 'inventory.filterAvailable',
  pending: 'inventory.filterPending',
  history: 'inventory.filterHistory',
};

/** Colour per status, so the history reads at a glance. */
const STATUS_TONE: Record<string, string> = {
  AVAILABLE: 'text-positive',
  LOCKED: 'text-accent',
  WITHDRAWN: 'text-sky-400',
  SOLD: 'text-ink-faint',
  UPGRADED: 'text-fuchsia-400',
  CONTRACTED: 'text-fuchsia-400',
};

export function InventoryPanel() {
  const { setBalance } = useAuth();
  const { locale, t } = useSettings();
  const money = useMoneyFormatter();

  const [items, setItems] = useState<InventoryEntry[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [filter, setFilter] = useState<InventoryFilter>('available');
  const [band, setBand] = useState<PriceBandKey>('all');

  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmSellAll, setConfirmSellAll] = useState(false);
  const [sellingAll, setSellingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const params = new URLSearchParams({ filter, band });
      const [list, sum] = await Promise.all([
        api<InventoryEntry[]>(`/api/inventory?${params}`),
        api<Summary>('/api/inventory/summary'),
      ]);
      setItems(list);
      setSummary(sum);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(t('profile.loadFailed'));
    }
  }, [filter, band, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function report(err: unknown, fallback: TranslationKey): void {
    setNotice(null);
    setError(err instanceof ApiError ? translateError(locale, err.code, err.message) : t(fallback));
  }

  async function sellOne(id: string): Promise<void> {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const res = await api<{ balance: number }>('/api/inventory/sell', {
        method: 'POST',
        body: JSON.stringify({ inventoryItemIds: [id] }),
      });
      setBalance(res.balance);
      await reload();
    } catch (err) {
      report(err, 'drops.sellFailed');
    } finally {
      setBusyId(null);
    }
  }

  async function withdrawOne(id: string): Promise<void> {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const res = await api<{ withdrawn: number }>('/api/inventory/withdraw', {
        method: 'POST',
        body: JSON.stringify({ inventoryItemIds: [id] }),
      });
      setNotice(t('inventory.withdrawn', { count: res.withdrawn }));
      await reload();
    } catch (err) {
      report(err, 'inventory.withdrawFailed');
    } finally {
      setBusyId(null);
    }
  }

  async function sellAll(): Promise<void> {
    setSellingAll(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api<{ sold: number; total: number; balance: number }>(
        '/api/inventory/sell-all',
        { method: 'POST', body: JSON.stringify({ band }) },
      );
      setBalance(res.balance);
      // The server's figure, not the estimate the dialog quoted: between the
      // two the inventory may have moved.
      setNotice(t('inventory.sellAllDone', { count: res.sold, total: money(res.total) }));
      setConfirmSellAll(false);
      await reload();
    } catch (err) {
      setConfirmSellAll(false);
      report(err, 'inventory.sellAllFailed');
    } finally {
      setSellingAll(false);
    }
  }

  // What "sell everything" would cover: the sellable items inside the current
  // band, which is exactly the set the server resolves for the same filter.
  const sellable = items.filter((i) => isActionable(i.status as never));
  const sellableTotal = sellable.reduce((sum, i) => sum + i.sellPrice, 0);
  const canSellAll = filter !== 'history' && filter !== 'pending' && sellable.length > 0;

  return (
    <section className="cf-panel p-5">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-semibold">{t('inventory.title')}</h2>
          {summary && (
            <span className="text-sm text-ink-faint">
              {summary.available.count} · {t('inventory.summaryValue')}{' '}
              <Money value={summary.available.value} className="text-accent" />
            </span>
          )}
        </div>

        <button
          onClick={() => setConfirmSellAll(true)}
          disabled={!canSellAll || sellingAll}
          className="cf-btn-primary px-4 py-2 text-sm"
        >
          {t('inventory.sellAll')}
          {sellable.length > 0 && <span className="ml-2 opacity-80">{money(sellableTotal)}</span>}
        </button>
      </header>

      {/* Tabs: what the player is looking for, not what the status column says. */}
      <div className="mb-3 flex flex-wrap gap-2">
        {INVENTORY_FILTERS.map((key) => (
          <button
            key={key}
            data-active={filter === key}
            onClick={() => setFilter(key)}
            className="cf-chip px-3 py-1.5"
          >
            {t(FILTER_LABELS[key])}
            {summary && <span className="ml-1.5 opacity-60">{summary[key].count}</span>}
          </button>
        ))}
      </div>

      {/* Price bands. Edges are fixed in the base currency and formatted for
          display, so switching currency relabels them without re-sorting. */}
      <div className="mb-4 flex flex-wrap gap-2">
        <button
          data-active={band === 'all'}
          onClick={() => setBand('all')}
          className="cf-chip px-3 py-1.5"
        >
          {t('inventory.bandAll')}
        </button>
        {PRICE_BANDS.map((b) => (
          <button
            key={b.key}
            data-active={band === b.key}
            onClick={() => setBand(b.key)}
            className="cf-chip px-3 py-1.5"
          >
            {b.max === null
              ? t('inventory.bandOver', { min: money(b.min) })
              : b.min === 0
                ? t('inventory.bandUnder', { max: money(b.max) })
                : t('inventory.bandBetween', { min: money(b.min), max: money(b.max) })}
          </button>
        ))}
      </div>

      {error && (
        <p className="mb-3 rounded-lg bg-negative/15 px-3 py-2 text-sm text-negative">{error}</p>
      )}
      {notice && (
        <p className="mb-3 rounded-lg bg-positive/15 px-3 py-2 text-sm text-positive">{notice}</p>
      )}

      {items.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-faint">
          {summary && summary.all.count === 0 ? t('inventory.empty') : t('inventory.emptyFiltered')}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {items.map((entry) => (
            <InventoryCard
              key={entry.id}
              entry={entry}
              busy={busyId === entry.id}
              onSell={() => void sellOne(entry.id)}
              onWithdraw={() => void withdrawOne(entry.id)}
            />
          ))}
        </div>
      )}

      {confirmSellAll && (
        <ConfirmSellAll
          count={sellable.length}
          total={sellableTotal}
          busy={sellingAll}
          onCancel={() => setConfirmSellAll(false)}
          onConfirm={() => void sellAll()}
        />
      )}
    </section>
  );
}

function InventoryCard({
  entry,
  busy,
  onSell,
  onWithdraw,
}: {
  entry: InventoryEntry;
  busy: boolean;
  onSell: () => void;
  onWithdraw: () => void;
}) {
  const { t } = useSettings();
  const color = rarityColor(entry.item.rarity);
  const actionable = isActionable(entry.status as never);

  return (
    <article
      className="group relative flex flex-col overflow-hidden rounded-lg border border-edge-subtle bg-surface-raised/70 transition hover:border-edge-strong"
      style={{ boxShadow: actionable ? `inset 0 -2px 0 0 ${color}` : undefined }}
    >
      {/* Spent items are dimmed rather than hidden: the row is history now, and
          history should not compete with what the player can still act on. */}
      <div className={actionable ? '' : 'opacity-55 grayscale-[0.35]'}>
        <div
          className="relative p-3"
          style={{
            backgroundImage: `radial-gradient(ellipse 70% 60% at 50% 100%, ${color}22, transparent)`,
          }}
        >
          <ItemImage
            src={entry.item.imageUrl}
            alt={entry.item.marketHashName}
            rarity={entry.item.rarity}
            className="h-20 w-full"
          />
        </div>

        <div className="space-y-1 px-3 pb-2">
          <div className="truncate text-xs text-ink-primary" title={entry.item.marketHashName}>
            {entry.item.marketHashName}
          </div>
          <div className="flex items-center justify-between">
            <Money value={entry.acquiredPrice} className="text-sm font-semibold text-accent" />
            <span
              className={`text-[10px] font-medium ${STATUS_TONE[entry.status] ?? 'text-ink-faint'}`}
            >
              {t(`status.${entry.status}` as TranslationKey)}
            </span>
          </div>
        </div>
      </div>

      {actionable && (
        <div className="mt-auto grid grid-cols-2 gap-1 p-2 pt-0">
          <button onClick={onSell} disabled={busy} className="cf-btn-ghost py-1.5 text-[11px]">
            {t('inventory.sell')}
          </button>
          <button
            onClick={onWithdraw}
            disabled={busy}
            title={t('inventory.withdrawStub')}
            className="cf-btn-ghost py-1.5 text-[11px]"
          >
            {t('inventory.withdraw')}
          </button>
        </div>
      )}
    </article>
  );
}

function ConfirmSellAll({
  count,
  total,
  busy,
  onCancel,
  onConfirm,
}: {
  count: number;
  total: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useSettings();
  const money = useMoneyFormatter();

  // Rendered into the body rather than in place. A `backdrop-filter` anywhere
  // up the tree — .cf-panel has one — makes that ancestor the containing block
  // for `fixed` descendants, and the dialog would be centred inside the
  // inventory panel instead of the window.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="cf-panel w-full max-w-sm animate-fade-up p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold">{t('inventory.sellAllTitle')}</h3>
        <p className="mt-2 text-sm text-ink-muted">
          {t('inventory.sellAllBody', { count, total: money(total) })}
        </p>
        <div className="mt-5 flex gap-2">
          <button onClick={onCancel} disabled={busy} className="cf-btn-ghost flex-1 py-2 text-sm">
            {t('inventory.cancel')}
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="cf-btn-primary flex-[2] py-2 text-sm"
          >
            {busy ? t('drops.selling') : t('inventory.sellAllConfirm', { total: money(total) })}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
