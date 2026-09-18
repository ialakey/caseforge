'use client';

import { useCallback, useEffect, useState } from 'react';
import type { GiveawayView, ItemRarity } from '@caseforge/shared';
import { api, ApiError } from '../../../lib/api';
import { useSettings } from '../../../lib/settings';
import { ItemImage } from '../../../components/ItemImage';
import { Money } from '../../../components/Money';

/** As `/api/admin/items` returns it — a raw catalogue row. */
interface CatalogueItem {
  id: string;
  name: string;
  marketHashName: string;
  imageUrl: string | null;
  rarity: ItemRarity;
  marketPrice: number;
  priceOverride: number | null;
}

/** A manual override beats the market, the same rule the rest of the site uses. */
function priceOf(item: CatalogueItem): number {
  return item.priceOverride ?? item.marketPrice;
}

/** Two hours from now, rounded, as a sensible default draw time. */
function defaultDraw(): string {
  const when = new Date(Date.now() + 2 * 60 * 60 * 1000);
  when.setSeconds(0, 0);
  return toLocalInput(when);
}

/** `datetime-local` wants a local-time string without a zone. */
function toLocalInput(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * Creating and calling off giveaways.
 *
 * The prize is picked from the catalogue rather than typed, because a giveaway
 * hands over a real item from a real inventory and a free-text name would be a
 * promise nothing could fulfil.
 *
 * Nothing here can influence the draw. The seed is generated on the server when
 * the giveaway is created and its hash is published at once — an operator who
 * could choose a seed could choose a winner, so this page is not offered the
 * chance.
 */
export default function AdminGiveawaysPage() {
  const { locale, t } = useSettings();

  const [rows, setRows] = useState<GiveawayView[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CatalogueItem[]>([]);
  const [picked, setPicked] = useState<CatalogueItem | null>(null);
  const [title, setTitle] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [minDepositMajor, setMinDepositMajor] = useState('1000');
  const [opensAt, setOpensAt] = useState(() => toLocalInput(new Date()));
  const [drawsAt, setDrawsAt] = useState(defaultDraw);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setRows(await api<GiveawayView[]>('/api/admin/giveaways'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Searched against the catalogue the site already carries, not against Steam:
  // a giveaway can only hand over an item that exists here, so offering one
  // that does not would be offering a prize nobody could receive.
  useEffect(() => {
    const needle = query.trim();
    if (needle.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void api<{ items: CatalogueItem[] }>(
        `/api/admin/items?search=${encodeURIComponent(needle)}&perPage=8`,
      )
        .then((data) => {
          if (!cancelled) setResults(data.items);
        })
        .catch(() => setResults([]));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  async function create(): Promise<void> {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await api<GiveawayView>('/api/admin/giveaways', {
        method: 'POST',
        body: JSON.stringify({
          itemId: picked.id,
          title: title.trim() || picked.name,
          titleEn: titleEn.trim() === '' ? null : titleEn.trim(),
          minDeposit:
            Math.round(Number.parseFloat(minDepositMajor.replace(',', '.')) * 100) || 0,
          opensAt: new Date(opensAt).toISOString(),
          drawsAt: new Date(drawsAt).toISOString(),
        }),
      });
      setPicked(null);
      setQuery('');
      setTitle('');
      setTitleEn('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string): Promise<void> {
    setBusy(true);
    try {
      await api(`/api/admin/giveaways/${id}/cancel`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">{t('admin.giveaways.title')}</h1>
        <p className="mt-1 max-w-4xl text-sm text-neutral-500">{t('admin.giveaways.hint')}</p>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <section className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <h2 className="font-medium">{t('admin.giveaways.create')}</h2>

        <label className="block text-sm">
          <span className="mb-1 block text-neutral-500">{t('admin.giveaways.prize')}</span>
          {picked ? (
            <div className="flex items-center gap-3 rounded bg-neutral-800 p-2">
              <ItemImage
                src={picked.imageUrl}
                alt={picked.name}
                rarity={picked.rarity}
                className="h-10 w-14 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate">{picked.name}</span>
              <Money value={priceOf(picked)} className="text-accent" />
              <button
                onClick={() => setPicked(null)}
                className="rounded bg-neutral-700 px-2 py-1 text-xs hover:bg-neutral-600"
              >
                ×
              </button>
            </div>
          ) : (
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('admin.giveaways.pickItem')}
              className="w-full rounded bg-neutral-800 px-3 py-2"
            />
          )}
        </label>

        {!picked && results.length > 0 && (
          <ul className="divide-y divide-neutral-800 rounded border border-neutral-800">
            {results.map((item) => (
              <li key={item.id}>
                <button
                  onClick={() => setPicked(item)}
                  className="flex w-full items-center gap-3 p-2 text-left text-sm hover:bg-neutral-800"
                >
                  <ItemImage
                    src={item.imageUrl}
                    alt={item.name}
                    rarity={item.rarity}
                    className="h-8 w-12 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  <Money value={priceOf(item)} className="text-accent" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t('admin.giveaways.name')}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={picked?.name ?? ''}
              className="w-full rounded bg-neutral-800 px-2 py-1.5"
            />
          </Field>
          <Field label={`${t('admin.giveaways.name')} (EN)`}>
            <input
              value={titleEn}
              onChange={(e) => setTitleEn(e.target.value)}
              className="w-full rounded bg-neutral-800 px-2 py-1.5"
            />
          </Field>
          <Field label={t('admin.giveaways.minDeposit')}>
            <input
              value={minDepositMajor}
              onChange={(e) => setMinDepositMajor(e.target.value)}
              inputMode="decimal"
              className="w-full rounded bg-neutral-800 px-2 py-1.5"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('admin.giveaways.opensAt')}>
              <input
                type="datetime-local"
                value={opensAt}
                onChange={(e) => setOpensAt(e.target.value)}
                className="w-full rounded bg-neutral-800 px-2 py-1.5"
              />
            </Field>
            <Field label={t('admin.giveaways.drawsAt')}>
              <input
                type="datetime-local"
                value={drawsAt}
                onChange={(e) => setDrawsAt(e.target.value)}
                className="w-full rounded bg-neutral-800 px-2 py-1.5"
              />
            </Field>
          </div>
        </div>

        <button
          onClick={() => void create()}
          disabled={busy || !picked}
          className="rounded bg-amber-500 px-5 py-2 text-sm font-medium text-neutral-900 hover:bg-amber-400 disabled:opacity-40"
        >
          {t('admin.giveaways.create')}
        </button>
      </section>

      {rows.length === 0 ? (
        <p className="text-neutral-400">{t('admin.giveaways.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900 text-left text-neutral-400">
              <tr>
                <Th>{t('admin.giveaways.prize')}</Th>
                <Th>{t('admin.giveaways.minDeposit')}</Th>
                <Th>{t('admin.giveaways.drawsAt')}</Th>
                <Th>{t('giveaway.entrants')}</Th>
                <Th>{t('admin.finance.status')}</Th>
                <Th> </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-neutral-800">
                  <Td>
                    <div className="truncate" title={row.prize.itemName}>
                      {row.prize.itemName}
                    </div>
                    <Money value={row.prize.price} className="text-xs text-accent" />
                  </Td>
                  <Td>
                    <Money value={row.minDeposit} />
                  </Td>
                  <Td>
                    {new Date(row.drawsAt).toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU')}
                  </Td>
                  <Td>{row.entryCount}</Td>
                  <Td>
                    <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-xs">
                      {row.status}
                    </span>
                    {row.winner && (
                      <div className="mt-0.5 text-xs text-emerald-400">{row.winner.username}</div>
                    )}
                  </Td>
                  <Td>
                    {(row.status === 'SCHEDULED' || row.status === 'OPEN') && (
                      <button
                        onClick={() => void cancel(row.id)}
                        disabled={busy}
                        className="rounded bg-neutral-800 px-3 py-1 text-xs hover:bg-neutral-700 disabled:opacity-40"
                      >
                        {t('admin.giveaways.cancel')}
                      </button>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2">{children}</td>;
}
