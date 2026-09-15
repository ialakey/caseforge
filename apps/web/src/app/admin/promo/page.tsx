'use client';

import { useCallback, useEffect, useState } from 'react';
import { type PromoKind, PromoKind as Kind, translateError } from '@caseforge/shared';
import { api, ApiError } from '../../../lib/api';
import { useSettings } from '../../../lib/settings';
import { Money } from '../../../components/Money';

interface PromoCodeRow {
  id: string;
  code: string;
  kind: PromoKind;
  value: number;
  minDeposit: number;
  maxBonus: number | null;
  maxUses: number | null;
  usedCount: number;
  perUserLimit: number;
  isActive: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

const BLANK = {
  code: '',
  kind: Kind.PERCENT as PromoKind,
  value: 1000,
  minDeposit: 0,
  maxBonus: '' as number | '',
  maxUses: '' as number | '',
  perUserLimit: 1,
  isActive: true,
  expiresAt: '',
};

/**
 * Promo codes.
 *
 * Editing works by code rather than by id: typing an existing code into the
 * form loads it for editing, which is how an operator thinks about a code they
 * already advertised. `usedCount` is never sent, so fixing a typo in a live
 * code cannot reset how many times it has been redeemed.
 */
export default function AdminPromoPage() {
  const { locale } = useSettings();

  const [rows, setRows] = useState<PromoCodeRow[]>([]);
  const [form, setForm] = useState({ ...BLANK });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api<PromoCodeRow[]>('/api/admin/promo-codes'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load promo codes');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api('/api/admin/promo-codes', {
        method: 'POST',
        body: JSON.stringify({
          code: form.code,
          kind: form.kind,
          value: Number(form.value),
          minDeposit: Number(form.minDeposit),
          maxBonus: form.maxBonus === '' ? null : Number(form.maxBonus),
          maxUses: form.maxUses === '' ? null : Number(form.maxUses),
          perUserLimit: Number(form.perUserLimit),
          isActive: form.isActive,
          startsAt: null,
          expiresAt: form.expiresAt === '' ? null : new Date(form.expiresAt).toISOString(),
        }),
      });
      setNotice(`Saved ${form.code.toUpperCase()}`);
      setForm({ ...BLANK });
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError ? translateError(locale, err.code, err.message) : 'Save failed',
      );
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(id: string): Promise<void> {
    try {
      await api(`/api/admin/promo-codes/${id}/deactivate`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not deactivate');
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Promo codes</h1>

      {error && (
        <p className="rounded-lg bg-negative/15 px-3 py-2 text-sm text-negative">{error}</p>
      )}
      {notice && (
        <p className="rounded-lg bg-positive/15 px-3 py-2 text-sm text-positive">{notice}</p>
      )}

      <section className="cf-panel p-5">
        <h2 className="mb-1 font-medium">Create or edit</h2>
        <p className="mb-4 text-xs text-ink-faint">
          A code that already exists is overwritten, keeping its redemption count. Percentage
          values are basis points: 1000 = 10%. Money is in minor units.
        </p>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Labelled label="Code">
            <input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              placeholder="WELCOME"
              className="w-full rounded-lg border border-edge-subtle bg-surface-overlay px-3 py-2 text-sm uppercase outline-none focus:border-accent/60"
            />
          </Labelled>

          <Labelled label="Kind">
            <div className="flex gap-1.5">
              {([Kind.PERCENT, Kind.FIXED] as PromoKind[]).map((k) => (
                <button
                  key={k}
                  data-active={form.kind === k}
                  onClick={() => setForm({ ...form, kind: k })}
                  className="cf-chip px-3 py-1.5"
                >
                  {k === Kind.PERCENT ? '%' : 'Fixed'}
                </button>
              ))}
            </div>
          </Labelled>

          <NumberField
            label={form.kind === Kind.PERCENT ? 'Value, bps' : 'Value, minor'}
            value={form.value}
            onChange={(v) => setForm({ ...form, value: v as number })}
          />
          <NumberField
            label="Min top-up, minor"
            value={form.minDeposit}
            onChange={(v) => setForm({ ...form, minDeposit: v as number })}
          />
          <NumberField
            label="Max bonus, minor"
            value={form.maxBonus}
            placeholder="no cap"
            onChange={(v) => setForm({ ...form, maxBonus: v })}
          />
          <NumberField
            label="Total uses"
            value={form.maxUses}
            placeholder="unlimited"
            onChange={(v) => setForm({ ...form, maxUses: v })}
          />
          <NumberField
            label="Uses per player"
            value={form.perUserLimit}
            onChange={(v) => setForm({ ...form, perUserLimit: v as number })}
          />
          <Labelled label="Expires">
            <input
              type="date"
              value={form.expiresAt}
              onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
              className="w-full rounded-lg border border-edge-subtle bg-surface-overlay px-3 py-2 text-sm outline-none focus:border-accent/60"
            />
          </Labelled>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={() => void save()}
            disabled={busy || form.code.trim().length < 3}
            className="cf-btn-primary px-5 py-2 text-sm"
          >
            {busy ? 'Saving...' : 'Save code'}
          </button>
          <button
            data-active={form.isActive}
            onClick={() => setForm({ ...form, isActive: !form.isActive })}
            className="cf-chip px-3 py-1.5"
          >
            {form.isActive ? 'Active' : 'Inactive'}
          </button>
        </div>
      </section>

      <section className="cf-panel overflow-hidden">
        <h2 className="border-b border-edge-subtle px-5 py-4 font-medium">
          Existing codes <span className="text-ink-faint">{rows.length}</span>
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-overlay/60 text-xs uppercase tracking-wide text-ink-faint">
              <tr>
                <th className="px-5 py-2.5">Code</th>
                <th className="px-3 py-2.5">Bonus</th>
                <th className="px-3 py-2.5">Min top-up</th>
                <th className="px-3 py-2.5">Used</th>
                <th className="px-3 py-2.5">Per player</th>
                <th className="px-3 py-2.5">Expires</th>
                <th className="px-3 py-2.5">State</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-t border-edge-subtle/60">
                  <td className="px-5 py-2.5 font-mono">{p.code}</td>
                  <td className="px-3 py-2.5">
                    {p.kind === Kind.PERCENT ? (
                      <>
                        {(p.value / 100).toFixed(p.value % 100 === 0 ? 0 : 2)}%
                        {p.maxBonus !== null && (
                          <span className="text-ink-faint">
                            {' '}
                            up to <Money value={p.maxBonus} />
                          </span>
                        )}
                      </>
                    ) : (
                      <Money value={p.value} className="text-accent" />
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-ink-muted">
                    <Money value={p.minDeposit} />
                  </td>
                  <td className="px-3 py-2.5 text-ink-muted">
                    {p.usedCount}
                    {p.maxUses !== null && ` / ${p.maxUses}`}
                  </td>
                  <td className="px-3 py-2.5 text-ink-muted">{p.perUserLimit}</td>
                  <td className="px-3 py-2.5 text-ink-muted">
                    {p.expiresAt ? p.expiresAt.slice(0, 10) : '—'}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={p.isActive ? 'text-positive' : 'text-ink-faint'}>
                      {p.isActive ? 'active' : 'off'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {p.isActive && (
                      <button
                        onClick={() => void deactivate(p.id)}
                        className="text-xs text-ink-faint hover:text-negative"
                      >
                        deactivate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-6 text-center text-ink-faint">
                    No promo codes yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-ink-faint">{label}</span>
      {children}
    </label>
  );
}

function NumberField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: number | '';
  placeholder?: string;
  onChange: (value: number | '') => void;
}) {
  return (
    <Labelled label={label}>
      <input
        type="number"
        value={value === '' ? '' : String(value)}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        className="w-full rounded-lg border border-edge-subtle bg-surface-overlay px-3 py-2 text-sm outline-none focus:border-accent/60"
      />
    </Labelled>
  );
}
