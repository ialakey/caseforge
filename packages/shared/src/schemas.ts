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
/**
 * Twenty at a time. On the market channel each item is bought separately from
 * its own seller, so a request is as many purchases as it has items, and a
 * hundred of them would spend several minutes against the market's rate limit
 * before the player learnt whether any of it worked.
 */
export const requestWithdrawalSchema = z.object({
  inventoryItemIds: z.array(z.string().uuid()).min(1).max(20),
});

export const upsertCaseSchema = z.object({
  /**
   * The shelf, by slug rather than by id: a seed file and an operator both
   * think in "collections", not in a UUID, and the slug is the thing that
   * survives a re-import.
   */
  categorySlug: z
    .string()
    .trim()
    .max(64)
    .regex(/^[a-z0-9-]*$/, 'category: lowercase latin letters, digits and hyphens only')
    .nullable()
    .optional(),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'slug: lowercase latin letters, digits and hyphens only'),
  name: z.string().trim().min(2).max(128),
  nameEn: z.string().trim().max(128).nullable().optional(),
  /**
   * The paragraph under the title, in both locales. Capped rather than free:
   * a case page has room for a couple of sentences, and anything longer is a
   * landing page somebody pasted into the wrong field.
   */
  description: z.string().trim().max(600).nullable().optional(),
  descriptionEn: z.string().trim().max(600).nullable().optional(),
  /**
   * Zero is allowed, and only means anything together with `isFree`. The
   * refinement at the bottom of this schema is what ties the two together:
   * a free case must cost nothing, and a paid one must cost something.
   */
  price: z.number().int().min(0),
  /** A free case is rationed by top-ups and a cooldown instead of a price. */
  isFree: z.boolean().default(false),
  /**
   * The free terms, in minor units and in openings per rolling 24 hours.
   *
   * Optional rather than defaulted, so that omitting them means "leave them
   * as they are". They are pure operator policy — no survey or import carries
   * them — and a re-import that reset every deposit tier to zero would be a
   * quiet giveaway of the whole catalogue.
   */
  freeMinDeposit: z.number().int().min(0).max(100_000_000).optional(),
  freeMaxOpens: z.number().int().min(1).max(100).optional(),
  /**
   * Either an absolute URL — a Steam image, a CDN — or a root-relative path,
   * because case art the site draws and serves itself is not a lesser kind of
   * image than one borrowed from Steam.
   */
  imageUrl: z
    .string()
    .trim()
    .max(2048)
    .refine(
      (v) => v.startsWith('/') || /^https?:\/\//.test(v),
      'imageUrl: an absolute http(s) URL or a path starting with /',
    )
    .nullable()
    .optional(),
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

/**
 * Price and free-ness have to agree.
 *
 * Checked here rather than in the service because it is a property of the
 * input, not of the world: a free case that also charges money, or a paid case
 * priced at nothing, is a contradiction no amount of database state can
 * resolve. A zero price on a paid case is the dangerous half — it would hand
 * out a knife case for nothing until somebody noticed.
 */
export const upsertCaseChecked = upsertCaseSchema.superRefine((input, ctx) => {
  if (input.isFree && input.price !== 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['price'],
      message: 'A free case must be priced at zero',
    });
  }
  if (!input.isFree && input.price <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['price'],
      message: 'A paid case must cost more than zero — or mark it as free',
    });
  }
});

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

/**
 * The assets a player wants to hand over.
 *
 * Asset ids and nothing else: prices are quoted by the server from its own
 * reading of the market, never taken from the browser. A client that could name
 * its own price would be a client that could name any price.
 */
export const createItemDepositSchema = z.object({
  assetIds: z.array(z.string().trim().min(1).max(32)).min(1).max(100),
});
export type CreateItemDepositInput = z.infer<typeof createItemDepositSchema>;

export const adjustBalanceSchema = z.object({
  userId: z.string().uuid(),
  amount: z
    .number()
    .int()
    .refine((v) => v !== 0, 'amount must not be zero'),
  reason: z.string().trim().min(3).max(500),
});

/** Creating or renaming a shelf. */
export const upsertCaseCategorySchema = z.object({
  slug: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'slug: lowercase latin letters, digits and hyphens only'),
  name: z.string().trim().min(2).max(64),
  nameEn: z.string().trim().max(64).nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  isActive: z.boolean().default(true),
});
export type UpsertCaseCategoryInput = z.infer<typeof upsertCaseCategorySchema>;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});
