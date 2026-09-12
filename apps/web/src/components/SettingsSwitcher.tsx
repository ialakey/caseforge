'use client';

import { DISPLAY_CURRENCIES, LOCALES, type DisplayCurrency, type Locale } from '@caseforge/shared';
import { useSettings } from '../lib/settings';

const LOCALE_LABEL: Record<Locale, string> = { ru: 'RU', en: 'EN' };
const CURRENCY_LABEL: Record<DisplayCurrency, string> = { RUB: '₽', USD: '$' };

/**
 * Language and currency switches.
 *
 * Two small segmented controls rather than dropdowns: there are two options
 * each, and a select would cost a click to show what a pair of buttons already
 * shows.
 */
export function SettingsSwitcher() {
  const { locale, currency, setLocale, setCurrency } = useSettings();

  return (
    <div className="flex items-center gap-1.5">
      <Segmented
        options={LOCALES}
        value={locale}
        onChange={setLocale}
        label={(v) => LOCALE_LABEL[v]}
        ariaLabel="Language"
      />
      <Segmented
        options={DISPLAY_CURRENCIES}
        value={currency}
        onChange={setCurrency}
        label={(v) => CURRENCY_LABEL[v]}
        ariaLabel="Currency"
      />
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  ariaLabel,
}: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  label: (option: T) => string;
  ariaLabel: string;
}) {
  return (
    <div className="flex overflow-hidden rounded bg-neutral-800" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option}
          onClick={() => onChange(option)}
          aria-pressed={option === value}
          className={`px-2 py-1 text-xs font-medium transition ${
            option === value
              ? 'bg-amber-500 text-neutral-950'
              : 'text-neutral-400 hover:text-neutral-100'
          }`}
        >
          {label(option)}
        </button>
      ))}
    </div>
  );
}
