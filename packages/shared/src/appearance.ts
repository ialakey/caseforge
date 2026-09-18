import { z } from 'zod';
import type { Locale } from './i18n.ts';

/**
 * The site's appearance, as configuration.
 *
 * Everything an operator can change about how the site looks and which parts of
 * it exist — the name, the palette, the banner, which sections appear in the
 * navigation — lives in the settings table and is served to the browser at
 * runtime. The alternative, editing Tailwind classes and redeploying, makes the
 * look a developer task; this makes it an operator task, which is what it
 * actually is.
 *
 * Two rules keep it honest:
 *
 * 1. **Empty means the shipped default.** A blank headline is not a blank
 *    headline on the page: it falls back to the translated string in the
 *    dictionary. So an operator fills in only what they want to differ, and a
 *    site that has never been configured looks exactly as it does out of the
 *    box — in both languages.
 * 2. **Nothing here can change the odds.** Appearance is presentation. The
 *    ticket space, the RTP and the wheel live in their own groups, where a
 *    change is a change to the game rather than to its paint.
 */

/** `#rgb` or `#rrggbb`, which is what a colour input produces. */
export const HEX_COLOR_REGEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export const hexColorSchema = z.string().trim().regex(HEX_COLOR_REGEX, 'colour: #rgb or #rrggbb');

export function isHexColor(value: string): boolean {
  return HEX_COLOR_REGEX.test(value.trim());
}

/**
 * Converts a hex colour to the `H S% L%` triple the stylesheet expects.
 *
 * The design tokens are stored as bare HSL components rather than finished
 * colours precisely so a component can write `hsl(var(--accent) / 0.14)` and
 * get a translucent accent without a second variable for every opacity. That
 * shape is the contract with globals.css, so the conversion has to live in one
 * place — here — rather than in whichever component happens to need it.
 */
export function hexToHslTriplet(hex: string): string {
  const raw = hex.trim().replace('#', '');
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw;

  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;

  let hue = 0;
  let saturation = 0;

  if (delta !== 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }

  const round = (value: number) => Math.round(value * 10) / 10;
  return `${round(hue)} ${round(saturation * 100)}% ${round(lightness * 100)}%`;
}

/** A string that is set per language. Either half may be empty. */
export interface LocalisedText {
  ru: string;
  en: string;
}

/**
 * The text for this reader, or null when nothing was configured.
 *
 * Null rather than an empty string on purpose: the caller has a translated
 * default to fall back to, and `??` only works if the absence is expressible.
 * A value set in one language only is used for both — an operator who bothered
 * to write a headline meant it to be seen.
 */
export function pickLocalised(locale: Locale, text: LocalisedText): string | null {
  const own = locale === 'en' ? text.en : text.ru;
  const other = locale === 'en' ? text.ru : text.en;
  return own.trim() || other.trim() || null;
}

export interface AppearanceTheme {
  accent: string;
  accentStrong: string;
  positive: string;
  negative: string;
  surfaceBase: string;
  surfaceRaised: string;
  surfaceOverlay: string;
  textPrimary: string;
  /** Corner radius of panels and buttons, in pixels. */
  radiusPx: number;
  /** The glow behind the primary button and the reel. Off is a flatter, calmer site. */
  glow: boolean;
}

export interface AppearanceConfig {
  siteName: string;
  tagline: LocalisedText;
  logoUrl: string | null;
  theme: AppearanceTheme;
  hero: {
    enabled: boolean;
    title: LocalisedText;
    subtitle: LocalisedText;
    cta: LocalisedText;
    ctaHref: string;
    imageUrl: string | null;
  };
  /** Which sections exist in the navigation at all. */
  nav: {
    battles: boolean;
    upgrade: boolean;
    contract: boolean;
    bonus: boolean;
    referral: boolean;
  };
  home: {
    dropFeed: boolean;
    bonusTeaser: boolean;
    caseFilters: boolean;
  };
  footer: {
    note: LocalisedText;
    telegram: string;
    discord: string;
    vk: string;
    steam: string;
  };
  seo: { description: LocalisedText };
}

/** The palette the project ships with: dark surfaces, gold as the money colour. */
export const DEFAULT_THEME: AppearanceTheme = {
  accent: '#f0a92a',
  accentStrong: '#ef8b0a',
  positive: '#23c483',
  negative: '#e85454',
  surfaceBase: '#0d0f12',
  surfaceRaised: '#14171c',
  surfaceOverlay: '#1e2228',
  textPrimary: '#f3f5f7',
  radiusPx: 12,
  glow: true,
};

/**
 * One-click palettes.
 *
 * Not because five presets cover what anyone wants, but because a dozen colour
 * pickers with no starting point is how an operator ends up with a site that
 * looks broken. A preset fills the fields; everything stays editable
 * afterwards.
 */
export interface ThemePreset {
  key: string;
  /** Shown in the panel; translated by `appearance.preset.<key>` when known. */
  label: string;
  theme: AppearanceTheme;
}

export const THEME_PRESETS: readonly ThemePreset[] = [
  { key: 'gold', label: 'Gold on graphite', theme: DEFAULT_THEME },
  {
    key: 'violet',
    label: 'Violet',
    theme: {
      ...DEFAULT_THEME,
      accent: '#a78bfa',
      accentStrong: '#7c3aed',
      surfaceBase: '#0c0b14',
      surfaceRaised: '#15121f',
      surfaceOverlay: '#211c30',
    },
  },
  {
    key: 'emerald',
    label: 'Emerald',
    theme: {
      ...DEFAULT_THEME,
      accent: '#34d399',
      accentStrong: '#059669',
      surfaceBase: '#08110e',
      surfaceRaised: '#0e1a16',
      surfaceOverlay: '#152621',
    },
  },
  {
    key: 'crimson',
    label: 'Crimson',
    theme: {
      ...DEFAULT_THEME,
      accent: '#fb7185',
      accentStrong: '#e11d48',
      surfaceBase: '#120a0d',
      surfaceRaised: '#1b1014',
      surfaceOverlay: '#27171d',
    },
  },
  {
    key: 'daylight',
    label: 'Daylight',
    theme: {
      ...DEFAULT_THEME,
      accent: '#2563eb',
      accentStrong: '#1d4ed8',
      surfaceBase: '#eef1f6',
      surfaceRaised: '#f7f9fc',
      surfaceOverlay: '#e2e8f0',
      textPrimary: '#10151c',
      glow: false,
    },
  },
] as const;

export const DEFAULT_APPEARANCE: AppearanceConfig = {
  siteName: 'CaseForge',
  tagline: { ru: '', en: '' },
  logoUrl: null,
  theme: DEFAULT_THEME,
  hero: {
    enabled: true,
    title: { ru: '', en: '' },
    subtitle: { ru: '', en: '' },
    cta: { ru: '', en: '' },
    ctaHref: '#cases',
    imageUrl: null,
  },
  nav: { battles: true, upgrade: true, contract: true, bonus: true, referral: true },
  home: { dropFeed: true, bonusTeaser: true, caseFilters: true },
  footer: { note: { ru: '', en: '' }, telegram: '', discord: '', vk: '', steam: '' },
  seo: { description: { ru: '', en: '' } },
};

/**
 * The CSS custom properties a configuration implies.
 *
 * The single mapping from configuration to stylesheet: the browser applies
 * these to the document root and every component keeps using the same tokens
 * it always did. A component that read a colour out of the configuration
 * directly would be a component that stops responding to a preset.
 */
export function appearanceCssVariables(config: AppearanceConfig): Record<string, string> {
  const { theme } = config;
  return {
    '--surface-base': hexToHslTriplet(theme.surfaceBase),
    '--surface-raised': hexToHslTriplet(theme.surfaceRaised),
    '--surface-overlay': hexToHslTriplet(theme.surfaceOverlay),
    // Hover is one step brighter than the overlay rather than its own setting:
    // it is a state, not a colour anybody wants to choose, and deriving it is
    // how the two stay related when a preset moves the overlay.
    '--surface-hover': shiftLightness(theme.surfaceOverlay, 4),
    '--border-subtle': shiftLightness(theme.surfaceOverlay, 6),
    '--border-strong': shiftLightness(theme.surfaceOverlay, 14),
    '--text-primary': hexToHslTriplet(theme.textPrimary),
    '--text-muted': withLightness(theme.textPrimary, 62),
    '--text-faint': withLightness(theme.textPrimary, 44),
    '--accent': hexToHslTriplet(theme.accent),
    '--accent-strong': hexToHslTriplet(theme.accentStrong),
    '--positive': hexToHslTriplet(theme.positive),
    '--negative': hexToHslTriplet(theme.negative),
    '--radius': `${theme.radiusPx}px`,
    '--glow-strength': theme.glow ? '1' : '0',
  };
}

/** Moves a colour's lightness by a number of percentage points. */
function shiftLightness(hex: string, delta: number): string {
  const [hue, saturation, lightness] = hexToHslTriplet(hex).split(' ');
  const value = Math.min(100, Math.max(0, parseFloat(lightness!) + delta));
  return `${hue} ${saturation} ${Math.round(value * 10) / 10}%`;
}

/** Keeps a colour's hue and saturation, replaces its lightness. */
function withLightness(hex: string, lightness: number): string {
  const [hue, saturation] = hexToHslTriplet(hex).split(' ');
  return `${hue} ${saturation} ${lightness}%`;
}

/**
 * Assembles the configuration from the flat settings map.
 *
 * The settings registry is flat by design — one key, one type, one validator,
 * and the generic settings form can render anything in it without knowing what
 * it is. The front end wants the nested shape instead, so the flattening lives
 * here, in one function used by the server that serves it. A second reader with
 * its own idea of the key names is how a renamed setting stops taking effect
 * while nothing reports an error.
 */
export function buildAppearance(read: (key: string) => unknown): AppearanceConfig {
  const str = (key: string, fallback = ''): string => {
    const value = read(`appearance.${key}`);
    return typeof value === 'string' ? value.trim() : fallback;
  };
  const text = (key: string): LocalisedText => ({
    ru: str(`${key}Ru`),
    en: str(`${key}En`),
  });
  const colour = (key: string, fallback: string): string => {
    const value = str(key);
    return isHexColor(value) ? value : fallback;
  };
  const flag = (key: string, fallback: boolean): boolean => {
    const value = read(`appearance.${key}`);
    return typeof value === 'boolean' ? value : fallback;
  };
  const int = (key: string, fallback: number): number => {
    const value = read(`appearance.${key}`);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };
  const url = (key: string): string | null => str(key) || null;

  return {
    siteName: str('siteName') || DEFAULT_APPEARANCE.siteName,
    tagline: text('tagline'),
    logoUrl: url('logoUrl'),
    theme: {
      accent: colour('accent', DEFAULT_THEME.accent),
      accentStrong: colour('accentStrong', DEFAULT_THEME.accentStrong),
      positive: colour('positive', DEFAULT_THEME.positive),
      negative: colour('negative', DEFAULT_THEME.negative),
      surfaceBase: colour('surfaceBase', DEFAULT_THEME.surfaceBase),
      surfaceRaised: colour('surfaceRaised', DEFAULT_THEME.surfaceRaised),
      surfaceOverlay: colour('surfaceOverlay', DEFAULT_THEME.surfaceOverlay),
      textPrimary: colour('textPrimary', DEFAULT_THEME.textPrimary),
      radiusPx: int('radiusPx', DEFAULT_THEME.radiusPx),
      glow: flag('glow', DEFAULT_THEME.glow),
    },
    hero: {
      enabled: flag('heroEnabled', true),
      title: text('heroTitle'),
      subtitle: text('heroSubtitle'),
      cta: text('heroCta'),
      ctaHref: str('heroCtaHref') || DEFAULT_APPEARANCE.hero.ctaHref,
      imageUrl: url('heroImageUrl'),
    },
    nav: {
      battles: flag('navBattles', true),
      upgrade: flag('navUpgrade', true),
      contract: flag('navContract', true),
      bonus: flag('navBonus', true),
      referral: flag('navReferral', true),
    },
    home: {
      dropFeed: flag('homeDropFeed', true),
      bonusTeaser: flag('homeBonusTeaser', true),
      caseFilters: flag('homeCaseFilters', true),
    },
    footer: {
      note: text('footerNote'),
      telegram: str('socialTelegram'),
      discord: str('socialDiscord'),
      vk: str('socialVk'),
      steam: str('socialSteam'),
    },
    seo: { description: text('seoDescription') },
  };
}

/**
 * The appearance fields, grouped the way the builder page lays them out.
 *
 * The generic settings form can render every one of these on its own — they are
 * ordinary settings. This list exists so the dedicated page can show them as
 * cards with the language pairs side by side, and so adding a field still means
 * touching one list rather than a layout.
 */
export const APPEARANCE_SECTIONS: ReadonlyArray<{
  key: 'brand' | 'theme' | 'hero' | 'nav' | 'home' | 'footer' | 'seo';
  fields: readonly string[];
}> = [
  {
    key: 'brand',
    fields: [
      'appearance.siteName',
      'appearance.taglineRu',
      'appearance.taglineEn',
      'appearance.logoUrl',
    ],
  },
  {
    key: 'theme',
    fields: [
      'appearance.accent',
      'appearance.accentStrong',
      'appearance.positive',
      'appearance.negative',
      'appearance.surfaceBase',
      'appearance.surfaceRaised',
      'appearance.surfaceOverlay',
      'appearance.textPrimary',
      'appearance.radiusPx',
      'appearance.glow',
    ],
  },
  {
    key: 'hero',
    fields: [
      'appearance.heroEnabled',
      'appearance.heroTitleRu',
      'appearance.heroTitleEn',
      'appearance.heroSubtitleRu',
      'appearance.heroSubtitleEn',
      'appearance.heroCtaRu',
      'appearance.heroCtaEn',
      'appearance.heroCtaHref',
      'appearance.heroImageUrl',
    ],
  },
  {
    key: 'nav',
    fields: [
      'appearance.navBattles',
      'appearance.navUpgrade',
      'appearance.navContract',
      'appearance.navBonus',
      'appearance.navReferral',
    ],
  },
  {
    key: 'home',
    fields: ['appearance.homeDropFeed', 'appearance.homeBonusTeaser', 'appearance.homeCaseFilters'],
  },
  {
    key: 'footer',
    fields: [
      'appearance.footerNoteRu',
      'appearance.footerNoteEn',
      'appearance.socialTelegram',
      'appearance.socialDiscord',
      'appearance.socialVk',
      'appearance.socialSteam',
    ],
  },
  { key: 'seo', fields: ['appearance.seoDescriptionRu', 'appearance.seoDescriptionEn'] },
] as const;
