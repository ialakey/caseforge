import { z } from 'zod';
import { WHEEL_SEGMENTS, wheelSegmentsSchema } from './bonus.ts';
import { WITHDRAWAL_PROVIDERS } from './market.ts';

/**
 * Runtime settings.
 *
 * Everything an operator can change without a deploy lives here, declared once
 * with its type, its bounds and its default. The admin panel renders the form
 * from this registry rather than hard-coding a field per setting, so adding a
 * knob is a line in this file and nothing else.
 *
 * What is deliberately NOT here: the ticket space, the seed algorithm, and the
 * shape of a roll. Those are not tuning parameters but the terms of a promise —
 * every past opening was published against them, and an operator who could edit
 * them could make yesterday's drops stop verifying. A setting is for things the
 * site may change its mind about; fairness is not one of them.
 */

export const SETTING_GROUPS = [
  'site',
  'deposits',
  'economy',
  'limits',
  'bonus',
  'withdrawals',
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

/** How the admin panel should render the field. */
export type SettingKind = 'boolean' | 'int' | 'money' | 'json' | 'enum';

export interface SettingDef {
  group: SettingGroup;
  kind: SettingKind;
  /** Validates and coerces whatever came out of the database or the form. */
  schema: z.ZodType;
  default: unknown;
  label: string;
  hint?: string;
  /** The allowed values of an `enum` setting, in the order to offer them. */
  options?: readonly string[];
}

const bounded = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const SETTINGS = {
  'site.maintenance': {
    group: 'site',
    kind: 'boolean',
    schema: z.coerce.boolean(),
    default: false,
    label: 'Maintenance mode',
    hint: 'Turns off opening, upgrades, contracts and the wheel. Sign-in keeps working.',
  },

  'deposits.enabled': {
    group: 'deposits',
    kind: 'boolean',
    schema: z.coerce.boolean(),
    default: true,
    label: 'Top-ups enabled',
    hint: 'The stub credit, until a payment provider is wired in.',
  },
  'deposits.min': {
    group: 'deposits',
    kind: 'money',
    schema: bounded(1, 100_000_00),
    default: 1_00,
    label: 'Minimum top-up',
  },
  'deposits.max': {
    group: 'deposits',
    kind: 'money',
    schema: bounded(1, 10_000_000_00),
    default: 100_000_00,
    label: 'Maximum top-up',
  },

  'economy.sellFeeBps': {
    group: 'economy',
    kind: 'int',
    schema: bounded(0, 5000),
    default: 0,
    label: 'Sell-back fee, basis points',
    hint: '100 bps = 1%. Taken when a player sells an item back to the site.',
  },

  'limits.openPerWindow': {
    group: 'limits',
    kind: 'int',
    schema: bounded(1, 10_000),
    default: 60,
    label: 'Case openings per window',
    hint: 'Counted in cases, not requests: one "x10" press is ten openings.',
  },
  'limits.openWindowSec': {
    group: 'limits',
    kind: 'int',
    schema: bounded(1, 3600),
    default: 10,
    label: 'Rate-limit window, seconds',
  },

  'bonus.enabled': {
    group: 'bonus',
    kind: 'boolean',
    schema: z.coerce.boolean(),
    default: true,
    label: 'Daily wheel enabled',
  },
  'bonus.cooldownHours': {
    group: 'bonus',
    kind: 'int',
    schema: bounded(1, 24 * 30),
    default: 24,
    label: 'Hours between spins',
  },
  'bonus.wheel': {
    group: 'bonus',
    kind: 'json',
    schema: wheelSegmentsSchema,
    default: WHEEL_SEGMENTS,
    label: 'Wheel slices',
    hint: 'Shares must add up to 1. Ticket ranges are recomputed on save.',
  },

  'withdrawals.provider': {
    group: 'withdrawals',
    kind: 'enum',
    options: WITHDRAWAL_PROVIDERS,
    schema: z.enum(WITHDRAWAL_PROVIDERS),
    default: 'MARKET',
    label: 'Delivery channel',
    hint:
      'MARKET buys each skin on market.csgo.com and has the seller send it straight to the ' +
      'player. BOTS hands out items a Steam bot in the farm already holds. The channel is ' +
      'stamped on a request when it is made, so switching does not strand anything in flight.',
  },
  'withdrawals.market.maxOverpayBps': {
    group: 'withdrawals',
    kind: 'int',
    schema: bounded(0, 10_000),
    default: 700,
    label: 'Maximum overpay, basis points',
    hint:
      'How far above the price the player was credited a purchase may go. 700 bps = 7%. ' +
      'Past it the item is not bought and goes back to the inventory.',
  },
  'withdrawals.market.minSellerChance': {
    group: 'withdrawals',
    kind: 'int',
    schema: bounded(0, 100),
    default: 80,
    label: 'Minimum seller delivery rate, %',
    hint: 'Sellers who deliver less often than this are skipped, even when they are cheapest.',
  },
  'withdrawals.market.stuckAfterMin': {
    group: 'withdrawals',
    kind: 'int',
    schema: bounded(5, 24 * 60),
    default: 45,
    label: 'Flag an undelivered purchase after, minutes',
    hint:
      'Only flags it for an operator. A paid purchase is never written off on a timer — the ' +
      'money is already spent and the market may still deliver.',
  },
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function settingDef(key: SettingKey): SettingDef {
  return SETTINGS[key];
}

/**
 * Parses a stored value, falling back to the default.
 *
 * Never throws. A setting that fails to parse — hand-edited in the database, or
 * left over from an older shape — must not take the site down; it reverts to
 * the default and the caller can log it. The admin panel validates on the way
 * in, which is where a bad value should be rejected loudly.
 */
export function parseSetting<K extends SettingKey>(
  key: K,
  raw: unknown,
): { value: unknown; usedDefault: boolean } {
  const def = SETTINGS[key];
  if (raw === undefined || raw === null) return { value: def.default, usedDefault: true };
  const parsed = def.schema.safeParse(raw);
  return parsed.success
    ? { value: parsed.data, usedDefault: false }
    : { value: def.default, usedDefault: true };
}

/** Validates a value on its way in, so a bad edit is refused rather than stored. */
export function validateSetting<K extends SettingKey>(
  key: K,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; errors: string[] } {
  const parsed = SETTINGS[key].schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, errors: parsed.error.issues.map((i) => i.message) };
}

/** What a setting looks like to the admin panel: no zod schema, no default. */
export interface PublicSettingDef {
  group: SettingGroup;
  kind: SettingKind;
  label: string;
  hint: string | null;
  /** Populated for `enum` settings only; null everywhere else. */
  options: readonly string[] | null;
}

/**
 * The registry as the admin panel consumes it.
 *
 * Lives here rather than being assembled in the controller so the panel and
 * the validator cannot drift: one list of keys, described once.
 */
export function settingDefinitions(): Record<SettingKey, PublicSettingDef> {
  return Object.fromEntries(
    SETTING_KEYS.map((key) => {
      const def: SettingDef = SETTINGS[key];
      return [
        key,
        {
          group: def.group,
          kind: def.kind,
          label: def.label,
          hint: def.hint ?? null,
          options: def.options ?? null,
        },
      ];
    }),
  ) as Record<SettingKey, PublicSettingDef>;
}

/** Every setting with its default, for seeding an empty settings table. */
export function defaultSettings(): Record<SettingKey, unknown> {
  return Object.fromEntries(SETTING_KEYS.map((k) => [k, SETTINGS[k].default])) as Record<
    SettingKey,
    unknown
  >;
}
