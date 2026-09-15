'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type CaseItemView,
  type ItemRarity,
  CONTRACT_MAX_ITEMS,
  CONTRACT_MIN_ITEMS,
  CONTRACT_RTP,
  translateError,
} from '@caseforge/shared';
import { api, ApiError, loginUrl } from '../../lib/api';
import { useAuth } from '../../lib/store';
import { useSettings } from '../../lib/settings';
import { ItemImage } from '../../components/ItemImage';
import { Money, useMoneyFormatter } from '../../components/Money';
import { RarityBadge, rarityColor } from '../../components/RarityBadge';
import { Roulette } from '../../components/Roulette';

interface StakeItem {
  inventoryItemId: string;
  marketHashName: string;
  name: string;
  imageUrl: string | null;
  rarity: ItemRarity;
  price: number;
}

interface ContractPool {
  stakeValue: number;
  targetValue: number;
  rewardRange: { min: number; max: number };
  rtp: number;
  outcomes: CaseItemView[];
}

interface ContractResult extends ContractPool {
  contractId: string;
  roll: number;
  nonce: number;
  reward: CaseItemView;
  rewardInventoryItemId: string;
}

export default function ContractPage() {
  const { user, loadUser } = useAuth();
  const { locale, t } = useSettings();
  const money = useMoneyFormatter();

  const [inventory, setInventory] = useState<StakeItem[]>([]);
  const [picked, setPicked] = useState<string[]>([]);

  const [pool, setPool] = useState<ContractPool | null>(null);
  const [result, setResult] = useState<ContractResult | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [spinId, setSpinId] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // The reel plays the outcome the server already decided. Holding it aside
  // keeps the result text hidden until the strip has actually stopped on it.
  const [revealed, setRevealed] = useState<ContractResult | null>(null);
  const pendingRef = useRef<ContractResult | null>(null);

  const loadInventory = useCallback(async () => {
    try {
      setInventory(await api<StakeItem[]>('/api/contracts/stakes'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(t('contract.loadInventoryFailed'));
    }
  }, [t]);

  useEffect(() => {
    if (user) void loadInventory();
  }, [user, loadInventory]);

  const stake = inventory.filter((i) => picked.includes(i.inventoryItemId));
  const stakeValue = stake.reduce((sum, i) => sum + i.price, 0);
  const enough = picked.length >= CONTRACT_MIN_ITEMS;
  // A stake is on the table. Everything derived from it — the reward band, the
  // outcome table, the "add N more" nudge — hides once the contract is played
  // and the stake is consumed.
  const assembling = picked.length > 0;

  // The preview is the very table the roll will run against — the server
  // builds it with the same function it uses to play the contract, so what
  // the player reads here is not an estimate.
  useEffect(() => {
    if (!enough || spinning) return;
    let cancelled = false;
    const params = new URLSearchParams({ inventoryItemIds: picked.join(',') });
    void api<ContractPool>(`/api/contracts/preview?${params}`)
      .then((data) => {
        if (!cancelled) {
          setPool(data);
          setError(null);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setPool(null);
        setError(
          err instanceof ApiError
            ? translateError(locale, err.code, err.message)
            : t('contract.failed'),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [picked, enough, spinning, locale, t]);

  function toggle(id: string): void {
    if (spinning) return;
    setResult(null);
    setRevealed(null);
    setPicked((current) => {
      if (current.includes(id)) return current.filter((x) => x !== id);
      if (current.length >= CONTRACT_MAX_ITEMS) return current;
      return [...current, id];
    });
  }

  async function run(): Promise<void> {
    if (!enough || spinning) return;
    setError(null);
    setResult(null);
    setRevealed(null);
    setSpinning(true);
    try {
      const res = await api<ContractResult>('/api/contracts', {
        method: 'POST',
        body: JSON.stringify({ inventoryItemIds: picked }),
      });
      // The reel spins over the table the contract was actually played on,
      // not the previewed one: between the preview and the click a price sync
      // may have moved the pool.
      setPool(res);
      setResult(res);
      pendingRef.current = res;
      setSpinId((n) => n + 1);
    } catch (err) {
      setSpinning(false);
      setError(
        err instanceof ApiError
          ? translateError(locale, err.code, err.message)
          : t('contract.failed'),
      );
    }
  }

  /** Called by the reel once it has settled on the winning tile. */
  const handleFinish = useCallback(() => {
    setSpinning(false);
    setRevealed(pendingRef.current);
    setPicked([]);
    void loadInventory();
    void loadUser();
  }, [loadInventory, loadUser]);

  if (!user) {
    return (
      <div className="space-y-4 text-center">
        <h1 className="text-2xl font-semibold">{t('contract.title')}</h1>
        <p className="text-ink-muted">{t('contract.signInHint')}</p>
        <a href={loginUrl} className="cf-btn-primary inline-block px-6 py-2.5">
          {t('nav.signIn')}
        </a>
      </div>
    );
  }

  const profit = revealed ? revealed.reward.price - revealed.stakeValue : 0;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">{t('contract.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-faint">
          {t('contract.intro', {
            min: CONTRACT_MIN_ITEMS,
            max: CONTRACT_MAX_ITEMS,
            rtp: (CONTRACT_RTP * 100).toFixed(0),
          })}
        </p>
      </div>

      {error && <p className="rounded bg-negative/15 px-3 py-2 text-sm text-negative">{error}</p>}

      <section className="space-y-4 rounded-xl border border-edge-subtle bg-surface-raised/70 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium">
            {t('contract.stake')}{' '}
            <span className="text-ink-faint">
              {picked.length}/{CONTRACT_MAX_ITEMS}
            </span>
          </h2>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-ink-faint">{t('contract.stakeValue')}</span>
            <Money value={stakeValue} className="font-medium text-accent" />
            {picked.length > 0 && !spinning && (
              <button
                onClick={() => {
                  setPicked([]);
                  setResult(null);
                  setRevealed(null);
                }}
                className="text-ink-faint hover:text-ink-muted"
              >
                {t('contract.clearStake')}
              </button>
            )}
          </div>
        </div>

        {stake.length === 0 ? (
          <p className="text-sm text-ink-faint">
            {t('contract.stakeEmpty', { min: CONTRACT_MIN_ITEMS, max: CONTRACT_MAX_ITEMS })}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {stake.map((item) => (
              <button
                key={item.inventoryItemId}
                onClick={() => toggle(item.inventoryItemId)}
                disabled={spinning}
                title={item.marketHashName}
                className="w-[104px] rounded border-t-2 bg-surface-base p-2 text-left transition hover:bg-surface-overlay disabled:cursor-not-allowed"
                style={{ borderTopColor: rarityColor(item.rarity) }}
              >
                <ItemImage
                  src={item.imageUrl}
                  alt={item.marketHashName}
                  rarity={item.rarity}
                  className="mb-1 h-12 w-full"
                />
                <div className="truncate text-[10px]">{item.marketHashName}</div>
                <Money value={item.price} className="text-[11px] text-accent" />
              </button>
            ))}
          </div>
        )}

        {pool && (
          <div className="space-y-3 pt-2">
            {/* The reel is mounted only once there is an outcome to play back,
                the way the case opener does it: a strip with no winner has
                nothing to travel towards and would sit there as an empty box. */}
            {result && (
              <Roulette
                pool={pool.outcomes}
                winner={result.reward}
                spinId={spinId}
                onFinish={handleFinish}
              />
            )}
            {/* The band describes the stake currently on the table. Once the
                contract has been played the stake is gone, and leaving the
                line up would advertise a range for a contract that no longer
                exists — the result line says what was actually won. */}
            {assembling && (
              <p className="text-center text-xs text-ink-faint">
                {t('contract.rewardRange', {
                  min: money(pool.rewardRange.min),
                  max: money(pool.rewardRange.max),
                })}
              </p>
            )}
          </div>
        )}

        <div className="flex flex-col items-center gap-2">
          <button
            onClick={() => void run()}
            disabled={!enough || spinning}
            className="cf-btn-primary px-8 py-2.5"
          >
            {spinning ? t('contract.spinning') : t('contract.run')}
          </button>

          {assembling && !enough && (
            <p className="text-xs text-ink-faint">
              {t('contract.needMore', { count: CONTRACT_MIN_ITEMS - picked.length })}
            </p>
          )}

          {revealed && (
            <div className="text-center text-sm">
              <p className="font-medium text-ink-primary">
                {t('contract.result', {
                  item: revealed.reward.marketHashName,
                  price: money(revealed.reward.price),
                })}
              </p>
              <p className={profit >= 0 ? 'text-positive' : 'text-negative'}>
                {profit >= 0
                  ? t('contract.profit', { amount: money(profit) })
                  : t('contract.loss', { amount: money(-profit) })}
                <span className="ml-2 text-ink-faint">
                  {t('contract.roll')} {revealed.roll.toLocaleString(locale)}
                </span>
              </p>
            </div>
          )}
        </div>
      </section>

      {pool && assembling && (
        <section className="space-y-3 rounded-xl border border-edge-subtle bg-surface-raised/70 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-medium">{t('contract.outcomes')}</h2>
            <span className="text-xs text-ink-faint">{t('contract.outcomesHint')}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {[...pool.outcomes]
              .sort((a, b) => b.price - a.price)
              .map((outcome) => (
                <div
                  key={outcome.itemId}
                  className="rounded border-t-2 bg-surface-base p-2"
                  style={{ borderTopColor: rarityColor(outcome.rarity) }}
                >
                  <ItemImage
                    src={outcome.imageUrl}
                    alt={outcome.marketHashName}
                    rarity={outcome.rarity}
                    className="mb-1 h-14 w-full"
                  />
                  <div className="truncate text-[11px]" title={outcome.marketHashName}>
                    {outcome.marketHashName}
                  </div>
                  <div className="flex items-center justify-between">
                    <Money value={outcome.price} className="text-[11px] text-accent" />
                    <span className="text-[11px] text-positive">
                      {(outcome.chance * 100).toFixed(2)}%
                    </span>
                  </div>
                  <div className="mt-1">
                    <RarityBadge rarity={outcome.rarity} />
                  </div>
                </div>
              ))}
          </div>
        </section>
      )}

      <section className="space-y-3 rounded-xl border border-edge-subtle bg-surface-raised/70 p-4">
        <h2 className="font-medium">{t('contract.myItems')}</h2>
        {inventory.length === 0 ? (
          <p className="text-sm text-ink-faint">{t('contract.emptyInventory')}</p>
        ) : (
          <div className="grid max-h-[420px] grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-4 lg:grid-cols-6">
            {inventory.map((item) => {
              const selected = picked.includes(item.inventoryItemId);
              // A full contract greys out what is not already in it, rather
              // than silently ignoring the click.
              const blocked = !selected && picked.length >= CONTRACT_MAX_ITEMS;
              return (
                <button
                  key={item.inventoryItemId}
                  onClick={() => toggle(item.inventoryItemId)}
                  disabled={spinning || blocked}
                  title={
                    blocked
                      ? t('contract.tooMany', { max: CONTRACT_MAX_ITEMS })
                      : item.marketHashName
                  }
                  className={`rounded border-t-2 bg-surface-base p-2 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${
                    selected ? 'ring-2 ring-accent' : 'hover:bg-surface-overlay'
                  }`}
                  style={{ borderTopColor: rarityColor(item.rarity) }}
                >
                  <ItemImage
                    src={item.imageUrl}
                    alt={item.marketHashName}
                    rarity={item.rarity}
                    className="mb-1 h-14 w-full"
                  />
                  <div className="truncate text-[11px]" title={item.marketHashName}>
                    {item.marketHashName}
                  </div>
                  <Money value={item.price} className="text-[11px] text-accent" />
                  <div className="mt-1">
                    <RarityBadge rarity={item.rarity} />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
