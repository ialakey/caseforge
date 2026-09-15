import { z } from 'zod';

/**
 * Promo codes on a top-up.
 *
 * A code adds to what the player paid: type it in, top up, and the balance
 * moves by the deposit plus the bonus. It never discounts the payment itself,
 * which matters once a real payment provider is behind the button — the sum
 * charged has to be the sum the provider was told about, and a code that
 * changed it would put the two out of step. Adding on top keeps the whole
 * promotion on our side of the transaction.
 */

export const PromoKind = {
  /** A share of the deposit, in basis points. */
  PERCENT: 'PERCENT',
  /** A flat credit in minor units, regardless of the deposit. */
  FIXED: 'FIXED',
} as const;
export type PromoKind = (typeof PromoKind)[keyof typeof PromoKind];

/**
 * Codes are matched case-insensitively and stored upper-cased.
 *
 * A player typing `welcome` and an operator creating `WELCOME` mean the same
 * thing, and the alternative is a support queue full of people who capitalised
 * it wrong.
 */
export function normalisePromoCode(code: string): string {
  return code.trim().toUpperCase();
}

export const PROMO_CODE_REGEX = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

export const promoCodeSchema = z
  .string()
  .trim()
  .transform(normalisePromoCode)
  .refine((c) => PROMO_CODE_REGEX.test(c), 'code: 3 to 32 characters, letters, digits, - and _');

export interface PromoCodeRules {
  kind: PromoKind;
  /** Basis points for PERCENT, minor units for FIXED. */
  value: number;
  /** Smallest deposit the code applies to, in minor units. */
  minDeposit: number;
  /** Cap on the bonus for a PERCENT code, in minor units; null for no cap. */
  maxBonus: number | null;
  /** Total redemptions allowed across all players; null for unlimited. */
  maxUses: number | null;
  usedCount: number;
  /** How many times one player may use it. */
  perUserLimit: number;
  isActive: boolean;
  startsAt: Date | string | null;
  expiresAt: Date | string | null;
}

export const PromoRejection = {
  NOT_FOUND: 'NOT_FOUND',
  INACTIVE: 'INACTIVE',
  NOT_STARTED: 'NOT_STARTED',
  EXPIRED: 'EXPIRED',
  EXHAUSTED: 'EXHAUSTED',
  ALREADY_USED: 'ALREADY_USED',
  DEPOSIT_TOO_SMALL: 'DEPOSIT_TOO_SMALL',
} as const;
export type PromoRejection = (typeof PromoRejection)[keyof typeof PromoRejection];

export type PromoCheck =
  { ok: true; bonus: number } | { ok: false; reason: PromoRejection; minDeposit?: number };

function toTime(value: Date | string | null): number | null {
  if (value === null) return null;
  return (typeof value === 'string' ? new Date(value) : value).getTime();
}

/**
 * Whether a code applies to this deposit, and what it is worth.
 *
 * One function for the preview the player sees while typing and for the credit
 * the server actually makes, so a code cannot quote one number and pay another.
 * It does not look at the redemption table itself — the caller passes
 * `alreadyUsedByPlayer`, because only a query inside the deposit's transaction
 * can answer that without racing.
 */
export function checkPromoCode(
  rules: PromoCodeRules,
  depositAmount: number,
  alreadyUsedByPlayer: number,
  now: Date = new Date(),
): PromoCheck {
  if (!rules.isActive) return { ok: false, reason: PromoRejection.INACTIVE };

  const startsAt = toTime(rules.startsAt);
  if (startsAt !== null && now.getTime() < startsAt) {
    return { ok: false, reason: PromoRejection.NOT_STARTED };
  }

  const expiresAt = toTime(rules.expiresAt);
  if (expiresAt !== null && now.getTime() >= expiresAt) {
    return { ok: false, reason: PromoRejection.EXPIRED };
  }

  if (rules.maxUses !== null && rules.usedCount >= rules.maxUses) {
    return { ok: false, reason: PromoRejection.EXHAUSTED };
  }

  if (alreadyUsedByPlayer >= rules.perUserLimit) {
    return { ok: false, reason: PromoRejection.ALREADY_USED };
  }

  if (depositAmount < rules.minDeposit) {
    return { ok: false, reason: PromoRejection.DEPOSIT_TOO_SMALL, minDeposit: rules.minDeposit };
  }

  return { ok: true, bonus: promoBonus(rules, depositAmount) };
}

/**
 * The bonus a code is worth on a deposit, in minor units.
 *
 * Rounded down, so the rounding error belongs to the site rather than handing
 * out a fraction of a kopeck on every percentage code.
 */
export function promoBonus(
  rules: Pick<PromoCodeRules, 'kind' | 'value' | 'maxBonus'>,
  depositAmount: number,
): number {
  const raw =
    rules.kind === PromoKind.PERCENT
      ? Math.floor((depositAmount * rules.value) / 10_000)
      : rules.value;
  return rules.maxBonus === null ? raw : Math.min(raw, rules.maxBonus);
}

/** Shape the admin panel submits when creating or editing a code. */
export const upsertPromoCodeSchema = z
  .object({
    code: promoCodeSchema,
    kind: z.enum([PromoKind.PERCENT, PromoKind.FIXED]),
    value: z.number().int().positive(),
    minDeposit: z.number().int().min(0).default(0),
    maxBonus: z.number().int().positive().nullable().default(null),
    maxUses: z.number().int().positive().nullable().default(null),
    perUserLimit: z.number().int().min(1).max(1000).default(1),
    isActive: z.boolean().default(true),
    startsAt: z.string().datetime().nullable().default(null),
    expiresAt: z.string().datetime().nullable().default(null),
  })
  .refine(
    (v) => v.kind !== PromoKind.PERCENT || v.value <= 100_00,
    'a percentage code is capped at 10000 basis points (100%)',
  )
  .refine(
    (v) => v.startsAt === null || v.expiresAt === null || v.startsAt < v.expiresAt,
    'the code would expire before it started',
  );
export type UpsertPromoCodeInput = z.infer<typeof upsertPromoCodeSchema>;

/** Redeeming a code alongside a top-up. */
export const depositWithPromoSchema = z.object({
  amount: z.number().int().min(1),
  promoCode: promoCodeSchema.nullable().optional(),
});
