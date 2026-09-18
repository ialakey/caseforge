'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  translateError,
  type DepositCandidate,
  type DepositQuote,
  type ItemDepositView,
  type TranslationKey,
} from '@caseforge/shared';
import { api, ApiError, loginUrl } from '../../../lib/api';
import { useAuth } from '../../../lib/store';
import { useSettings } from '../../../lib/settings';
import { ItemImage } from '../../../components/ItemImage';
import { Money, useMoneyFormatter } from '../../../components/Money';

/** How a request's status reads to the player. */
const STATUS_LABEL: Record<ItemDepositView['status'], TranslationKey> = {
  PENDING: 'deposit.items.pending',
  OFFER_SENT: 'deposit.items.offerSent',
  ACCEPTED: 'deposit.items.accepted',
  CREDITED: 'deposit.items.credited',
  DECLINED: 'deposit.items.declined',
  FAILED: 'deposit.items.failed',
  CANCELLED: 'deposit.items.cancelled',
};

/** The states in which a request is still waiting on somebody. */
const LIVE: ReadonlyArray<ItemDepositView['status']> = ['PENDING', 'OFFER_SENT', 'ACCEPTED'];

/**
 * Handing skins to the site in exchange for balance.
 *
 * The page shows the player's whole CS2 inventory, including what cannot be
 * deposited and why. Hiding the untradable half would be tidier and would leave
 * somebody staring at a gap where their knife should be, wondering whether the
 * site is broken — when the answer is a seven-day trade hold that Steam will
 * tell them about if asked.
 */
export default function DepositItemsPage() {
  const { user } = useAuth();
  const { locale, t } = useSettings();
  const money = useMoneyFormatter();

  const [quote, setQuote] = useState<DepositQuote | null>(null);
  const [deposits, setDeposits] = useState<ItemDepositView[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [inventory, history] = await Promise.all([
        api<DepositQuote>('/api/deposits/items/inventory'),
        api<ItemDepositView[]>('/api/deposits/items'),
      ]);
      setQuote(inventory);
      setDeposits(history);
    } catch (err) {
      setError(
        err instanceof ApiError ? translateError(locale, err.code, err.message) : String(err),
      );
    } finally {
      setLoading(false);
    }
  }, [locale]);

  useEffect(() => {
    if (!user) return;
    void load();
  }, [user, load]);

  // A request in flight is the player's next move, not this page's: while one
  // exists the picker is pointless, because the server refuses a second.
  const live = deposits.find((d) => LIVE.includes(d.status)) ?? null;

  const depositable = useMemo(
    () => (quote?.items ?? []).filter((i) => i.blockedReason === null),
    [quote],
  );
  const total = useMemo(
    () => depositable.filter((i) => selected.has(i.assetId)).reduce((sum, i) => sum + i.payout, 0),
    [depositable, selected],
  );

  function toggle(assetId: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api<ItemDepositView>('/api/deposits/items', {
        method: 'POST',
        body: JSON.stringify({ assetIds: [...selected] }),
      });
      setSelected(new Set());
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError ? translateError(locale, err.code, err.message) : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string): Promise<void> {
    setBusy(true);
    try {
      await api(`/api/deposits/items/${id}/cancel`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError ? translateError(locale, err.code, err.message) : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return (
      <div className="cf-panel p-6 text-center">
        <p className="mb-4 text-ink-muted">{t('deposit.items.title')}</p>
        <a href={loginUrl} className="cf-btn-primary px-8 py-2.5">
          {t('nav.signIn')}
        </a>
      </div>
    );
  }

  const tooMany = quote !== null && selected.size > quote.maxItems;
  const tooSmall = quote !== null && selected.size > 0 && total < quote.minValue;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{t('deposit.items.title')}</h1>
        <p className="max-w-3xl text-sm leading-relaxed text-ink-muted">
          {t('deposit.items.lead')}
        </p>
        {quote && (
          <p className="text-sm text-accent">
            {t('deposit.items.rate').replace('{rate}', (quote.rateBps / 100).toFixed(0))}
          </p>
        )}
      </header>

      {error && <p className="cf-panel p-3 text-sm text-negative">{error}</p>}

      {live ? (
        <LiveRequest request={live} onCancel={cancel} busy={busy} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-ink-muted">
              {quote && (
                <>
                  {t('deposit.items.selected')
                    .replace('{count}', String(selected.size))
                    .replace('{amount}', money(total))}
                  {' · '}
                  {t('deposit.items.min').replace('{amount}', money(quote.minValue))}
                  {' · '}
                  {t('deposit.items.max').replace('{count}', String(quote.maxItems))}
                </>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={() => void load()} disabled={busy} className="cf-chip px-3 py-1.5">
                {t('deposit.items.reload')}
              </button>
              <button
                onClick={() => void submit()}
                disabled={busy || selected.size === 0 || tooMany || tooSmall}
                className="cf-btn-primary px-6 py-1.5 disabled:opacity-40"
              >
                {t('deposit.items.submit')}
              </button>
            </div>
          </div>

          {loading ? (
            <p className="text-ink-faint">…</p>
          ) : quote && quote.items.length === 0 ? (
            <p className="text-ink-faint">{t('deposit.items.empty')}</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {(quote?.items ?? []).map((item) => (
                <InventoryCard
                  key={item.assetId}
                  item={item}
                  picked={selected.has(item.assetId)}
                  onToggle={toggle}
                />
              ))}
            </div>
          )}
        </>
      )}

      {deposits.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
            {t('deposit.items.history')}
          </h2>
          <div className="cf-panel divide-y divide-edge-subtle">
            {deposits.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                <span className="text-ink-faint">
                  {new Date(d.createdAt).toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU')}
                </span>
                <span>{t(STATUS_LABEL[d.status])}</span>
                <span className="text-ink-faint">{d.items.length}</span>
                <Money value={d.totalValue} className="ml-auto font-semibold text-accent" />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** One skin in the player's inventory, selectable unless Steam says otherwise. */
function InventoryCard({
  item,
  picked,
  onToggle,
}: {
  item: DepositCandidate;
  picked: boolean;
  onToggle: (assetId: string) => void;
}) {
  const { t } = useSettings();
  const blocked = item.blockedReason !== null;

  return (
    <button
      type="button"
      onClick={() => !blocked && onToggle(item.assetId)}
      disabled={blocked}
      data-picked={picked}
      className="rounded-lg border border-edge-subtle bg-surface-raised/70 p-2 text-left transition data-[picked=true]:border-accent disabled:opacity-40"
    >
      <ItemImage
        src={item.imageUrl}
        alt={item.marketHashName}
        rarity={item.rarity}
        className="mb-2 h-16 w-full"
      />
      <div className="truncate text-xs font-medium" title={item.marketHashName}>
        {item.marketHashName}
      </div>
      {blocked ? (
        <div className="mt-1 text-[11px] text-negative">
          {item.blockedReason === 'untradable'
            ? t('deposit.items.untradable')
            : t('deposit.items.noPrice')}
        </div>
      ) : (
        <div className="mt-1 flex items-baseline justify-between gap-1">
          <Money value={item.payout} className="text-xs font-semibold text-accent" />
          {/* The market price beside the payout, struck through: the rate is in
              the header, but the difference is what a player actually wants to
              see, and a single number invites the suspicion that it is made up. */}
          <Money value={item.marketPrice} className="text-[10px] text-ink-faint line-through" />
        </div>
      )}
    </button>
  );
}

/** The one request a player may have open, and what to do about it. */
function LiveRequest({
  request,
  onCancel,
  busy,
}: {
  request: ItemDepositView;
  onCancel: (id: string) => Promise<void>;
  busy: boolean;
}) {
  const { locale, t } = useSettings();

  return (
    <div className="cf-panel space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium text-accent">{t(STATUS_LABEL[request.status])}</span>
        <Money value={request.totalValue} className="font-semibold" />
        <span className="text-sm text-ink-faint">
          {t('deposit.items.expires').replace(
            '{time}',
            new Date(request.expiresAt).toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU'),
          )}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        {request.tradeOfferId && (
          <a
            href={`https://steamcommunity.com/tradeoffer/${request.tradeOfferId}/`}
            target="_blank"
            rel="noreferrer noopener"
            className="cf-btn-primary px-5 py-1.5"
          >
            {t('deposit.items.openOffer')}
          </a>
        )}
        {/* Only while nothing has moved. Once the bot holds the skins the
            player is owed money, and cancelling would mean keeping both. */}
        {(request.status === 'PENDING' || request.status === 'OFFER_SENT') && (
          <button
            onClick={() => void onCancel(request.id)}
            disabled={busy}
            className="cf-chip px-4 py-1.5"
          >
            {t('deposit.items.cancel')}
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {request.items.map((i) => (
          <div key={i.assetId} className="w-[92px]">
            <ItemImage src={i.imageUrl} alt={i.marketHashName} rarity={i.rarity} className="h-12" />
            <div className="truncate text-[10px] text-ink-faint" title={i.marketHashName}>
              {i.marketHashName}
            </div>
          </div>
        ))}
      </div>

      {request.failureReason && (
        <p className="text-sm text-negative">{request.failureReason}</p>
      )}
    </div>
  );
}
