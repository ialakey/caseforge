import { z } from 'zod';
import { DEFAULT_THEME, hexColorSchema } from './appearance.ts';
import { BATTLE_MAX_PLAYERS, BATTLE_MAX_ROUNDS, BATTLE_MIN_PLAYERS } from './battle.ts';
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
  'appearance',
  'deposits',
  'economy',
  'limits',
  'bonus',
  'battles',
  'referral',
  'withdrawals',
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

/**
 * How the admin panel should render the field.
 *
 * The kind is presentation, not validation — the schema decides what may be
 * stored. They are separate because a colour and a nickname are both strings to
 * zod and nothing alike to the person filling them in.
 */
export type SettingKind =
  'boolean' | 'int' | 'money' | 'json' | 'enum' | 'string' | 'text' | 'color' | 'url';

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

const line = (max = 120) => z.string().trim().max(max);

/**
 * A link, or nothing at all.
 *
 * Empty is a real value here — it means "no logo", "no Telegram" — so it is
 * accepted explicitly rather than by making the setting optional. A relative
 * path is allowed because an image served by the site itself is the normal
 * case, and `z.string().url()` would refuse it.
 */
const optionalLink = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(
      (value) => value === '' || value.startsWith('/') || /^https?:\/\//.test(value),
      'must be empty, an absolute path, or an http(s) URL',
    );

export const SETTINGS = {
  'site.maintenance': {
    group: 'site',
    kind: 'boolean',
    schema: z.coerce.boolean(),
    default: false,
    label: 'Maintenance mode',
    hint: 'Turns off opening, upgrades, contracts and the wheel. Sign-in keeps working.',
  },

  // --- appearance: the site builder ----------------------------------------
  //
  // Every text here is optional in the sense that matters: empty falls back to
  // the translated default in the dictionary, so a site nobody has configured
  // looks exactly as it ships — in both languages.

  'appearance.siteName': {
    group: 'appearance',
    kind: 'string',
    schema: line(40),
    default: 'CaseForge',
    label: 'Site name',
    hint: 'The wordmark in the header and the browser tab title.',
  },
  'appearance.taglineRu': {
    group: 'appearance',
    kind: 'string',
    schema: line(160),
    default: '',
    label: 'Tagline, Russian',
  },
  'appearance.taglineEn': {
    group: 'appearance',
    kind: 'string',
    schema: line(160),
    default: '',
    label: 'Tagline, English',
  },
  'appearance.logoUrl': {
    group: 'appearance',
    kind: 'url',
    schema: optionalLink(),
    default: '',
    label: 'Logo image',
    hint: 'Replaces the wordmark. Empty keeps the site name as text, which scales better.',
  },

  'appearance.accent': {
    group: 'appearance',
    kind: 'color',
    schema: hexColorSchema,
    default: DEFAULT_THEME.accent,
    label: 'Accent',
    hint: 'The money colour: balances, prices, the primary button.',
  },
  'appearance.accentStrong': {
    group: 'appearance',
    kind: 'color',
    schema: hexColorSchema,
    default: DEFAULT_THEME.accentStrong,
    label: 'Accent, darker',
    hint: 'The bottom of the primary button gradient.',
  },
  'appearance.positive': {
    group: 'appearance',
    kind: 'color',
    schema: hexColorSchema,
    default: DEFAULT_THEME.positive,
    label: 'Positive',
  },
  'appearance.negative': {
    group: 'appearance',
    kind: 'color',
    schema: hexColorSchema,
    default: DEFAULT_THEME.negative,
    label: 'Negative',
  },
  'appearance.surfaceBase': {
    group: 'appearance',
    kind: 'color',
    schema: hexColorSchema,
    default: DEFAULT_THEME.surfaceBase,
    label: 'Background',
  },
  'appearance.surfaceRaised': {
    group: 'appearance',
    kind: 'color',
    schema: hexColorSchema,
    default: DEFAULT_THEME.surfaceRaised,
    label: 'Panels',
  },
  'appearance.surfaceOverlay': {
    group: 'appearance',
    kind: 'color',
    schema: hexColorSchema,
    default: DEFAULT_THEME.surfaceOverlay,
    label: 'Controls',
    hint: 'Chips, inputs, hover states and the borders are all derived from this one.',
  },
  'appearance.textPrimary': {
    group: 'appearance',
    kind: 'color',
    schema: hexColorSchema,
    default: DEFAULT_THEME.textPrimary,
    label: 'Text',
    hint: 'The muted and faint tones keep its hue and drop its lightness.',
  },
  'appearance.radiusPx': {
    group: 'appearance',
    kind: 'int',
    schema: bounded(0, 28),
    default: DEFAULT_THEME.radiusPx,
    label: 'Corner radius, px',
  },
  'appearance.glow': {
    group: 'appearance',
    kind: 'boolean',
    schema: z.coerce.boolean(),
    default: DEFAULT_THEME.glow,
    label: 'Glow effects',
    hint: 'The halo under the primary button and around a landed reel. Off is flatter and calmer.',
  },

  'appearance.heroEnabled': {
    group: 'appearance',
    kind: 'boolean',
    schema: z.coerce.boolean(),
    default: true,
    label: 'Show the banner',
  },
  'appearance.heroTitleRu': {
    group: 'appearance',
    kind: 'string',
    schema: line(120),
    default: '',
    label: 'Banner headline, Russian',
  },
  'appearance.heroTitleEn': {
    group: 'appearance',
    kind: 'string',
    schema: line(120),
    default: '',
    label: 'Banner headline, English',
  },
  'appearance.heroSubtitleRu': {
    group: 'appearance',
    kind: 'text',
    schema: line(400),
    default: '',
    label: 'Banner text, Russian',
  },
  'appearance.heroSubtitleEn': {
    group: 'appearance',
    kind: 'text',
    schema: line(400),
    default: '',
    label: 'Banner text, English',
  },
  'appearance.heroCtaRu': {
    group: 'appearance',
    kind: 'string',
    schema: line(40),
    default: '',
    label: 'Banner button, Russian',
  },
  'appearance.heroCtaEn': {
    group: 'appearance',
    kind: 'string',
    schema: line(40),
    default: '',
    label: 'Banner button, English',
  },
  'appearance.heroCtaHref': {
    group: 'appearance',
    kind: 'string',
    schema: line(200),
    default: '#cases',
    label: 'Banner button target',
    hint: 'An anchor such as #cases, a path such as /battles, or a full URL.',
  },
  'appearance.heroImageUrl': {
    group: 'appearance',
    kind: 'url',
    schema: optionalLink(),
    default: '',
    label: 'Banner image',
    hint: 'Sits behind the headline. Empty keeps the gradient wash.',
  },

  'appearance.navBattles': {
    group: 'appearance',
    kind: 'boolean',
    schema: z.coerce.boolean(),
    default: true,
    label: 'Navigation: battles',
    hint: 'Hides the entry only. The feature itself is switched off in its own group.',
  },
  'appearance.navUpgrade': {
    group: 'appearance',
    kind: 'boolean',
    schema: z.coerce.boolean(),
    default: true,
    label: 'Navigation: upgrade',
  },
  'appearance.navContract': {
    group: 'appearance',
    kind: 'boolean',
    schema: z.coerce.boolean(),
    default: true,
    label: 'Navigation: contract',
  },
  'appearance.navBonus': {
    group: 'appearance',
    kind: 'boolean',
    schema: z.coerce.boolean(),
    default: true,
    label: 'Navigation: daily bonus',
  },
  'appearance.navReferral': {
    group: 'appearance',
    kind: 'boolean',
    schema: z.coerce.boolean(),
    default: true,
    label: 'Navigation: referrals',
  },

  // The key is historical: the feed used to be a block on the landing page and
  // is now a strip above the header on every page. Renaming the setting would
  // turn the feed back on for every operator who had switched it off, which is
  // a worse outcome than a key that no longer reads quite right.
  'appearance.homeDropFeed': {
    group: 'appearance',
    kind: 'boolean',
    schema: z.coerce.boolean(),
    default: true,
    label: 'Drop feed: the strip above the header',
  },
  'appearance.dropFeedBestDrop': {
    group: 'appearance',
    kind: 'boolean',
    schema: z.coerce.boolean(),
    default: true,
    label: 'Drop feed: pin the best drop of the day',
  },
  'appearance.publicProfiles': {
    group: 'appearance',
    kind: 'boolean',
    schema: z.coerce.boolean(),
    default: true,
    label: 'Public player profiles',
  },
  'appearance.homeBonusTeaser': {
    group: 'appearance',
    kind: 'boolean',
    schema: z.coerce.boolean(),
    default: true,
    label: 'Landing page: bonus teaser',
  },
  'appearance.homeCaseFilters': {
    group: 'appearance',
    kind: 'boolean',
    schema: z.coerce.boolean(),
    default: true,
    label: 'Landing page: search and price filters',
    hint: 'Worth hiding on a small catalogue, where the filters outnumber the cases.',
  },

  'appearance.footerNoteRu': {
    group: 'appearance',
    kind: 'text',
    schema: line(300),
    default: '',
    label: 'Footer note, Russian',
  },
  'appearance.footerNoteEn': {
    group: 'appearance',
    kind: 'text',
    schema: line(300),
    default: '',
    label: 'Footer note, English',
  },
  'appearance.socialTelegram': {
    group: 'appearance',
    kind: 'url',
    schema: optionalLink(200),
    default: '',
    label: 'Telegram link',
  },
  'appearance.socialDiscord': {
    group: 'appearance',
    kind: 'url',
    schema: optionalLink(200),
    default: '',
    label: 'Discord link',
  },
  'appearance.socialVk': {
    group: 'appearance',
    kind: 'url',
    schema: optionalLink(200),
    default: '',
    label: 'VK link',
  },
  'appearance.socialSteam': {
    group: 'appearance',
    kind: 'url',
    schema: optionalLink(200),
    default: '',
    label: 'Steam group link',
  },

  'appearance.seoDescriptionRu': {
    group: 'appearance',
    kind: 'text',
    schema: line(300),
    default: '',
    label: 'Page description, Russian',
    hint: 'The meta description a search engine or a chat app shows under the title.',
  },
  'appearance.seoDescriptionEn': {
    group: 'appearance',
    kind: 'text',
    schema: line(300),
    default: '',
    label: 'Page description, English',
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

  'deposits.itemsEnabled': {
    group: 'deposits',
    kind: 'boolean',
    schema: z.coerce.boolean(),
    default: true,
    label: 'Item deposits enabled',
    hint: 'Players hand skins to a farm bot and are credited for them.',
  },
  'deposits.itemRateBps': {
    group: 'deposits',
    kind: 'int',
    schema: z.coerce.number().int().min(1000).max(10_000),
    default: 8_500,
    label: 'Item deposit payout, basis points',
    hint: 'What the site pays for a deposited skin as a share of its market price. 8500 = 85%. The margin covers the spread and the risk of the price moving before the skin can be sold on.',
  },
  'deposits.itemMinValue': {
    group: 'deposits',
    kind: 'money',
    schema: bounded(1, 1_000_000_00),
    default: 50_00,
    label: 'Minimum value of one deposit',
    hint: 'A trade offer costs a bot slot and an operator’s attention either way, so very small deposits are refused.',
  },
  'deposits.itemMaxPerOffer': {
    group: 'deposits',
    kind: 'int',
    schema: z.coerce.number().int().min(1).max(100),
    default: 20,
    label: 'Items per deposit offer',
    hint: 'Steam caps a trade at 255 items; a lower cap keeps one failed offer from costing a player their whole inventory.',
  },
  'deposits.itemOfferTtlMin': {
    group: 'deposits',
    kind: 'int',
    schema: z.coerce.number().int().min(5).max(1440),
    default: 60,
    label: 'Deposit offer lifetime, minutes',
    hint: 'After this a request is abandoned. The quote is frozen at request time, so a stale offer is a promise made at last hour’s prices.',
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

  'battles.enabled': {
    group: 'battles',
    kind: 'boolean',
    schema: z.coerce.boolean(),
    default: true,
    label: 'Case battles enabled',
    hint: 'Switching it off hides the lobby and refuses new battles. Battles already waiting for seats are refunded by the sweeper.',
  },
  'battles.maxPlayers': {
    group: 'battles',
    kind: 'int',
    schema: bounded(BATTLE_MIN_PLAYERS, BATTLE_MAX_PLAYERS),
    default: BATTLE_MAX_PLAYERS,
    label: 'Seats per battle, maximum',
  },
  'battles.maxRounds': {
    group: 'battles',
    kind: 'int',
    schema: bounded(1, BATTLE_MAX_ROUNDS),
    default: BATTLE_MAX_ROUNDS,
    label: 'Rounds per battle, maximum',
    hint: `Rounds times seats is how many openings settle in one transaction; the hard ceiling is ${BATTLE_MAX_ROUNDS}.`,
  },
  'battles.waitMinutes': {
    group: 'battles',
    kind: 'int',
    schema: bounded(1, 24 * 60),
    default: 15,
    label: 'Cancel an unfilled battle after, minutes',
    hint: 'Every seat is refunded in full. A battle nobody joins must not hold the host money indefinitely.',
  },

  'referral.enabled': {
    group: 'referral',
    kind: 'boolean',
    schema: z.coerce.boolean(),
    default: true,
    label: 'Referrals enabled',
    hint: 'Switching it off stops new bindings and stops accruing commission. Whatever was already accrued stays claimable.',
  },
  'referral.depositBps': {
    group: 'referral',
    kind: 'int',
    schema: bounded(0, 5_000),
    default: 500,
    label: 'Commission on a top-up, basis points',
    hint: '500 bps = 5% of what an invited player tops up.',
  },
  'referral.wagerBps': {
    group: 'referral',
    kind: 'int',
    schema: bounded(0, 1_000),
    default: 100,
    label: 'Commission on a wager, basis points',
    hint: 'Charged on what an invited player pays for the cases they open, a battle seat included. It comes out of the margin, so it has to stay well under it — 100 bps = 1%.',
  },
  'referral.minClaim': {
    group: 'referral',
    kind: 'money',
    schema: bounded(0, 100_000_00),
    default: 100_00,
    label: 'Smallest payout',
    hint: 'Below this the pot keeps accruing. Zero lets anything be claimed.',
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

/** What a setting looks like to the admin panel: no zod schema. */
export interface PublicSettingDef {
  group: SettingGroup;
  kind: SettingKind;
  label: string;
  hint: string | null;
  /** Populated for `enum` settings only; null everywhere else. */
  options: readonly string[] | null;
  /**
   * The value the project ships with.
   *
   * Sent so the panel can offer "put it back": without it, an operator who has
   * experimented their way into an unreadable palette has no way out short of
   * asking somebody to edit the database.
   */
  default: unknown;
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
          default: def.default,
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
