'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  RTP_CORRIDOR,
  TICKET_SPACE,
  autoBalance,
  translateDomainMessage,
  calculateRtp,
  judgeRtp,
  suggestCasePrice,
  type ItemRarity,
  type SteamMarketItem,
} from '@caseforge/shared';
import { api, ApiError } from '../../../../lib/api';
import { useSettings } from '../../../../lib/settings';
import { useAuth } from '../../../../lib/store';
import { ItemImage } from '../../../../components/ItemImage';
import { Money } from '../../../../components/Money';
import { RarityBadge } from '../../../../components/RarityBadge';

interface BuilderItem {
  itemId: string;
  marketHashName: string;
  name: string;
  imageUrl: string | null;
  rarity: ItemRarity;
  price: number;
  priceUpdatedAt: string | null;
  rangeFrom: number;
  rangeTo: number;
}

interface LoadedCase {
  slug: string;
  name: string;
  nameEn: string | null;
  price: number;
  imageUrl: string | null;
  isActive: boolean;
  sortOrder: number;
  items: BuilderItem[];
}

interface ImportedItem {
  id: string;
  marketHashName: string;
  name: string;
  imageUrl: string | null;
  rarity: ItemRarity;
  marketPrice: number;
  priceOverride: number | null;
  priceUpdatedAt: string | null;
}

const DEFAULT_TARGET_RTP = 90;

export default function CaseBuilderPage() {
  const router = useRouter();
  const params = useParams<{ slug: string }>();
  const isNew = params.slug === 'new';
  const { user } = useAuth();
  const { t, locale } = useSettings();

  const [slug, setSlug] = useState(isNew ? '' : params.slug);
  const [name, setName] = useState('');
  const [priceMajor, setPriceMajor] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [sortOrder, setSortOrder] = useState(0);
  const [imageUrl, setImageUrl] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [items, setItems] = useState<BuilderItem[]>([]);

  const [targetRtp, setTargetRtp] = useState(DEFAULT_TARGET_RTP);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SteamMarketItem[]>([]);
  const [addingName, setAddingName] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(isNew);

  useEffect(() => {
    if (!user || isNew) return;
    void api<LoadedCase>(`/api/admin/cases/${params.slug}`)
      .then((data) => {
        setSlug(data.slug);
        setName(data.name);
        setNameEn(data.nameEn ?? '');
        setPriceMajor((data.price / 100).toFixed(2));
        setIsActive(data.isActive);
        setSortOrder(data.sortOrder);
        setImageUrl(data.imageUrl ?? '');
        setItems(data.items);
        setLoaded(true);
      })
      .catch(() => setError(t('admin.case.loadFailed')));
  }, [user, isNew, params.slug]);

  const priceMinor = Math.round(Number.parseFloat(priceMajor.replace(',', '.')) * 100) || 0;

  // The same computation the server runs on save: the operator sees the
  // verdict up front, but the server still decides.
  const rtp = items.length > 0 && priceMinor > 0 ? calculateRtp(items, priceMinor) : 0;
  const verdict = judgeRtp(rtp);
  const coverage = items.reduce((sum, i) => sum + (i.rangeTo - i.rangeFrom + 1), 0);
  const coverageOk = items.length > 0 && coverage === TICKET_SPACE;
  const itemsWithoutPrice = items.filter((i) => i.price <= 0);
  // There is a price, but Steam never confirmed it: the number is invented
  // while its weight in the RTP is real.
  const unconfirmed = items.filter((i) => i.price > 0 && i.priceUpdatedAt === null);

  const runSearch = useCallback(async () => {
    if (query.trim().length < 2) return;
    setSearching(true);
    setError(null);
    try {
      setSearchResults(
        await api<SteamMarketItem[]>(
          `/api/admin/steam/search?query=${encodeURIComponent(query.trim())}&count=20`,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.case.searchFailed'));
    } finally {
      setSearching(false);
    }
  }, [query]);

  /**
   * Adding an item: first import it into the catalogue (which also pulls the
   * image, rarity and current price from Steam), then add it to the case with
   * an empty range — auto-balance lays out the odds.
   */
  async function addItem(marketHashName: string): Promise<void> {
    if (items.some((i) => i.marketHashName === marketHashName)) {
      setError(t('admin.case.alreadyInCase'));
      return;
    }
    setAddingName(marketHashName);
    setError(null);
    try {
      const res = await api<{ items: ImportedItem[]; failed: Array<{ reason: string }> }>(
        '/api/admin/items/import',
        { method: 'POST', body: JSON.stringify({ marketHashNames: [marketHashName] }) },
      );
      const imported = res.items[0];
      if (!imported) {
        setError(res.failed[0]?.reason ?? t('admin.case.notImported'));
        return;
      }

      setItems((prev) => [
        ...prev,
        {
          itemId: imported.id,
          marketHashName: imported.marketHashName,
          name: imported.name,
          imageUrl: imported.imageUrl,
          rarity: imported.rarity,
          price: imported.priceOverride ?? imported.marketPrice,
          priceUpdatedAt: imported.priceUpdatedAt,
          rangeFrom: 0,
          rangeTo: 0,
        },
      ]);
      setNotice(`Added: ${imported.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.case.addFailed'));
    } finally {
      setAddingName(null);
    }
  }

  function removeItem(itemId: string): void {
    setItems((prev) => prev.filter((i) => i.itemId !== itemId));
  }

  /** Default case image: the picture of the priciest item. */
  function useTopItemImage(): void {
    const withImage = items.filter((i) => i.imageUrl);
    if (withImage.length === 0) {
      setError(t('admin.case.noImage'));
      return;
    }
    const top = withImage.reduce((a, b) => (a.price > b.price ? a : b));
    setImageUrl(top.imageUrl!);
    setNotice(t('admin.case.imageFrom', { name: top.name }));
  }

  /** Lay out the odds for the target RTP. */
  function balance(): void {
    setError(null);
    setNotice(null);

    if (priceMinor <= 0) {
      setError(t('admin.case.setPriceFirst'));
      return;
    }

    const outcome = autoBalance(items, priceMinor, targetRtp / 100);
    if (!outcome.ok) {
      // The solver ships a code with its parameters alongside the English
      // sentence; one of those parameters is itself a code.
      setError(
        translateDomainMessage(
          locale,
          outcome.code,
          {
            ...outcome.params,
            direction: translateDomainMessage(
              locale,
              String(outcome.params.directionCode ?? ''),
              {},
              String(outcome.params.direction ?? ''),
            ),
          },
          outcome.reason,
        ),
      );
      return;
    }

    setItems((prev) =>
      prev.map((item, index) => ({
        ...item,
        rangeFrom: outcome.ranges[index]!.rangeFrom,
        rangeTo: outcome.ranges[index]!.rangeTo,
      })),
    );
    setNotice(
      t('admin.case.oddsDone', { rtp: (outcome.actualRtp * 100).toFixed(2) }) +
        t('admin.case.pricierLower'),
    );
  }

  /** Fit the case price to the target RTP given the odds already set. */
  function fitPrice(): void {
    setError(null);
    if (!coverageOk) {
      setError(t('admin.case.layoutFirst'));
      return;
    }
    const suggested = suggestCasePrice(items, targetRtp / 100);
    setPriceMajor((suggested / 100).toFixed(2));
    setNotice(t('admin.case.priceFitted', { rtp: targetRtp }));
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api('/api/admin/cases', {
        method: 'POST',
        body: JSON.stringify({
          slug,
          name,
          nameEn: nameEn.trim() === '' ? null : nameEn.trim(),
          price: priceMinor,
          imageUrl: imageUrl.trim() === '' ? null : imageUrl.trim(),
          isActive,
          sortOrder,
          items: items.map((i) => ({
            itemId: i.itemId,
            rangeFrom: i.rangeFrom,
            rangeTo: i.rangeTo,
          })),
        }),
      });
      router.push('/admin/cases');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('admin.case.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  if (!user) return <p className="text-neutral-400">Sign in through Steam.</p>;
  if (!loaded) return <p className="text-neutral-400">Loading...</p>;

  const canSave =
    slug.length >= 2 &&
    name.length >= 2 &&
    priceMinor > 0 &&
    coverageOk &&
    verdict.allowed &&
    itemsWithoutPrice.length === 0;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">
        {isNew ? t('admin.case.new') : t('admin.case.title', { name })}
      </h1>

      {error && <p className="rounded bg-red-950/60 px-3 py-2 text-sm text-red-300">{error}</p>}
      {notice && (
        <p className="rounded bg-emerald-950/60 px-3 py-2 text-sm text-emerald-300">{notice}</p>
      )}

      <section className="grid gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4 md:grid-cols-5">
        <label className="text-sm">
          <span className="mb-1 block text-neutral-500">{t('admin.case.nameRu')}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded bg-neutral-800 px-2 py-1.5"
            placeholder="Dragon Lair"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-500">{t('admin.case.nameEn')}</span>
          <input
            value={nameEn}
            onChange={(e) => setNameEn(e.target.value)}
            className="w-full rounded bg-neutral-800 px-2 py-1.5"
            placeholder="Dragon Lair"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-500">{t('admin.case.slug')}</span>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            disabled={!isNew}
            className="w-full rounded bg-neutral-800 px-2 py-1.5 disabled:opacity-50"
            placeholder="dragon"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-500">{t('admin.case.price')}</span>
          <input
            value={priceMajor}
            onChange={(e) => setPriceMajor(e.target.value)}
            inputMode="decimal"
            className="w-full rounded bg-neutral-800 px-2 py-1.5"
            placeholder="608.85"
          />
        </label>
        <div className="flex items-end gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            <span>{t('admin.active')}</span>
          </label>
          <label>
            <span className="mb-1 block text-neutral-500">{t('admin.case.order')}</span>
            <input
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
              className="w-20 rounded bg-neutral-800 px-2 py-1.5"
            />
          </label>
        </div>
      </section>

      <section className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <h2 className="font-medium">{t('admin.case.imageTitle')}</h2>
        <p className="text-sm text-neutral-500">{t('admin.case.imageHint')}</p>
        <div className="flex flex-wrap items-start gap-3">
          <div className="h-24 w-32 shrink-0 overflow-hidden rounded border border-neutral-800 bg-neutral-950">
            {imageUrl.trim() === '' ? (
              <div className="flex h-full items-center justify-center text-3xl opacity-40">📦</div>
            ) : (
              <img src={imageUrl} alt="Case image" className="h-full w-full object-contain p-1" />
            )}
          </div>
          <div className="min-w-[260px] flex-1 space-y-2">
            <input
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              placeholder="https://... (image URL)"
              className="w-full rounded bg-neutral-800 px-3 py-2 text-sm"
            />
            <div className="flex flex-wrap gap-2">
              <button
                onClick={useTopItemImage}
                disabled={items.length === 0}
                className="rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700 disabled:opacity-40"
              >
                {t('admin.case.useTopImage')}
              </button>
              {imageUrl !== '' && (
                <button
                  onClick={() => setImageUrl('')}
                  className="rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700"
                >
                  {t('common.clear')}
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <h2 className="font-medium">{t('admin.case.balanceTitle')}</h2>
        <p className="text-sm text-neutral-500">
          {t('admin.case.balanceHint', {
            min: (RTP_CORRIDOR.min * 100).toFixed(0),
            max: (RTP_CORRIDOR.max * 100).toFixed(0),
          })}
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-neutral-500">{t('admin.case.targetRtp')}</span>
            <input
              type="number"
              min={50}
              max={98}
              step={0.5}
              value={targetRtp}
              onChange={(e) => setTargetRtp(Number(e.target.value) || DEFAULT_TARGET_RTP)}
              className="w-24 rounded bg-neutral-800 px-2 py-1.5"
            />
          </label>
          <button
            onClick={balance}
            disabled={items.length === 0}
            className="rounded bg-amber-500 px-3 py-1.5 text-sm font-medium text-neutral-950 hover:bg-amber-400 disabled:opacity-40"
          >
            {t('admin.case.solveOdds')}
          </button>
          <button
            onClick={fitPrice}
            disabled={items.length === 0}
            className="rounded bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700 disabled:opacity-40"
          >
            {t('admin.case.fitPrice')}
          </button>
        </div>

        <div className="flex flex-wrap gap-6 text-sm">
          <div>
            <span className="text-neutral-500">{t('admin.case.currentRtp')}</span>
            <span
              className={
                !verdict.allowed
                  ? 'font-medium text-red-400'
                  : verdict.healthy
                    ? 'font-medium text-emerald-400'
                    : 'font-medium text-amber-400'
              }
            >
              {(rtp * 100).toFixed(2)}%
            </span>
          </div>
          <div>
            <span className="text-neutral-500">{t('admin.case.margin')}</span>
            <span className={rtp < 1 ? 'text-emerald-400' : 'text-red-400'}>
              {((1 - rtp) * 100).toFixed(2)}%
            </span>
          </div>
          <div>
            <span className="text-neutral-500">{t('admin.case.coverage')}</span>
            <span className={coverageOk ? 'text-emerald-400' : 'text-red-400'}>
              {coverage.toLocaleString(locale)} / {TICKET_SPACE.toLocaleString(locale)}
            </span>
          </div>
        </div>

        {items.length > 0 && (
          <p className="text-sm text-neutral-400">
            {translateDomainMessage(locale, verdict.code, verdict.params, verdict.message)}
          </p>
        )}
        {unconfirmed.length > 0 && (
          <p className="text-sm text-amber-400">
            {t('admin.case.unconfirmed', { names: unconfirmed.map((i) => i.name).join(', ') })}
          </p>
        )}
        {itemsWithoutPrice.length > 0 && (
          <p className="text-sm text-red-400">
            {t('admin.case.noPriceList', {
              names: itemsWithoutPrice.map((i) => i.name).join(', '),
            })}
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">{t('admin.case.contents', { count: items.length })}</h2>
        {items.length === 0 ? (
          <p className="text-sm text-neutral-500">{t('admin.case.addFromSearch')}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-900 text-xs uppercase text-neutral-500">
                <tr>
                  <th className="px-3 py-2">{t('admin.case.item')}</th>
                  <th className="px-3 py-2">{t('admin.case.rarity')}</th>
                  <th className="px-3 py-2">{t('admin.cases.price')}</th>
                  <th className="px-3 py-2">{t('admin.case.chance')}</th>
                  <th className="px-3 py-2">{t('admin.case.tickets')}</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const chance = (item.rangeTo - item.rangeFrom + 1) / TICKET_SPACE;
                  const hasRange = item.rangeTo > item.rangeFrom || item.rangeFrom > 0;
                  return (
                    <tr key={item.itemId} className="border-t border-neutral-800">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <ItemImage
                            src={item.imageUrl}
                            alt={item.name}
                            rarity={item.rarity}
                            className="h-10 w-14 shrink-0"
                          />
                          <span className="truncate">{item.marketHashName}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <RarityBadge rarity={item.rarity} />
                      </td>
                      <td className="px-3 py-2">
                        {item.price > 0 ? (
                          <Money value={item.price} className="text-amber-400" />
                        ) : (
                          <span className="text-red-400">{t('admin.case.noPrice')}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-neutral-400">
                        {hasRange ? `${(chance * 100).toFixed(3)}%` : '—'}
                      </td>
                      <td className="px-3 py-2 text-xs text-neutral-600">
                        {hasRange
                          ? `${item.rangeFrom.toLocaleString(locale)}–${item.rangeTo.toLocaleString(locale)}`
                          : t('admin.case.notLaidOut')}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => removeItem(item.itemId)}
                          className="text-neutral-500 hover:text-red-400"
                        >
                          {t('common.remove')}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <h2 className="font-medium">{t('admin.case.searchSteam')}</h2>
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch();
            }}
            placeholder="AWP Asiimov"
            className="flex-1 rounded bg-neutral-800 px-3 py-1.5 text-sm"
          />
          <button
            onClick={() => void runSearch()}
            disabled={searching || query.trim().length < 2}
            className="rounded bg-neutral-800 px-4 py-1.5 text-sm hover:bg-neutral-700 disabled:opacity-40"
          >
            {searching ? t('admin.case.searching') : t('admin.case.search')}
          </button>
        </div>
        <p className="text-xs text-neutral-600">{t('admin.case.searchHint')}</p>

        {searchResults.length > 0 && (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {searchResults.map((found) => {
              const already = items.some((i) => i.marketHashName === found.marketHashName);
              return (
                <div
                  key={found.marketHashName}
                  className="rounded border border-neutral-800 bg-neutral-950 p-2"
                >
                  <ItemImage
                    src={found.imageUrl}
                    alt={found.name}
                    rarity={found.rarity}
                    className="mb-2 h-16 w-full"
                  />
                  <div className="truncate text-xs" title={found.marketHashName}>
                    {found.marketHashName}
                  </div>
                  <div className="mt-1 text-[11px] text-neutral-500">
                    ~${((found.referencePriceUsd ?? 0) / 100).toFixed(2)} · {found.listings}{' '}
                    {t('admin.case.listings')}
                  </div>
                  <button
                    onClick={() => void addItem(found.marketHashName)}
                    disabled={already || addingName === found.marketHashName}
                    className="mt-2 w-full rounded bg-neutral-800 py-1 text-xs hover:bg-neutral-700 disabled:opacity-40"
                  >
                    {already
                      ? t('admin.case.alreadyIn')
                      : addingName === found.marketHashName
                        ? t('admin.case.adding')
                        : t('admin.case.add')}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={!canSave || saving}
          className="rounded-lg bg-amber-500 px-6 py-2.5 font-semibold text-neutral-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? t('admin.saving') : t('admin.case.saveCase')}
        </button>
        {!canSave && items.length > 0 && (
          <span className="text-sm text-neutral-500">
            {!coverageOk
              ? t('admin.case.layoutOdds')
              : !verdict.allowed
                ? t('admin.case.rtpAboveCap')
                : itemsWithoutPrice.length > 0
                  ? t('admin.case.someNoPrice')
                  : t('admin.case.fillRequired')}
          </span>
        )}
      </div>
    </div>
  );
}
