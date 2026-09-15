'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  type BonusKind,
  type ItemRarity,
  type TranslationKey,
  type WheelSlice,
  BonusKind as Kind,
  translateError,
} from '@caseforge/shared';
import { api, ApiError, loginUrl } from '../../lib/api';
import { useAuth } from '../../lib/store';
import { useSettings } from '../../lib/settings';
import { BonusWheel } from '../../components/BonusWheel';
import { ItemImage } from '../../components/ItemImage';
import { Money, useMoneyFormatter } from '../../components/Money';
import { rarityColor } from '../../components/RarityBadge';

interface Voucher {
  id: string;
  kind: BonusKind;
  segmentKey: string;
  value: number;
  createdAt: string;
}

interface BonusStatus {
  wheel: WheelSlice[];
  canSpin: boolean;
  lastSpinAt: string | null;
  nextSpinAt: string | null;
  vouchers: Voucher[];
}

interface SpinResult {
  bonusId: string;
  segmentKey: string;
  kind: BonusKind;
  value: number;
  roll: number;
  nonce: number;
  nextSpinAt: string;
  balance: number | null;
  item: {
    id: string;
    marketHashName: string;
    imageUrl: string | null;
    rarity: ItemRarity;
    price: number;
  } | null;
}

export default function BonusPage() {
  const { user, setBalance, loadUser } = useAuth();
  const { locale, t } = useSettings();
  const money = useMoneyFormatter();

  const [status, setStatus] = useState<BonusStatus | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [spinId, setSpinId] = useState(0);
  const [roll, setRoll] = useState<number | null>(null);
  const [revealed, setRevealed] = useState<SpinResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const pending = useState<{ current: SpinResult | null }>({ current: null })[0];

  const load = useCallback(async () => {
    try {
      setStatus(await api<BonusStatus>('/api/bonus'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(t('bonus.failed'));
    }
  }, [t]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  // The countdown ticks locally; only the deadline comes from the server, so a
  // clock that drifts cannot hand out an extra spin — the server still refuses.
  useEffect(() => {
    if (!status?.nextSpinAt || status.canSpin) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status?.nextSpinAt, status?.canSpin]);

  /** Prize label, built from the slice rather than from a per-slice string. */
  const labelFor = useCallback(
    (slice: { kind: BonusKind; value: number }): string => {
      switch (slice.kind) {
        case Kind.BALANCE:
          return t('bonus.prizeBalance', { amount: money(slice.value) });
        case Kind.DISCOUNT:
          return t('bonus.prizeDiscount', { percent: slice.value / 100 });
        case Kind.FREE_CASE:
          return t('bonus.prizeFreeCase', { max: money(slice.value) });
        case Kind.FREE_ITEM:
          return t('bonus.prizeFreeItem', { max: money(slice.value) });
        default:
          return '';
      }
    },
    [t, money],
  );

  async function spin(): Promise<void> {
    if (spinning || !status?.canSpin) return;
    setError(null);
    setRevealed(null);
    setSpinning(true);
    try {
      const res = await api<SpinResult>('/api/bonus/spin', { method: 'POST' });
      pending.current = res;
      setRoll(res.roll);
      setSpinId((n) => n + 1);
    } catch (err) {
      setSpinning(false);
      setError(
        err instanceof ApiError ? translateError(locale, err.code, err.message) : t('bonus.failed'),
      );
      void load();
    }
  }

  /** Called by the wheel once the pointer has settled. */
  const handleFinish = useCallback(() => {
    setSpinning(false);
    const result = pending.current;
    setRevealed(result);
    if (result?.balance !== null && result?.balance !== undefined) setBalance(result.balance);
    void load();
    void loadUser();
  }, [load, loadUser, setBalance, pending]);

  if (!user) {
    return (
      <div className="space-y-4 text-center">
        <h1 className="text-2xl font-semibold">{t('bonus.title')}</h1>
        <p className="text-ink-muted">{t('bonus.signInHint')}</p>
        <a href={loginUrl} className="cf-btn-primary inline-block px-6 py-2.5">
          {t('nav.signIn')}
        </a>
      </div>
    );
  }

  const remaining = status?.nextSpinAt ? new Date(status.nextSpinAt).getTime() - now : 0;
  const ready = status?.canSpin ?? false;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('bonus.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-muted">{t('bonus.intro')}</p>
      </div>

      {error && (
        <p className="rounded-lg bg-negative/15 px-3 py-2 text-sm text-negative">{error}</p>
      )}

      <section className="cf-panel p-6">
        {status && (
          <BonusWheel
            wheel={status.wheel}
            roll={roll}
            spinId={spinId}
            onFinish={handleFinish}
            labelFor={labelFor}
          />
        )}

        <div className="mt-6 flex flex-col items-center gap-3">
          <button
            onClick={() => void spin()}
            disabled={!ready || spinning}
            className="cf-btn-primary px-10 py-3"
          >
            {spinning ? t('bonus.spinning') : t('bonus.spin')}
          </button>

          <p className="text-sm text-ink-faint">
            {ready
              ? t('bonus.ready')
              : t('bonus.nextIn', { time: formatCountdown(Math.max(0, remaining)) })}
          </p>

          {revealed && !spinning && <Prize result={revealed} />}
        </div>
      </section>

      <section className="cf-panel p-5">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium">{t('bonus.vouchers')}</h2>
          <span className="text-xs text-ink-faint">{t('bonus.vouchersHint')}</span>
        </div>

        {!status || status.vouchers.length === 0 ? (
          <p className="py-4 text-sm text-ink-faint">{t('bonus.vouchersEmpty')}</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {status.vouchers.map((v) => (
              <span
                key={v.id}
                className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-sm font-medium text-accent"
              >
                {labelFor(v)}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="cf-panel p-5">
        <h2 className="mb-3 font-medium">{t('bonus.title')}</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(status?.wheel ?? []).map((slice) => (
            <div
              key={slice.key}
              className="rounded-lg border border-edge-subtle bg-surface-base/60 px-3 py-2"
            >
              <div className="truncate text-sm">{labelFor(slice)}</div>
              <div className="text-xs text-ink-faint">
                {(slice.chance * 100).toFixed(1)}% {t('bonus.chanceLabel')}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Prize({ result }: { result: SpinResult }) {
  const { t } = useSettings();
  const money = useMoneyFormatter();

  if (result.item) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-edge-subtle bg-surface-base/60 px-4 py-3">
        <ItemImage
          src={result.item.imageUrl}
          alt={result.item.marketHashName}
          rarity={result.item.rarity}
          className="h-12 w-16"
        />
        <span className="text-sm font-medium" style={{ color: rarityColor(result.item.rarity) }}>
          {t('bonus.wonItem', {
            item: result.item.marketHashName,
            price: money(result.item.price),
          })}
        </span>
      </div>
    );
  }

  const key: TranslationKey =
    result.kind === Kind.BALANCE
      ? 'bonus.wonBalance'
      : result.kind === Kind.DISCOUNT
        ? 'bonus.wonDiscount'
        : 'bonus.wonFreeCase';

  return (
    <p className="text-sm font-medium text-positive">
      {t(key, {
        amount: money(result.value),
        percent: result.value / 100,
        max: money(result.value),
      })}
    </p>
  );
}

/** hh:mm:ss remaining, which is the only format a day-long countdown needs. */
function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}
