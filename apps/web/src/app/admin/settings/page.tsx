'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  type Locale,
  type PublicSettingDef,
  type SettingGroup,
  type TranslationKey,
  SETTING_GROUPS,
  translateError,
  translateSetting,
} from '@caseforge/shared';
import Link from 'next/link';
import { api, ApiError } from '../../../lib/api';
import { useSettings } from '../../../lib/settings';

interface SettingsPayload {
  definitions: Record<string, PublicSettingDef>;
  values: Record<string, unknown>;
}

const GROUP_TITLES: Record<SettingGroup, TranslationKey> = {
  site: 'admin.settings.group.site',
  appearance: 'admin.settings.group.appearance',
  deposits: 'admin.settings.group.deposits',
  economy: 'admin.settings.group.economy',
  limits: 'admin.settings.group.limits',
  bonus: 'admin.settings.group.bonus',
  battles: 'admin.settings.group.battles',
  referral: 'admin.settings.group.referral',
  withdrawals: 'admin.settings.group.withdrawals',
};

/**
 * Runtime settings.
 *
 * The form is generated from the registry the server sends rather than written
 * out field by field, so a setting added in the shared package appears here
 * with no change to this file. That is the whole point of keeping the registry
 * in one place: "configurable" should be a property of the system rather than a
 * list somebody has to remember to extend in three places.
 */
export default function AdminSettingsPage() {
  const { locale, t } = useSettings();

  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const values = await api<Record<string, unknown>>('/api/admin/settings', {
        method: 'POST',
        body: JSON.stringify({ values: draft }),
      });
      setPayload((p) => (p ? { ...p, values } : p));
      setDraft(values);
      setNotice(t('admin.saved'));
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

  if (!payload) {
    return <p className="text-ink-muted">{error ?? t('admin.loading')}</p>;
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(payload.values);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t('admin.settings.title')}</h1>
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

      {SETTING_GROUPS.map((group) => {
        const keys = Object.keys(payload.definitions).filter(
          (k) => payload.definitions[k]!.group === group,
        );
        if (keys.length === 0) return null;

        return (
          <section key={group} className="cf-panel p-5">
            <h2 className="mb-1 font-medium">{t(GROUP_TITLES[group])}</h2>
            {/* The appearance keys are ordinary settings and render here like
                any others, but filling in thirty-nine of them down a single
                column is not how anybody wants to design a site. */}
            {group === 'appearance' && (
              <p className="mb-4 text-xs text-ink-muted">
                <Link href="/admin/appearance" className="text-accent hover:underline">
                  {t('admin.settings.appearanceLink')}
                </Link>
              </p>
            )}
            <div className="space-y-4">
              {keys.map((key) => (
                <Field
                  key={key}
                  settingKey={key}
                  def={payload.definitions[key]!}
                  value={draft[key]}
                  locale={locale}
                  onChange={(v) => setDraft((d) => ({ ...d, [key]: v }))}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Field({
  settingKey,
  def,
  value,
  locale,
  onChange,
}: {
  settingKey: string;
  def: PublicSettingDef;
  value: unknown;
  locale: Locale;
  onChange: (value: unknown) => void;
}) {
  const { t } = useSettings();

  // The registry describes itself in English on the server; the panel looks the
  // key up locally and only falls back to what it was sent.
  const label = translateSetting(locale, settingKey, 'label', def.label) ?? def.label;
  const hint = translateSetting(locale, settingKey, 'hint', def.hint);

  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_280px] sm:items-start">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="font-mono text-[11px] text-ink-faint">{settingKey}</div>
        {hint && <div className="mt-0.5 text-xs text-ink-muted">{hint}</div>}
      </div>

      {def.kind === 'boolean' ? (
        <button
          onClick={() => onChange(!value)}
          data-active={Boolean(value)}
          className="cf-chip w-fit px-3 py-1.5"
        >
          {value ? t('admin.on') : t('admin.off')}
        </button>
      ) : def.kind === 'enum' ? (
        // The options come from the registry with the value, so the panel can
        // never offer a choice the server would refuse to save.
        <div className="flex flex-wrap gap-2">
          {(def.options ?? []).map((option) => (
            <button
              key={option}
              onClick={() => onChange(option)}
              data-active={value === option}
              className="cf-chip px-3 py-1.5"
            >
              {option}
            </button>
          ))}
        </div>
      ) : def.kind === 'json' ? (
        <JsonField value={value} onChange={onChange} />
      ) : def.kind === 'color' ? (
        <ColorField value={String(value ?? '')} onChange={onChange} />
      ) : def.kind === 'text' ? (
        <textarea
          value={String(value ?? '')}
          rows={3}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-lg border border-edge-subtle bg-surface-overlay px-3 py-2 text-sm outline-none focus:border-accent/60"
        />
      ) : def.kind === 'string' || def.kind === 'url' ? (
        <input
          type="text"
          value={String(value ?? '')}
          placeholder={def.kind === 'url' ? 'https://…' : undefined}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-lg border border-edge-subtle bg-surface-overlay px-3 py-2 text-sm outline-none focus:border-accent/60"
        />
      ) : (
        <input
          type="number"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          className="w-full rounded-lg border border-edge-subtle bg-surface-overlay px-3 py-2 text-sm outline-none focus:border-accent/60"
        />
      )}
    </div>
  );
}

/**
 * A JSON setting, edited as text.
 *
 * The wheel is the only one of these today. Text rather than a bespoke slice
 * editor because the server validates the shape anyway and rejects a wheel
 * whose shares do not add up — a purpose-built form would be a second place to
 * keep those rules in step.
 */
function JsonField({ value, onChange }: { value: unknown; onChange: (value: unknown) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [invalid, setInvalid] = useState(false);

  // Re-sync when a save replaces the value from the server.
  useEffect(() => {
    setText(JSON.stringify(value, null, 2));
    setInvalid(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value)]);

  return (
    <div className="w-full">
      <textarea
        value={text}
        rows={12}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value));
            setInvalid(false);
          } catch {
            // Keep the text so the operator can carry on typing; the save
            // button still holds the last value that parsed.
            setInvalid(true);
          }
        }}
        className={`w-full rounded-lg border bg-surface-overlay px-3 py-2 font-mono text-[11px] outline-none ${
          invalid ? 'border-negative' : 'border-edge-subtle focus:border-accent/60'
        }`}
      />
      {invalid && <p className="mt-1 text-xs text-negative">Not valid JSON yet</p>}
    </div>
  );
}

/**
 * A colour, picked or typed.
 *
 * Both, because the two ways of arriving at a colour are different jobs: a
 * brand palette is pasted as a hex string, and a shade is nudged with the
 * picker. The text box is the source of truth — it accepts what the server
 * accepts — and the swatch is what makes a wrong value obvious immediately.
 */
function ColorField({ value, onChange }: { value: string; onChange: (value: unknown) => void }) {
  const valid = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());

  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={valid ? value : '#000000'}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-12 cursor-pointer rounded border border-edge-subtle bg-surface-overlay"
        aria-label="colour picker"
      />
      <input
        type="text"
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full rounded-lg border bg-surface-overlay px-3 py-2 font-mono text-sm outline-none ${
          valid ? 'border-edge-subtle focus:border-accent/60' : 'border-negative'
        }`}
      />
    </div>
  );
}
