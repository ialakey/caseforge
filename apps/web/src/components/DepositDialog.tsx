'use client';

import { useState } from 'react';
import { DEPOSIT_PRESETS, translateError } from '@caseforge/shared';
import { api, ApiError } from '../lib/api';
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

  const amountMinor = Math.round(Number.parseFloat(amountMajor.replace(',', '.')) * 100) || 0;
  const valid = amountMinor >= 100 && amountMinor <= 100_000_00;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ balance: number }>('/api/me/deposit', {
        method: 'POST',
        body: JSON.stringify({ amount: amountMinor }),
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
        className="w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-900 p-6"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('deposit.title')}
      >
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-lg font-semibold">{t('deposit.title')}</h2>
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-300">
            ✕
          </button>
        </div>

        <div className="mb-4 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {t('deposit.demoNotice')}
        </div>

        <div className="mb-3 grid grid-cols-3 gap-2">
          {DEPOSIT_PRESETS.map((preset) => (
            <button
              key={preset}
              onClick={() => setAmountMajor(String(preset / 100))}
              className={`rounded px-2 py-2 text-sm transition ${
                amountMinor === preset
                  ? 'bg-amber-500 font-medium text-neutral-950'
                  : 'bg-neutral-800 hover:bg-neutral-700'
              }`}
            >
              {money(preset)}
            </button>
          ))}
        </div>

        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-neutral-500">{t('deposit.customAmount')}</span>
          <input
            value={amountMajor}
            onChange={(e) => setAmountMajor(e.target.value)}
            inputMode="decimal"
            autoFocus
            className="w-full rounded bg-neutral-800 px-3 py-2"
          />
        </label>

        {!valid && amountMajor !== '' && (
          <p className="mb-3 text-sm text-red-400">{t('deposit.amountRange')}</p>
        )}
        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

        <button
          onClick={() => void submit()}
          disabled={!valid || busy}
          className="w-full rounded-lg bg-amber-500 py-2.5 font-semibold text-neutral-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? t('deposit.processing') : `${t('deposit.submit')} ${money(amountMinor)}`}
        </button>
      </div>
    </div>
  );
}
