/**
 * Money in this project is always an integer number of minor units (kopecks).
 * No amount may exist as a float: `0.1 + 0.2` inside a casino balance turns
 * into a reconciliation mismatch.
 */
export type Minor = number;

/**
 * Settlement currency. Every stored amount — balances, item prices, case
 * prices — is denominated in it. Changing this constant does not re-price
 * anything; it only relabels existing numbers, so treat it as fixed for the
 * lifetime of a deployment.
 */
export const BASE_CURRENCY = 'RUB';

/** Currencies the interface can display. */
export const DISPLAY_CURRENCIES = ['RUB', 'USD'] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];

export function isDisplayCurrency(value: string): value is DisplayCurrency {
  return (DISPLAY_CURRENCIES as readonly string[]).includes(value);
}

/**
 * How many units of the base currency one unit of the display currency costs.
 * The base currency is always 1 by definition.
 */
export type FxRates = Partial<Record<DisplayCurrency, number>>;

export function toMinor(major: number): Minor {
  return Math.round(major * 100);
}

export function toMajor(minor: Minor): number {
  return minor / 100;
}

const LOCALE_BY_CURRENCY: Record<DisplayCurrency, string> = {
  RUB: 'ru-RU',
  USD: 'en-US',
};

/**
 * Converts an amount from the settlement currency into the display currency.
 *
 * Display only: nothing is re-priced and no balance changes. An unknown or
 * missing rate falls back to the base amount rather than silently producing
 * a wrong number — a price that is off by a factor of eighty is worse than
 * a price shown in the wrong currency.
 */
export function convertForDisplay(
  minorInBase: Minor,
  currency: DisplayCurrency,
  rates: FxRates,
): Minor {
  if (currency === BASE_CURRENCY) return minorInBase;
  const rate = rates[currency];
  if (!rate || rate <= 0) return minorInBase;
  return Math.round(minorInBase / rate);
}

/**
 * Formats an amount held in the settlement currency for display.
 *
 * Pass the display currency and the rate table to show it converted; with the
 * defaults it formats the base currency as stored.
 */
export function formatMoney(
  minorInBase: Minor,
  currency: DisplayCurrency = BASE_CURRENCY,
  rates: FxRates = {},
): string {
  const shown = convertForDisplay(minorInBase, currency, rates);
  return new Intl.NumberFormat(LOCALE_BY_CURRENCY[currency], {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(toMajor(shown));
}

/** Price the site pays back for an item: item price minus the fee. */
export function sellPrice(itemPrice: Minor, feeBps: number): Minor {
  return Math.floor((itemPrice * (10_000 - feeBps)) / 10_000);
}

/**
 * Effective price of a catalogue item: a manual override beats the market.
 *
 * Lives here rather than on a service because several of them need it, and a
 * second copy of the rule is how the showcase and the payout start disagreeing.
 */
export function resolveItemPrice(item: { marketPrice: Minor; priceOverride: Minor | null }): Minor {
  return item.priceOverride ?? item.marketPrice;
}
