'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type AppearanceConfig,
  type PublicSettingDef,
  type TranslationKey,
  APPEARANCE_SECTIONS,
  THEME_PRESETS,
  appearanceCssVariables,
  buildAppearance,
  translateError,
  translateSetting,
} from '@caseforge/shared';
import { api, ApiError } from '../../../lib/api';
import { useSettings } from '../../../lib/settings';

interface SettingsPayload {
  definitions: Record<string, PublicSettingDef>;
  values: Record<string, unknown>;
}

const SECTION_TITLES: Record<string, TranslationKey> = {
  brand: 'admin.appearance.section.brand',
  theme: 'admin.appearance.section.theme',
  hero: 'admin.appearance.section.hero',
  nav: 'admin.appearance.section.nav',
  dropFeed: 'admin.appearance.section.dropFeed',
  home: 'admin.appearance.section.home',
  profiles: 'admin.appearance.section.profiles',
  footer: 'admin.appearance.section.footer',
  seo: 'admin.appearance.section.seo',
};

/**
 * The site builder.
 *
 * Everything here is an ordinary setting and could be edited on the settings
 * page — this exists because designing a site down a single column of
 * thirty-nine fields is not designing a site. Three things make it a builder
 * rather than a longer form: the fields are grouped the way somebody thinks
 * about a page, the palette previews itself as it is edited, and the real site
 * sits next to it in an iframe.
 *
 * The preview panel is drawn from the draft rather than fetched, so a colour
 * responds to the picker immediately. The iframe shows the saved state, which
 * is the honest thing for it to show: it is the site as a visitor would get it.
 */
export default function AdminAppearancePage() {
  const { locale, t } = useSettings();

  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Bumped after a save so the iframe reloads with the new appearance. */
  const [previewNonce, setPreviewNonce] = useState(0);

  const load = useCallback(async () => {
    try {
      const data = await api<SettingsPayload>('/api/admin/settings');
      setPayload(data);
      setDraft(data.values);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('admin.settings.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The draft, as the site would read it. */
  const preview: AppearanceConfig = useMemo(() => buildAppearance((key) => draft[key]), [draft]);
  const previewVars = useMemo(() => appearanceCssVariables(preview), [preview]);

  const appearanceKeys = useMemo(
    () => APPEARANCE_SECTIONS.flatMap((section) => section.fields),
    [],
  );
  const dirty = appearanceKeys.some(
    (key) => JSON.stringify(draft[key]) !== JSON.stringify(payload?.values[key]),
  );

  function set(key: string, value: unknown): void {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function save(): Promise<void> {
    if (!payload) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // Only this page's keys travel: sending the whole map would let an open
      // builder tab overwrite a limit somebody changed on the settings page.
      const values = Object.fromEntries(appearanceKeys.map((key) => [key, draft[key]]));
      const saved = await api<Record<string, unknown>>('/api/admin/settings', {
        method: 'POST',
        body: JSON.stringify({ values }),
      });
      setPayload({ ...payload, values: { ...payload.values, ...saved } });
      setDraft((current) => ({ ...current, ...saved }));
      setNotice(t('admin.saved'));
      setPreviewNonce((n) => n + 1);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? translateError(locale, err.code, err.message)
          : t('admin.saveFailed'),
      );
    } finally {
      setBusy(false);
    }
  }

  function applyPreset(key: string): void {
    const preset = THEME_PRESETS.find((candidate) => candidate.key === key);
    if (!preset) return;
    setDraft((current) => ({
      ...current,
      'appearance.accent': preset.theme.accent,
      'appearance.accentStrong': preset.theme.accentStrong,
      'appearance.positive': preset.theme.positive,
      'appearance.negative': preset.theme.negative,
      'appearance.surfaceBase': preset.theme.surfaceBase,
      'appearance.surfaceRaised': preset.theme.surfaceRaised,
      'appearance.surfaceOverlay': preset.theme.surfaceOverlay,
      'appearance.textPrimary': preset.theme.textPrimary,
      'appearance.glow': preset.theme.glow,
    }));
  }

  function resetSection(fields: readonly string[]): void {
    if (!payload) return;
    setDraft((current) => {
      const next = { ...current };
      for (const key of fields) next[key] = payload.definitions[key]?.default;
      return next;
    });
  }

  if (!payload) {
    return <p className="text-ink-muted">{error ?? t('admin.loading')}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t('admin.appearance.title')}</h1>
          <p className="mt-1 max-w-3xl text-sm text-ink-faint">{t('admin.appearance.intro')}</p>
        </div>
        <button
          onClick={() => void save()}
          disabled={!dirty || busy}
          className="cf-btn-primary px-5 py-2 text-sm"
        >
          {busy ? t('common.saving') : t('common.save')}
        </button>
      </div>

      {error && (
        <p className="rounded-lg bg-negative/15 px-3 py-2 text-sm text-negative">{error}</p>
      )}
      {notice && (
        <p className="rounded-lg bg-positive/15 px-3 py-2 text-sm text-positive">{notice}</p>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-5">
          {APPEARANCE_SECTIONS.map((section) => (
            <section key={section.key} className="cf-panel space-y-4 p-5">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="font-medium">{t(SECTION_TITLES[section.key]!)}</h2>
                <button
                  onClick={() => resetSection(section.fields)}
                  className="text-xs text-ink-faint hover:text-ink-muted"
                >
                  {t('admin.appearance.resetSection')}
                </button>
              </div>

              {section.key === 'theme' && (
                <div className="flex flex-wrap items-center gap-2 border-b border-edge-subtle pb-4">
                  <span className="text-xs text-ink-faint">{t('admin.appearance.presets')}</span>
                  {THEME_PRESETS.map((preset) => (
                    <button
                      key={preset.key}
                      onClick={() => applyPreset(preset.key)}
                      title={preset.label}
                      className="flex items-center gap-1.5 cf-chip px-2.5 py-1.5"
                    >
                      <span
                        className="h-3 w-3 rounded-full"
                        style={{ background: preset.theme.accent }}
                      />
                      <span
                        className="h-3 w-3 rounded-full border border-white/10"
                        style={{ background: preset.theme.surfaceBase }}
                      />
                      {t(`admin.appearance.preset.${preset.key}` as TranslationKey)}
                    </button>
                  ))}
                </div>
              )}

              <div className="space-y-3">
                {section.fields.map((key) => (
                  <BuilderField
                    key={key}
                    settingKey={key}
                    def={payload.definitions[key]}
                    value={draft[key]}
                    onChange={(value) => set(key, value)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>

        {/* The preview column sticks: the fields are long and a preview you have
            to scroll back to is a preview nobody looks at. */}
        <div className="space-y-4 xl:sticky xl:top-24 xl:self-start">
          <section className="cf-panel p-4">
            <h2 className="mb-3 text-sm font-medium">{t('admin.appearance.previewPanel')}</h2>

            {/* A miniature of the site's own primitives, drawn with the draft's
                variables. It answers the question the pickers cannot: whether
                the colours work together. */}
            <div
              style={previewVars as React.CSSProperties}
              className="space-y-3 rounded-xl border p-4"
            >
              <div
                style={{
                  background: 'hsl(var(--surface-base))',
                  borderColor: 'hsl(var(--border-subtle))',
                  color: 'hsl(var(--text-primary))',
                  borderRadius: 'var(--radius)',
                }}
                className="space-y-3 border p-4"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold">
                    {preview.siteName.slice(0, Math.ceil(preview.siteName.length / 2))}
                    <span style={{ color: 'hsl(var(--accent))' }}>
                      {preview.siteName.slice(Math.ceil(preview.siteName.length / 2))}
                    </span>
                  </span>
                  <span style={{ color: 'hsl(var(--accent))' }} className="text-sm font-semibold">
                    1 234,56 ₽
                  </span>
                </div>

                <div
                  style={{
                    background: 'hsl(var(--surface-raised))',
                    borderColor: 'hsl(var(--border-subtle))',
                    borderRadius: 'var(--radius)',
                  }}
                  className="border p-3"
                >
                  <div className="text-sm" style={{ color: 'hsl(var(--text-primary))' }}>
                    {t('admin.appearance.previewCase')}
                  </div>
                  <div className="text-xs" style={{ color: 'hsl(var(--text-faint))' }}>
                    {t('admin.appearance.previewHintLine')}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span
                    style={{
                      backgroundImage:
                        'linear-gradient(180deg, hsl(var(--accent)), hsl(var(--accent-strong)))',
                      borderRadius: 'calc(var(--radius) * 0.7)',
                      boxShadow:
                        '0 6px 20px -8px hsl(var(--accent) / calc(0.8 * var(--glow-strength)))',
                    }}
                    className="px-3 py-1.5 text-xs font-semibold text-neutral-950"
                  >
                    {t('admin.appearance.previewButton')}
                  </span>
                  <span
                    style={{
                      background: 'hsl(var(--surface-overlay))',
                      borderColor: 'hsl(var(--border-subtle))',
                      color: 'hsl(var(--text-muted))',
                      borderRadius: '9999px',
                    }}
                    className="border px-3 py-1.5 text-xs"
                  >
                    {t('admin.appearance.previewChip')}
                  </span>
                  <span style={{ color: 'hsl(var(--positive))' }} className="text-xs">
                    +12%
                  </span>
                  <span style={{ color: 'hsl(var(--negative))' }} className="text-xs">
                    −4%
                  </span>
                </div>
              </div>
            </div>
          </section>

          <section className="cf-panel space-y-2 p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium">{t('admin.appearance.preview')}</h2>
              <a
                href="/"
                target="_blank"
                rel="noreferrer"
                className="text-xs text-accent hover:underline"
              >
                {t('admin.appearance.openSite')}
              </a>
            </div>
            <p className="text-xs text-ink-faint">{t('admin.appearance.previewHint')}</p>
            {/* Scaled down rather than narrowed: a 1200px viewport squeezed into
                400px would show the site's mobile layout, which is not what is
                being reviewed. */}
            <div className="h-[420px] overflow-hidden rounded-lg border border-edge-subtle">
              <iframe
                key={previewNonce}
                src="/"
                title={t('admin.appearance.preview')}
                className="h-[1050px] w-[1200px] origin-top-left"
                style={{ transform: 'scale(0.35)' }}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * One field in the builder.
 *
 * Narrower than the settings page's version on purpose: no key, no group, and
 * the label above the control rather than beside it. Somebody designing a site
 * is reading the labels, not the setting names.
 */
function BuilderField({
  settingKey,
  def,
  value,
  onChange,
}: {
  settingKey: string;
  def: PublicSettingDef | undefined;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { locale, t } = useSettings();
  if (!def) return null;

  const label = translateSetting(locale, settingKey, 'label', def.label) ?? def.label;
  const hint = translateSetting(locale, settingKey, 'hint', def.hint);

  const input =
    def.kind === 'boolean' ? (
      <button
        onClick={() => onChange(!value)}
        data-active={Boolean(value)}
        className="cf-chip w-fit px-3 py-1.5"
      >
        {value ? t('admin.on') : t('admin.off')}
      </button>
    ) : def.kind === 'color' ? (
      <ColorInput value={String(value ?? '')} onChange={onChange} />
    ) : def.kind === 'text' ? (
      <textarea
        value={String(value ?? '')}
        rows={2}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-edge-subtle bg-surface-overlay px-3 py-2 text-sm outline-none focus:border-accent/60"
      />
    ) : def.kind === 'int' ? (
      <input
        type="number"
        value={String(value ?? '')}
        onChange={(event) => onChange(event.target.value === '' ? '' : Number(event.target.value))}
        className="w-32 rounded-lg border border-edge-subtle bg-surface-overlay px-3 py-2 text-sm outline-none focus:border-accent/60"
      />
    ) : (
      <input
        type="text"
        value={String(value ?? '')}
        placeholder={def.kind === 'url' ? 'https://…' : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-edge-subtle bg-surface-overlay px-3 py-2 text-sm outline-none focus:border-accent/60"
      />
    );

  return (
    <label className="block space-y-1">
      <span className="text-sm">{label}</span>
      {input}
      {hint && <span className="block text-xs text-ink-faint">{hint}</span>}
    </label>
  );
}

function ColorInput({ value, onChange }: { value: string; onChange: (value: unknown) => void }) {
  const valid = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());

  return (
    <span className="flex items-center gap-2">
      <input
        type="color"
        value={valid ? value : '#000000'}
        onChange={(event) => onChange(event.target.value)}
        aria-label="colour picker"
        className="h-9 w-12 cursor-pointer rounded border border-edge-subtle bg-surface-overlay"
      />
      <input
        type="text"
        value={value}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        className={`w-32 rounded-lg border bg-surface-overlay px-3 py-2 font-mono text-sm outline-none ${
          valid ? 'border-edge-subtle focus:border-accent/60' : 'border-negative'
        }`}
      />
    </span>
  );
}
