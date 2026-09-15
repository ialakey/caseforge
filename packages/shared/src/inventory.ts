/**
 * Inventory: statuses the player sees, and the filters over them.
 *
 * An item never leaves the inventory. Selling it or withdrawing it moves it to
 * another status, and it stays on the account as a record of what happened —
 * a player who sold a knife must still be able to find it and see what they
 * got for it, and support cannot investigate a complaint about an item that
 * vanished from the interface the moment it was disposed of.
 */

/** Statuses an inventory row can hold. Mirrors the Prisma enum. */
export const InventoryItemStatus = {
  AVAILABLE: 'AVAILABLE',
  LOCKED: 'LOCKED',
  WITHDRAWN: 'WITHDRAWN',
  SOLD: 'SOLD',
  UPGRADED: 'UPGRADED',
  CONTRACTED: 'CONTRACTED',
} as const;
export type InventoryItemStatus = (typeof InventoryItemStatus)[keyof typeof InventoryItemStatus];

/**
 * Statuses an item can still be acted on from.
 *
 * Only AVAILABLE: a LOCKED item is already promised to a withdrawal, and
 * everything else has been spent.
 */
export const ACTIONABLE_STATUSES: readonly InventoryItemStatus[] = [InventoryItemStatus.AVAILABLE];

/** Statuses that are over and done with — the history side of the inventory. */
export const SPENT_STATUSES: readonly InventoryItemStatus[] = [
  InventoryItemStatus.WITHDRAWN,
  InventoryItemStatus.SOLD,
  InventoryItemStatus.UPGRADED,
  InventoryItemStatus.CONTRACTED,
];

/** Whether the item can be sold or withdrawn right now. */
export function isActionable(status: InventoryItemStatus): boolean {
  return ACTIONABLE_STATUSES.includes(status);
}

/**
 * The tabs the inventory is split into.
 *
 * `available` is what the player can do something with, `pending` what is on
 * its way out, `history` what is already gone. They are named after what the
 * player is looking for rather than after the underlying statuses, which is
 * why `history` covers four of them.
 */
export const INVENTORY_FILTERS = ['all', 'available', 'pending', 'history'] as const;
export type InventoryFilter = (typeof INVENTORY_FILTERS)[number];

export function statusesForFilter(filter: InventoryFilter): InventoryItemStatus[] {
  switch (filter) {
    case 'available':
      return [...ACTIONABLE_STATUSES];
    case 'pending':
      return [InventoryItemStatus.LOCKED];
    case 'history':
      return [...SPENT_STATUSES];
    case 'all':
    default:
      return Object.values(InventoryItemStatus);
  }
}

/**
 * Price bands, in base-currency minor units.
 *
 * Deliberately fixed in the base currency rather than in whatever the player is
 * currently displaying. A band whose edges moved with the exchange rate would
 * quietly re-sort the inventory every time the rates refreshed, and an item
 * could sit in one band on Monday and another on Tuesday without its price
 * having changed at all. The labels are rendered through the usual money
 * formatter, so the edges still read in the player's chosen currency.
 */
export interface PriceBand {
  key: string;
  /** Inclusive lower bound, in minor units. */
  min: number;
  /** Exclusive upper bound, in minor units; null means no ceiling. */
  max: number | null;
}

export const PRICE_BANDS: readonly PriceBand[] = [
  { key: 'under100', min: 0, max: 100_00 },
  { key: '100to500', min: 100_00, max: 500_00 },
  { key: '500to2000', min: 500_00, max: 2_000_00 },
  { key: '2000to10000', min: 2_000_00, max: 10_000_00 },
  { key: 'over10000', min: 10_000_00, max: null },
];

export const PRICE_BAND_KEYS = ['all', ...PRICE_BANDS.map((b) => b.key)] as const;
export type PriceBandKey = (typeof PRICE_BAND_KEYS)[number];

export function findPriceBand(key: PriceBandKey): PriceBand | null {
  return PRICE_BANDS.find((b) => b.key === key) ?? null;
}

/** Whether a price falls inside a band. The upper bound is exclusive. */
export function inPriceBand(price: number, band: PriceBand): boolean {
  return price >= band.min && (band.max === null || price < band.max);
}

/** The band a price belongs to, or null if the bands do not cover it. */
export function priceBandOf(price: number): PriceBand | null {
  return PRICE_BANDS.find((b) => inPriceBand(price, b)) ?? null;
}
