'use client';

import { formatMoney } from '@caseforge/shared';
import { useSettings } from '../lib/settings';

/**
 * The single place amounts are formatted: the input is always minor units of
 * the settlement currency, and the display currency comes from the viewer's
 * own setting.
 */
export function Money({ value, className }: { value: number; className?: string }) {
  const currency = useSettings((s) => s.currency);
  const fxRates = useSettings((s) => s.fxRates);
  return <span className={className}>{formatMoney(value, currency, fxRates)}</span>;
}

/** Same formatting outside JSX, where a component cannot be used. */
export function useMoneyFormatter(): (value: number) => string {
  const currency = useSettings((s) => s.currency);
  const fxRates = useSettings((s) => s.fxRates);
  return (value: number) => formatMoney(value, currency, fxRates);
}
