'use client';

import { useCallback, useRef, useState } from 'react';
import {
  OPEN_COUNT_PRESETS,
  localizedName,
  translateError,
  type CaseView,
  type OpenCaseBatchResult,
} from '@caseforge/shared';
import { api, ApiError, loginUrl } from '../lib/api';
import { useAuth } from '../lib/store';
import { useSettings } from '../lib/settings';
import { DropResults } from './DropResults';
import { ItemImage } from './ItemImage';
import { Money, useMoneyFormatter } from './Money';
import { RarityBadge, rarityColor } from './RarityBadge';
import { Roulette } from './Roulette';

export function CaseOpener({ gameCase }: { gameCase: CaseView }) {
  const { user, setBalance } = useAuth();
  const { locale, t } = useSettings();
  const money = useMoneyFormatter();
  const title = localizedName(locale, gameCase);
  const [count, setCount] = useState(1);
  const [batch, setBatch] = useState<OpenCaseBatchResult | null>(null);
  const [spinId, setSpinId] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * There can be up to ten reels, each reporting its own stop. Results appear
   * once the last one has reported, otherwise the panel pops up over strips
   * that are still spinning.
   */
  const finishedRef = useRef(0);

  const totalPrice = gameCase.price * count;
  const notEnough = user !== null && user.balance < totalPrice;
  const busy = requesting || spinning;

  async function open(): Promise<void> {
    setRequesting(true);
    setError(null);
    setBatch(null);
    try {
      const result = await api<OpenCaseBatchResult>('/api/cases/open', {
        method: 'POST',
        body: JSON.stringify({ caseId: gameCase.id, count }),
      });

      // The server already debited the balance — show it without waiting for the reels.
      setBalance(result.balanceAfter);

      finishedRef.current = 0;
      setBatch(result);
      setSpinId((id) => id + 1);
      setSpinning(true);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? translateError(locale, err.code, err.message)
          : t('case.openFailed'),
      );
    } finally {
      setRequesting(false);
    }
  }

  const handleReelFinish = useCallback(() => {
    finishedRef.current += 1;
    setBatch((current) => {
      if (current && finishedRef.current >= current.openings.length) setSpinning(false);
      return current;
    });
  }, []);

  // Pricey items first: that is what sells the case.
  const showcase = [...gameCase.items].sort((a, b) => b.price - a.price);
  const single = batch?.openings.length === 1;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-4">
        {gameCase.imageUrl && (
          <img src={gameCase.imageUrl} alt={title} className="h-16 w-20 object-contain" />
        )}
        <h1 className="text-2xl font-semibold">{title}</h1>
        <Money value={gameCase.price} className="text-lg text-accent" />
      </div>

      <div className="rounded-xl border border-edge-subtle bg-surface-raised/70 p-4 md:p-6">
        {batch ? (
          single ? (
            <Roulette
              pool={gameCase.items}
              winner={batch.openings[0]!.item}
              spinId={spinId}
              orientation="horizontal"
              onFinish={handleReelFinish}
            />
          ) : (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {batch.openings.map((opening, i) => (
                <div key={opening.openingId} className="min-w-[92px] flex-1">
                  <Roulette
                    pool={gameCase.items}
                    winner={opening.item}
                    spinId={spinId}
                    orientation="vertical"
                    index={i}
                    onFinish={handleReelFinish}
                  />
                </div>
              ))}
            </div>
          )
        ) : (
          <p className="py-16 text-center text-ink-faint">{t('case.openHint')}</p>
        )}

        {batch && !spinning && (
          <div className="mt-6">
            <DropResults openings={batch.openings} spent={batch.totalSpent} />
          </div>
        )}

        <div className="mt-6 flex flex-col items-center gap-3">
          {/* Quantity picker: up to ten cases at once */}
          <div className="flex gap-1.5">
            {OPEN_COUNT_PRESETS.map((preset) => (
              <button
                key={preset}
                onClick={() => setCount(preset)}
                disabled={busy}
                className={`w-12 rounded py-1.5 text-sm font-medium transition disabled:opacity-40 ${
                  count === preset
                    ? 'bg-accent text-surface-base'
                    : 'bg-surface-overlay text-ink-muted hover:bg-surface-hover'
                }`}
              >
                ×{preset}
              </button>
            ))}
          </div>

          {user ? (
            <button
              onClick={open}
              disabled={busy || notEnough}
              className="cf-btn-primary px-10 py-3"
            >
              {spinning
                ? t('case.spinning')
                : requesting
                  ? t('case.opening')
                  : `${t('case.open')} ${count > 1 ? `x${count} ` : ''}${money(totalPrice)}`}
            </button>
          ) : (
            <a href={loginUrl} className="cf-btn-primary px-10 py-3">
              {t('nav.signIn')}
            </a>
          )}

          {notEnough && <p className="text-sm text-negative">{t('common.notEnoughFunds')}</p>}
          {error && <p className="text-sm text-negative">{error}</p>}

          {batch && !spinning && (
            <p className="text-center text-xs text-ink-faint">
              {batch.openings.length === 1
                ? `${t('case.roll')} ${batch.openings[0]!.roll.toLocaleString(locale)} · nonce ${batch.openings[0]!.nonce}`
                : `nonce ${batch.openings[0]!.nonce}–${batch.openings[batch.openings.length - 1]!.nonce}`}
              {' · '}
              {t('case.verifyHint')}
            </p>
          )}
        </div>
      </div>

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-ink-faint">
          {t('case.contents')}
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {showcase.map((item) => (
            <div
              key={item.id}
              className="rounded-lg border-t-2 bg-surface-raised p-3"
              style={{ borderTopColor: rarityColor(item.rarity) }}
            >
              <ItemImage
                src={item.imageUrl}
                alt={item.marketHashName}
                rarity={item.rarity}
                className="mb-2 h-20 w-full"
              />
              <RarityBadge rarity={item.rarity} />
              <div className="mt-2 truncate text-sm" title={item.marketHashName}>
                {item.marketHashName}
              </div>
              <div className="mt-1 flex items-center justify-between text-xs">
                <Money value={item.price} className="text-accent" />
                <span className="text-ink-faint">{(item.chance * 100).toFixed(2)}%</span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
