import { z } from 'zod';
import { CONTRACT_MAX_ITEMS, CONTRACT_MIN_ITEMS } from './contract.ts';
import { INVENTORY_FILTERS, PRICE_BAND_KEYS } from './inventory.ts';

/**
 * The only valid trade URL shape. Steam issues it on the inventory privacy
 * settings page; the parts that matter are `partner` and `token`.
 */
export const TRADE_URL_REGEX =
  /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=(\d+)&token=([A-Za-z0-9_-]{8})$/;

export const tradeUrlSchema = z.string().trim().regex(TRADE_URL_REGEX, 'Invalid Steam trade URL');

export function parseTradeUrl(url: string): { partner: string; token: string } | null {
  const m = TRADE_URL_REGEX.exec(url.trim());
  return m ? { partner: m[1]!, token: m[2]! } : null;
}

export const openCaseSchema = z.object({
  caseId: z.string().uuid(),
  count: z.number().int().min(1).max(10).default(1),
});

export const upgradeSchema = z.object({
  inventoryItemId: z.string().uuid(),
  targetItemId: z.string().uuid(),
});

export const upgradeTargetsSchema = z.object({
  /** Price of the staked item — the available target range derives from it. */
  stakeValue: z.coerce.number().int().positive(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(60).default(24),
});

/**
 * A contract stake. The bounds come from the contract module rather than being
 * repeated here, so the API and the maths cannot disagree about what a legal
 * contract is.
 */
export const contractSchema = z.object({
  inventoryItemIds: z
    .array(z.string().uuid())
    .min(CONTRACT_MIN_ITEMS)
    .max(CONTRACT_MAX_ITEMS)
    // The ids address rows that are consumed, so a repeated id is not a
    // harmless duplicate but an attempt to stake one item twice.
    .refine((ids) => new Set(ids).size === ids.length, 'an item cannot be staked twice'),
});

/** Preview of the outcome table, before anything is consumed. */
export const contractPreviewSchema = z.object({
  inventoryItemIds: z
    .union([z.string(), z.array(z.string())])
    // A query string carries one value as a bare string and several as an
    // array; normalise before validating so both shapes reach the same rule.
    .transform((v) => (Array.isArray(v) ? v : v.split(',')))
    .pipe(
      z
        .array(z.string().uuid())
        .min(CONTRACT_MIN_ITEMS)
        .max(CONTRACT_MAX_ITEMS)
        .refine((ids) => new Set(ids).size === ids.length, 'an item cannot be staked twice'),
    ),
});

export const setClientSeedSchema = z.object({
  clientSeed: z.string().trim().min(1).max(64),
});

export const sellItemsSchema = z.object({
  inventoryItemIds: z.array(z.string().uuid()).min(1).max(100),
});

/** Which slice of the inventory to return. */
export const inventoryQuerySchema = z.object({
  filter: z.enum(INVENTORY_FILTERS).default('all'),
  band: z.enum(PRICE_BAND_KEYS).default('all'),
});

/**
 * Selling everything.
 *
 * The filter travels with the request rather than a list of ids: the player
 * pressed the button under a filtered view and means "everything I am looking
 * at". Sending ids instead would cap the operation at the page they had loaded
 * and would race with anything that changed in between.
 */
export const sellAllSchema = z.object({
  band: z.enum(PRICE_BAND_KEYS).default('all'),
});

/** Withdrawing straight from the inventory. */
export const withdrawItemsSchema = z.object({
  inventoryItemIds: z.array(z.string().uuid()).min(1).max(100),
});

export const requestWithdrawalSchema = z.object({
  inventoryItemIds: z.array(z.string().uuid()).min(1).max(20),
});

export const upsertCaseSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'slug: lowercase latin letters, digits and hyphens only'),
  name: z.string().trim().min(2).max(128),
  nameEn: z.string().trim().max(128).nullable().optional(),
  price: z.number().int().positive(),
  imageUrl: z.string().url().nullable().optional(),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  items: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        rangeFrom: z.number().int().min(0),
        rangeTo: z.number().int().min(0),
      }),
    )
    .min(1),
});
export type UpsertCaseInput = z.infer<typeof upsertCaseSchema>;

/** Top-up: amounts in minor units; the cap guards against a typo in the zeros. */
export const depositSchema = z.object({
  amount: z.number().int().min(1_00).max(100_000_00),
});

/** Quick top-up presets, in minor units. */
export const DEPOSIT_PRESETS = [100_00, 500_00, 1_000_00, 5_000_00, 25_000_00] as const;

export const importItemsSchema = z.object({
  marketHashNames: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
});

export const steamSearchSchema = z.object({
  query: z.string().trim().min(2).max(100),
  count: z.coerce.number().int().min(1).max(100).default(20),
});

export const adjustBalanceSchema = z.object({
  userId: z.string().uuid(),
  amount: z
    .number()
    .int()
    .refine((v) => v !== 0, 'amount must not be zero'),
  reason: z.string().trim().min(3).max(500),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});
