'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  UPGRADE_RTP,
  calculateUpgradeOdds,
  translateError,
  type ItemRarity,
} from '@caseforge/shared';
import { api, ApiError, loginUrl } from '../../lib/api';
import { useAuth } from '../../lib/store';
import { useSettings } from '../../lib/settings';
import { ItemImage } from '../../components/ItemImage';
import { Money, useMoneyFormatter } from '../../components/Money';
import { RarityBadge, rarityColor } from '../../components/RarityBadge';
import { UpgradeGauge } from '../../components/UpgradeGauge';

interface StakeItem {
  inventoryItemId: string;
  marketHashName: string;
  name: string;
  imageUrl: string | null;
  rarity: ItemRarity;
  price: number;
}

interface TargetItem {
  itemId: string;
  marketHashName: string;
  name: string;
  imageUrl: string | null;
  rarity: ItemRarity;
  price: number;
  chance: number;
  multiplier: number;
}

interface TargetsResponse {
  total: number;
  priceRange: { min: number; max: number };
  items: TargetItem[];
}

interface UpgradeResult {
  upgradeId: string;
  isWin: boolean;
  chance: number;
  multiplier: number;
  roll: number;
  winThreshold: number;
  nonce: number;
  target: { name: string; imageUrl: string | null; rarity: ItemRarity; price: number };
  rewardInventoryItemId: string | null;
}

export default function UpgradePage() {
  const { user, loadUser } = useAuth();
  const { locale, t } = useSettings();
  const money = useMoneyFormatter();

  const [stakes, setStakes] = useState<StakeItem[]>([]);
  const [stake, setStake] = useState<StakeItem | null>(null);

  const [targets, setTargets] = useState<TargetsResponse | null>(null);
  const [target, setTarget] = useState<TargetItem | null>(null);
  const [search, setSearch] = useState('');

  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<UpgradeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStakes = useCallback(async () => {
    try {
      setStakes(await api<StakeItem[]>('/api/upgrade/stakes'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(t('upgrade.loadInventoryFailed'));
    }
  }, []);

  useEffect(() => {
    if (user) void loadStakes();
  }, [user, loadStakes]);

  // The target list depends on the stake price: the available range follows
  // from the same formula that computes the chance.
  useEffect(() => {
    if (!stake) {
      setTargets(null);
      setTarget(null);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({
      stakeValue: String(stake.price),
      perPage: '24',
      ...(search.trim() ? { search: search.trim() } : {}),
    });
    void api<TargetsResponse>(`/api/upgrade/targets?${params}`)
      .then((data) => {
        if (!cancelled) setTargets(data);
      })
      .catch(() => {
        if (!cancelled) setError(t('upgrade.loadTargetsFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [stake, search]);

  // The chance is computed client-side with the same function the server
  // uses — the player sees it before clicking, but the server still decides.
  const odds = stake && target ? calculateUpgradeOdds(stake.price, target.price) : null;

  async function run(): Promise<void> {
    if (!stake || !target) return;
    setSpinning(true);
    setError(null);
    setResult(null);
    try {
      const res = await api<UpgradeResult>('/api/upgrade', {
        method: 'POST',
        body: JSON.stringify({
          inventoryItemId: stake.inventoryItemId,
          targetItemId: target.itemId,
        }),
      });
      setResult(res);
    } catch (err) {
      setSpinning(false);
      setError(
        err instanceof ApiError
          ? translateError(locale, err.code, err.message)
          : t('upgrade.failed'),
      );
    }
  }

  /** Called by the needle once it has settled on its sector. */
  const handleSpinEnd = useCallback(() => {
    setSpinning(false);
    setStake(null);
    setTarget(null);
    void loadStakes();
    void loadUser();
  }, [loadStakes, loadUser]);

  if (!user) {
    return (
      <div className="space-y-4 text-center">
        <h1 className="text-2xl font-semibold">{t('upgrade.title')}</h1>
        <p className="text-ink-muted">{t('upgrade.signInHint')}</p>
        <a href={loginUrl} className="cf-btn-primary inline-block px-6 py-2.5">
          {t('nav.signIn')}
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">{t('upgrade.title')}</h1>
        <p className="mt-1 text-sm text-ink-faint">
          {t('upgrade.intro', { rtp: (UPGRADE_RTP * 100).toFixed(0) })}
        </p>
      </div>

      {error && <p className="rounded bg-negative/15 px-3 py-2 text-sm text-negative">{error}</p>}

      <section className="grid items-center gap-4 rounded-xl border border-edge-subtle bg-surface-raised/70 p-5 md:grid-cols-[1fr_auto_1fr]">
        <SlotCard label={t('upgrade.yourItem')} item={stake} emptyHint={t('upgrade.pickStake')} />

        <div className="flex flex-col items-center gap-3">
          <UpgradeGauge
            // After the spin the stake is gone and the slots are empty, but
            // the arc stays: otherwise the needle sits on a blank gauge and it
            // is impossible to tell whether it landed in the winning zone.
            chance={result ? result.chance : odds?.ok ? odds.chance : 0}
            spinning={spinning}
            result={
              result
                ? { isWin: result.isWin, roll: result.roll, threshold: result.winThreshold }
                : null
            }
            onSpinEnd={handleSpinEnd}
          />

          {odds && !odds.ok && (
            <p className="max-w-[240px] text-center text-xs text-accent">{odds.reason}</p>
          )}

          <button
            onClick={() => void run()}
            disabled={!stake || !target || !odds?.ok || spinning}
            className="cf-btn-primary px-8 py-2.5"
          >
            {spinning ? t('upgrade.spinning') : t('upgrade.run')}
          </button>

          {result && !spinning && (
            <p
              className={`text-sm font-medium ${result.isWin ? 'text-positive' : 'text-negative'}`}
            >
              {result.isWin
                ? t('upgrade.won', { item: result.target.name })
                : t('upgrade.lost', {
                    roll: result.roll.toLocaleString(locale),
                    threshold: result.winThreshold.toLocaleString(locale),
                  })}
            </p>
          )}
        </div>

        <SlotCard label={t('upgrade.target')} item={target} emptyHint={t('upgrade.pickTarget')} />
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="space-y-3 rounded-xl border border-edge-subtle bg-surface-raised/70 p-4">
          <h2 className="font-medium">{t('upgrade.myItems')}</h2>
          {stakes.length === 0 ? (
            <p className="text-sm text-ink-faint">{t('upgrade.emptyInventory')}</p>
          ) : (
            <div className="grid max-h-[420px] grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3">
              {stakes.map((item) => (
                <PickCard
                  key={item.inventoryItemId}
                  name={item.marketHashName}
                  imageUrl={item.imageUrl}
                  rarity={item.rarity}
                  price={item.price}
                  selected={stake?.inventoryItemId === item.inventoryItemId}
                  onClick={() => {
                    setStake(item);
                    setResult(null);
                  }}
                />
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3 rounded-xl border border-edge-subtle bg-surface-raised/70 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-medium">{t('upgrade.upgradeTo')}</h2>
            {targets && (
              <span className="text-xs text-ink-faint">
                {t('upgrade.available')} {money(targets.priceRange.min)} –{' '}
                {money(targets.priceRange.max)}
              </span>
            )}
          </div>

          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={!stake}
            placeholder={t('common.search')}
            className="w-full rounded bg-surface-overlay px-3 py-1.5 text-sm disabled:opacity-40"
          />

          {!stake ? (
            <p className="text-sm text-ink-faint">{t('upgrade.pickStakeFirst')}</p>
          ) : targets && targets.items.length === 0 ? (
            <p className="text-sm text-ink-faint">{t('upgrade.noTargets')}</p>
          ) : (
            <div className="grid max-h-[420px] grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3">
              {(targets?.items ?? []).map((item) => (
                <PickCard
                  key={item.itemId}
                  name={item.marketHashName}
                  imageUrl={item.imageUrl}
                  rarity={item.rarity}
                  price={item.price}
                  badge={`${(item.chance * 100).toFixed(1)}%`}
                  selected={target?.itemId === item.itemId}
                  onClick={() => {
                    setTarget(item);
                    setResult(null);
                  }}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function SlotCard({
  label,
  item,
  emptyHint,
}: {
  label: string;
  item: {
    marketHashName: string;
    imageUrl: string | null;
    rarity: ItemRarity;
    price: number;
  } | null;
  emptyHint: string;
}) {
  return (
    <div
      className="flex h-44 flex-col items-center justify-center rounded-lg border bg-surface-base p-3"
      style={{ borderColor: item ? rarityColor(item.rarity) : '#262626' }}
    >
      {item ? (
        <>
          <ItemImage
            src={item.imageUrl}
            alt={item.marketHashName}
            rarity={item.rarity}
            className="h-20 w-full"
          />
          <div className="mt-1 max-w-full truncate text-sm" title={item.marketHashName}>
            {item.marketHashName}
          </div>
          <Money value={item.price} className="text-sm text-accent" />
        </>
      ) : (
        <>
          <span className="text-xs uppercase tracking-wide text-ink-faint">{label}</span>
          <span className="mt-2 text-sm text-ink-faint">{emptyHint}</span>
        </>
      )}
    </div>
  );
}

function PickCard({
  name,
  imageUrl,
  rarity,
  price,
  badge,
  selected,
  onClick,
}: {
  name: string;
  imageUrl: string | null;
  rarity: ItemRarity;
  price: number;
  badge?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded border-t-2 bg-surface-base p-2 text-left transition ${
        selected ? 'ring-2 ring-accent' : 'hover:bg-surface-overlay'
      }`}
      style={{ borderTopColor: rarityColor(rarity) }}
    >
      <ItemImage src={imageUrl} alt={name} rarity={rarity} className="mb-1 h-14 w-full" />
      <div className="truncate text-[11px]" title={name}>
        {name}
      </div>
      <div className="flex items-center justify-between">
        <Money value={price} className="text-[11px] text-accent" />
        {badge && <span className="text-[11px] text-positive">{badge}</span>}
      </div>
      <div className="mt-1">
        <RarityBadge rarity={rarity} />
      </div>
    </button>
  );
}
