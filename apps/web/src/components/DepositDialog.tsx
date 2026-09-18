'use client';

import { useState } from 'react';
import { DEPOSIT_PRESETS, translateError } from '@caseforge/shared';
import { api, ApiError } from '../lib/api';
import { AnalyticsEventType, track } from '../lib/analytics';
import { useAuth } from '../lib/store';
import { useSettings } from '../lib/settings';
import { useMoneyFormatter } from './Money';

/**
 * Balance top-up.
 *
 * Behind this button sits a stub: the server simply credits the entered
 * amount. A real flow looks different — an invoice is created at a payment
 * provider, the player is sent to its page, and the balance changes only on a
 * successful-payment webhook. The dialog says so honestly, otherwise wiring in
 * payments later would mean rewriting both the screen and the expectations.
 *
 * Amounts are entered in the settlement currency: the display currency is a
 * presentation choice, and letting someone type dollars that are credited as
 * roubles would be a genuine money bug.
 */
export function DepositDialog({ onClose }: { onClose: () => void }) {
  const { setBalance } = useAuth();
  const { locale, t } = useSettings();
  const money = useMoneyFormatter();
  const [amountMajor, setAmountMajor] = useState('500');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [promoDraft, setPromoDraft] = useState('');
  const [promo, setPromo] = useState<{ code: string; bonus: number } | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [checkingPromo, setCheckingPromo] = useState(false);

  const amountMinor = Math.round(Number.parseFloat(amountMajor.replace(',', '.')) * 100) || 0;
  const valid = amountMinor >= 100 && amountMinor <= 100_000_00;

  /**
   * Checks a code before the money moves.
   *
   * Only ever a quote: the server re-checks it inside the deposit, because
   * between this call and the button the code may be used up by somebody else.
   */
  async function applyPromo(): Promise<void> {
    const code = promoDraft.trim();
    if (code === '') return;
    // A code that was typed and refused is how a promotion is found to have
    // been mis-shared, and nothing in the database records an attempt.
    track(AnalyticsEventType.PROMO_TRIED, { code: code.slice(0, 32) });
    setCheckingPromo(true);
    setPromoError(null);
    try {
      const res = await api<{ code: string; bonus: number }>('/api/me/promo/preview', {
        method: 'POST',
        body: JSON.stringify({ amount: amountMinor, promoCode: code }),
      });
      setPromo(res);
    } catch (err) {
      setPromo(null);
      setPromoError(
        err instanceof ApiError
          ? translateError(locale, err.code, err.message)
          : t('promo.invalid'),
      );
    } finally {
      setCheckingPromo(false);
    }
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ balance: number }>('/api/me/deposit', {
        method: 'POST',
        body: JSON.stringify({ amount: amountMinor, promoCode: promo?.code ?? null }),
      });
      setBalance(res.balance);
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? translateError(locale, err.code, err.message)
          : t('deposit.failed'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-xl border border-edge-subtle bg-surface-raised p-6"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('deposit.title')}
      >
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-lg font-semibold">{t('deposit.title')}</h2>
          <button onClick={onClose} className="text-ink-faint hover:text-ink-muted">
            ✕
          </button>
        </div>

        <div className="mb-4 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent">
          {t('deposit.demoNotice')}
        </div>

        <div className="mb-3 grid grid-cols-3 gap-2">
          {DEPOSIT_PRESETS.map((preset) => (
            <button
              key={preset}
              onClick={() => setAmountMajor(String(preset / 100))}
              className={`rounded px-2 py-2 text-sm transition ${
                amountMinor === preset
                  ? 'bg-accent font-medium text-surface-base'
                  : 'bg-surface-overlay hover:bg-surface-hover'
              }`}
            >
              {money(preset)}
            </button>
          ))}
        </div>

        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-ink-faint">{t('deposit.customAmount')}</span>
          <input
            value={amountMajor}
            onChange={(e) => setAmountMajor(e.target.value)}
            inputMode="decimal"
            autoFocus
            className="w-full rounded bg-surface-overlay px-3 py-2"
          />
        </label>

        {!valid && amountMajor !== '' && (
          <p className="mb-3 text-sm text-negative">{t('deposit.amountRange')}</p>
        )}

        {/* The code is checked on its own rather than on submit, so a typo is
            caught before the player commits to a top-up. */}
        <div className="mb-3">
          <span className="mb-1 block text-sm text-ink-muted">{t('promo.label')}</span>
          <div className="flex gap-2">
            <input
              value={promoDraft}
              onChange={(e) => {
                setPromoDraft(e.target.value);
                setPromo(null);
                setPromoError(null);
              }}
              placeholder={t('promo.placeholder')}
              className="min-w-0 flex-1 rounded bg-surface-overlay px-3 py-2 uppercase"
            />
            <button
              onClick={() => void applyPromo()}
              disabled={promoDraft.trim() === '' || !valid || checkingPromo}
              className="cf-btn-ghost shrink-0 px-4 py-2 text-sm"
            >
              {t('promo.apply')}
            </button>
          </div>
          {promo && (
            <p className="mt-1.5 text-sm text-positive">
              {t('promo.applied', { code: promo.code, bonus: money(promo.bonus) })}
            </p>
          )}
          {promoError && <p className="mt-1.5 text-sm text-negative">{promoError}</p>}
        </div>

        {promo && (
          <p className="mb-3 text-sm text-ink-muted">
            {t('promo.total', { total: money(amountMinor + promo.bonus) })}
          </p>
        )}

        {error && <p className="mb-3 text-sm text-negative">{error}</p>}

        <button
          onClick={() => void submit()}
          disabled={!valid || busy}
          className="cf-btn-primary w-full py-2.5"
        >
          {busy ? t('deposit.processing') : `${t('deposit.submit')} ${money(amountMinor)}`}
        </button>
      </div>
    </div>
  );
}
