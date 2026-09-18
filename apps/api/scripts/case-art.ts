/**
 * Draws a case its own picture.
 *
 * The surveyed catalogue gives names, prices and contents, and no artwork —
 * and artwork is not the sort of thing to borrow from another site anyway. So
 * the pictures are generated: one SVG per case, written next to the web app
 * and served from `/cases/<slug>.svg`.
 *
 * The design has one job, which is to make two hundred cards distinguishable
 * at a glance in a grid. That rules out a single house illustration with the
 * name written on it, because then every card is the same card. What varies
 * instead is colour, and it varies in two steps:
 *
 * 1. **The shelf sets the palette.** Free cases are green, ALL IN cases are
 *    red, collections are slate. A player who learns one card has learned the
 *    whole shelf, which is the entire point of grouping them.
 * 2. **The slug sets the hue within that palette.** A hash of the slug shifts
 *    the shelf's base hue by a bounded amount, so neighbours on the same shelf
 *    differ without any of them leaving the family.
 *
 * Everything is derived from the slug, so the same case always gets the same
 * picture: a re-import does not reshuffle the catalogue's appearance, and the
 * files are stable enough to commit.
 */

/** The palette a shelf paints its cases in: base hue, and the lid's accent. */
interface Palette {
  /** Base hue in degrees, before the per-case shift. */
  hue: number;
  /** How far a slug may shift the hue, in degrees either way. */
  spread: number;
  saturation: number;
  /** Hue of the lid band and the keyhole glow — the one warm note on the box. */
  accentHue: number;
}

/**
 * Palettes by category slug.
 *
 * Keyed by our slugs rather than the survey's Russian headings: the headings
 * are the source's business, the slugs are ours, and a palette should not need
 * rewriting because somebody renamed a shelf.
 */
const PALETTES: Record<string, Palette> = {
  free: { hue: 146, spread: 14, saturation: 52, accentHue: 96 },
  rarity: { hue: 276, spread: 20, saturation: 48, accentHue: 310 },
  standard: { hue: 212, spread: 22, saturation: 44, accentHue: 190 },
  house: { hue: 26, spread: 18, saturation: 54, accentHue: 44 },
  weapons: { hue: 196, spread: 16, saturation: 38, accentHue: 178 },
  creators: { hue: 330, spread: 18, saturation: 50, accentHue: 356 },
  farm: { hue: 72, spread: 12, saturation: 46, accentHue: 54 },
  'all-in': { hue: 2, spread: 10, saturation: 58, accentHue: 32 },
  collections: { hue: 228, spread: 24, saturation: 28, accentHue: 204 },
};

/** The palette for anything unmapped: grey, so it reads as unclassified. */
const FALLBACK: Palette = { hue: 220, spread: 30, saturation: 16, accentHue: 220 };

/**
 * A stable 32-bit hash of a string.
 *
 * FNV-1a, because the requirement is "the same slug gives the same number and
 * different slugs usually give different ones", and nothing about this needs a
 * cryptographic hash or a dependency.
 */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Escapes the five characters that cannot appear as text in an SVG. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The two or three characters printed on the lid.
 *
 * Initials of the first words, because a case name does not fit on a crate and
 * a truncated name fits worse than a monogram. "Кейс Бомжа" becomes "КБ",
 * "ALL IN AWP" becomes "AIA". Names with one word give their first two
 * letters, so "Граффити" is "ГР" rather than a lonely "Г".
 */
function monogram(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return words
    .slice(0, 3)
    .map((w) => w[0]!)
    .join('')
    .toUpperCase();
}

/**
 * Where a case sits on the price ladder, as a number of pips on the lid.
 *
 * A card should say something about cost before the price label is read, and
 * counting up to five marks is faster than comparing four-digit numbers. The
 * thresholds are in minor units and match the storefront's own price bands
 * closely enough for a decoration.
 */
function pips(priceMinor: number): number {
  if (priceMinor <= 0) return 0;
  if (priceMinor < 5_000) return 1;
  if (priceMinor < 20_000) return 2;
  if (priceMinor < 100_000) return 3;
  if (priceMinor < 1_000_000) return 4;
  return 5;
}

export interface CaseArtInput {
  slug: string;
  name: string;
  /** Category slug, or null for an ungrouped case. */
  categorySlug: string | null;
  /** Price in minor units — it decides the pips, nothing else. */
  priceMinor: number;
}

/**
 * Renders the SVG for one case.
 *
 * Fixed 320x240 viewBox with no external references: no fonts to load, no
 * raster to fetch, and the file renders the same in an `<img>`, in the admin
 * preview and in whatever the operator opens it with.
 */
export function renderCaseArt(input: CaseArtInput): string {
  const palette = PALETTES[input.categorySlug ?? ''] ?? FALLBACK;
  const seed = hash(input.slug);

  // Two independent draws from the same hash: one shifts the hue, the other
  // tilts the diagonal sheen, so two cases with a similar colour still differ.
  const hue = Math.round(palette.hue + ((seed % 1000) / 999) * palette.spread * 2 - palette.spread);
  const sheen = Math.round((((seed >>> 10) % 1000) / 999) * 40 - 20);

  const label = escapeXml(monogram(input.name));
  const marks = pips(input.priceMinor);
  const title = escapeXml(input.name);
  const id = `a${(seed % 0xffff).toString(16)}`;

  // The lid band and the body are two flat shapes rather than a drawn crate:
  // at the size a catalogue card actually renders, detail turns into noise.
  const body = `hsl(${hue} ${palette.saturation}% 22%)`;
  const bodyDark = `hsl(${hue} ${palette.saturation}% 12%)`;
  const lid = `hsl(${palette.accentHue} ${Math.min(palette.saturation + 14, 72)}% 46%)`;
  const lidDark = `hsl(${palette.accentHue} ${Math.min(palette.saturation + 14, 72)}% 32%)`;

  const pipRow = Array.from({ length: 5 }, (_, i) => {
    const filled = i < marks;
    return (
      `<circle cx="${124 + i * 18}" cy="196" r="4.5" ` +
      `fill="${filled ? lid : 'hsl(0 0% 100% / 0.14)'}"/>`
    );
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240" width="320" height="240" role="img" aria-labelledby="${id}t">
  <title id="${id}t">${title}</title>
  <defs>
    <linearGradient id="${id}bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${body}"/>
      <stop offset="1" stop-color="${bodyDark}"/>
    </linearGradient>
    <linearGradient id="${id}lid" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${lidDark}"/>
      <stop offset="0.5" stop-color="${lid}"/>
      <stop offset="1" stop-color="${lidDark}"/>
    </linearGradient>
    <radialGradient id="${id}glow" cx="0.5" cy="0.42" r="0.6">
      <stop offset="0" stop-color="${lid}" stop-opacity="0.45"/>
      <stop offset="1" stop-color="${lid}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="320" height="240" fill="url(#${id}bg)"/>
  <rect width="320" height="240" fill="url(#${id}glow)"/>

  <!-- The diagonal sheen: one rotated band, tilted per case. -->
  <g opacity="0.07">
    <rect x="-80" y="-40" width="60" height="360" fill="#fff"
          transform="rotate(${18 + sheen} 160 120) translate(180 0)"/>
    <rect x="-80" y="-40" width="24" height="360" fill="#fff"
          transform="rotate(${18 + sheen} 160 120) translate(268 0)"/>
  </g>

  <!-- The crate: a body, a lid band across it, and a keyhole in the middle. -->
  <g>
    <rect x="72" y="74" width="176" height="112" rx="10" fill="hsl(0 0% 0% / 0.28)"/>
    <rect x="76" y="70" width="168" height="110" rx="9" fill="${bodyDark}"
          stroke="hsl(0 0% 100% / 0.16)" stroke-width="2"/>
    <rect x="76" y="70" width="168" height="30" rx="9" fill="url(#${id}lid)"/>
    <rect x="76" y="98" width="168" height="3" fill="hsl(0 0% 0% / 0.35)"/>
    <rect x="150" y="100" width="20" height="26" rx="4" fill="${lid}" opacity="0.9"/>
    <circle cx="160" cy="113" r="4.5" fill="${bodyDark}"/>
  </g>

  <text x="160" y="160" text-anchor="middle"
        font-family="'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
        font-size="40" font-weight="700" letter-spacing="2"
        fill="hsl(0 0% 100% / 0.92)">${label}</text>

  <g>
    <text x="112" y="200" text-anchor="end"
          font-family="'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
          font-size="13" font-weight="600" letter-spacing="1.5"
          fill="hsl(0 0% 100% / 0.5)">${escapeXml((input.categorySlug ?? 'case').toUpperCase())}</text>
    ${pipRow}
  </g>
</svg>
`;
}

/** Where the art for a slug is served from, which is what goes in the database. */
export function caseArtUrl(slug: string): string {
  return `/cases/${slug}.svg`;
}
