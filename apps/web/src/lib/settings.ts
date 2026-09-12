'use client';

import { useCallback } from 'react';
import { create } from 'zustand';
import {
  BASE_CURRENCY,
  DEFAULT_LOCALE,
  type DisplayCurrency,
  type FxRates,
  type Locale,
  type TranslationKey,
  isDisplayCurrency,
  isLocale,
  translate,
} from '@caseforge/shared';

const LOCALE_KEY = 'locale';
const CURRENCY_KEY = 'display_currency';

interface SettingsState {
  locale: Locale;
  currency: DisplayCurrency;
  fxRates: FxRates;
  /** True once the stored preferences have been read on the client. */
  hydrated: boolean;

  setLocale: (locale: Locale) => void;
  setCurrency: (currency: DisplayCurrency) => void;
  setFxRates: (rates: FxRates) => void;
  hydrate: () => void;
  /** Shorthand for the active locale's dictionary. */
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Private browsing or blocked site data — fall back to the defaults.
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not being able to remember the choice is not a reason to refuse it.
  }
}

/**
 * Language and display currency.
 *
 * Both start at their defaults during server rendering and are only read from
 * storage after mount. Reading them earlier would make the server and the
 * client disagree on the first render and produce a hydration mismatch, which
 * React resolves by throwing the markup away and re-rendering everything.
 */
export const useSettings = create<SettingsState>((set, get) => ({
  locale: DEFAULT_LOCALE,
  currency: BASE_CURRENCY,
  fxRates: { [BASE_CURRENCY]: 1 },
  hydrated: false,

  setLocale(locale) {
    writeStored(LOCALE_KEY, locale);
    document.documentElement.lang = locale;
    set({ locale });
  },

  setCurrency(currency) {
    writeStored(CURRENCY_KEY, currency);
    set({ currency });
  },

  setFxRates(fxRates) {
    set((state) => ({ fxRates: { ...state.fxRates, ...fxRates } }));
  },

  hydrate() {
    if (get().hydrated) return;

    const storedLocale = readStored(LOCALE_KEY);
    const storedCurrency = readStored(CURRENCY_KEY);

    // With no stored choice, follow the browser: a visitor whose browser is
    // not Russian almost certainly wants the English site.
    const browserLocale = navigator.language?.toLowerCase().startsWith('ru') ? 'ru' : 'en';

    const locale: Locale =
      storedLocale && isLocale(storedLocale) ? storedLocale : (browserLocale as Locale);
    const currency: DisplayCurrency =
      storedCurrency && isDisplayCurrency(storedCurrency)
        ? storedCurrency
        : locale === 'en'
          ? 'USD'
          : BASE_CURRENCY;

    document.documentElement.lang = locale;
    set({ locale, currency, hydrated: true });
  },

  t(key, params) {
    return translate(get().locale, key, params);
  },
}));

/**
 * Convenience hook for components that only need the translator.
 *
 * It subscribes to `locale`, not to `t`. The store's `t` is a stable function
 * reference, so a component selecting it would never re-render on a language
 * change and would keep rendering the previous language forever.
 */
export function useT(): SettingsState['t'] {
  const locale = useSettings((s) => s.locale);
  return useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) =>
      translate(locale, key, params),
    [locale],
  );
}
