import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  APPEARANCE_SECTIONS,
  DEFAULT_APPEARANCE,
  DEFAULT_THEME,
  THEME_PRESETS,
  appearanceCssVariables,
  buildAppearance,
  hexToHslTriplet,
  isHexColor,
  pickLocalised,
} from './appearance.ts';

test('hex converts to the HSL triple the stylesheet expects', () => {
  // The contract with globals.css: bare components, so a rule can write
  // hsl(var(--accent) / 0.14) without a second variable per opacity.
  assert.equal(hexToHslTriplet('#000000'), '0 0% 0%');
  assert.equal(hexToHslTriplet('#ffffff'), '0 0% 100%');
  assert.equal(hexToHslTriplet('#ff0000'), '0 100% 50%');
  assert.equal(hexToHslTriplet('#00ff00'), '120 100% 50%');
  assert.equal(hexToHslTriplet('#0000ff'), '240 100% 50%');
});

test('the short hex form means the same colour as the long one', () => {
  assert.equal(hexToHslTriplet('#f0a'), hexToHslTriplet('#ff00aa'));
  assert.equal(hexToHslTriplet('#FFF'), hexToHslTriplet('#ffffff'));
});

test('a colour is accepted in both forms and nothing else', () => {
  assert.equal(isHexColor('#0d0f12'), true);
  assert.equal(isHexColor('#abc'), true);
  assert.equal(isHexColor('  #ABCDEF  '), true);
  assert.equal(isHexColor('0d0f12'), false);
  assert.equal(isHexColor('#12345'), false);
  assert.equal(isHexColor('rgb(1,2,3)'), false);
});

test('an unset text falls back to null, and one language covers both', () => {
  // Null rather than an empty string, because the caller has a translated
  // default and `??` has to be able to see the absence.
  assert.equal(pickLocalised('ru', { ru: '', en: '' }), null);
  assert.equal(pickLocalised('ru', { ru: 'Привет', en: 'Hello' }), 'Привет');
  assert.equal(pickLocalised('en', { ru: 'Привет', en: 'Hello' }), 'Hello');
  // Written in one language only: it was meant to be seen.
  assert.equal(pickLocalised('en', { ru: 'Только по-русски', en: '' }), 'Только по-русски');
  assert.equal(pickLocalised('ru', { ru: '   ', en: 'English only' }), 'English only');
});

test('an empty settings table produces the shipped defaults', () => {
  const config = buildAppearance(() => undefined);
  assert.deepEqual(config, DEFAULT_APPEARANCE);
});

test('a nonsense colour is ignored rather than rendered', () => {
  // The registry validates on the way in, so this is the second line of
  // defence: a value edited straight in the database must not take the site's
  // palette down with it.
  const config = buildAppearance((key) =>
    key === 'appearance.accent' ? 'not a colour' : undefined,
  );
  assert.equal(config.theme.accent, DEFAULT_THEME.accent);
});

test('the flat settings map becomes the nested configuration', () => {
  const values: Record<string, unknown> = {
    'appearance.siteName': ' SkinForge ',
    'appearance.taglineEn': 'Open cases, keep the odds',
    'appearance.accent': '#34d399',
    'appearance.radiusPx': 4,
    'appearance.glow': false,
    'appearance.heroEnabled': false,
    'appearance.heroTitleRu': 'Кейсы честно',
    'appearance.navBonus': false,
    'appearance.socialTelegram': 'https://t.me/example',
    'appearance.logoUrl': '',
  };
  const config = buildAppearance((key) => values[key]);

  assert.equal(config.siteName, 'SkinForge');
  assert.equal(config.tagline.en, 'Open cases, keep the odds');
  assert.equal(config.theme.accent, '#34d399');
  assert.equal(config.theme.radiusPx, 4);
  assert.equal(config.theme.glow, false);
  assert.equal(config.hero.enabled, false);
  assert.equal(config.hero.title.ru, 'Кейсы честно');
  assert.equal(config.nav.bonus, false);
  assert.equal(config.nav.battles, true, 'an unset flag keeps its default');
  assert.equal(config.footer.telegram, 'https://t.me/example');
  assert.equal(config.logoUrl, null, 'an empty URL is no URL');
});

test('every theme value reaches a CSS variable', () => {
  const vars = appearanceCssVariables(DEFAULT_APPEARANCE);
  for (const name of [
    '--surface-base',
    '--surface-raised',
    '--surface-overlay',
    '--surface-hover',
    '--border-subtle',
    '--border-strong',
    '--text-primary',
    '--text-muted',
    '--text-faint',
    '--accent',
    '--accent-strong',
    '--positive',
    '--negative',
    '--radius',
    '--glow-strength',
  ]) {
    assert.ok(vars[name], `${name} is missing`);
  }
  assert.equal(vars['--accent'], hexToHslTriplet(DEFAULT_THEME.accent));
  assert.equal(vars['--radius'], '12px');
});

test('the derived surfaces stay brighter than what they sit on', () => {
  // Hover and the borders are derived rather than configured, so a preset that
  // moves the overlay cannot leave them pointing at the old palette.
  for (const preset of THEME_PRESETS) {
    const vars = appearanceCssVariables({ ...DEFAULT_APPEARANCE, theme: preset.theme });
    const lightness = (triple: string) => parseFloat(triple.split(' ')[2]!);
    assert.ok(
      lightness(vars['--surface-hover']!) >= lightness(hexToHslTriplet(preset.theme.surfaceOverlay)),
      `${preset.key}: hover is not brighter than the overlay`,
    );
    assert.ok(
      lightness(vars['--border-strong']!) > lightness(vars['--border-subtle']!),
      `${preset.key}: the strong border is not stronger`,
    );
  }
});

test('every preset is a complete, valid theme', () => {
  assert.ok(THEME_PRESETS.length >= 3);
  for (const preset of THEME_PRESETS) {
    for (const [name, value] of Object.entries(preset.theme)) {
      if (typeof value === 'string') {
        assert.equal(isHexColor(value), true, `${preset.key}.${name} is not a colour`);
      }
    }
    assert.ok(preset.theme.radiusPx >= 0);
  }
});

test('the builder page lists fields that actually exist', () => {
  // The sections drive a layout; a key that no longer exists would render an
  // empty control with no hint that it is broken.
  const listed = APPEARANCE_SECTIONS.flatMap((section) => section.fields);
  assert.equal(new Set(listed).size, listed.length, 'a field is listed twice');
  for (const key of listed) {
    assert.ok(key.startsWith('appearance.'), `${key} is not an appearance setting`);
  }
});
