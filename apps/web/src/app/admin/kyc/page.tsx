'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import { useSettings } from '../../../lib/settings';

interface DocumentRow {
  id: string;
  kind: string;
  contentType: string;
  byteSize: number;
}

interface ApplicationRow {
  id: string;
  status: string;
  fullName: string;
  dateOfBirth: string;
  country: string;
  documentNo: string;
  reviewNote: string | null;
  submittedAt: string;
  user: { id: string; username: string; steamId64: string };
  documents: DocumentRow[];
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * The identity review queue.
 *
 * Pending first and oldest first, because that is the order somebody actually
 * works in: a queue sorted by anything else is a list. Documents open in a new
 * tab through an authenticated endpoint rather than being embedded — a passport
 * scan inlined into a page is a passport scan in the browser cache of whoever
 * left the tab open.
 */
export default function AdminKycPage() {
  const { locale, t } = useSettings();
  const [rows, setRows] = useState<ApplicationRow[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ items: ApplicationRow[] }>('/api/admin/kyc?status=PENDING&perPage=50');
      setRows(data.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(id: string, approve: boolean): Promise<void> {
    const note = notes[id]?.trim() ?? '';
    // Mirrors the server rule rather than letting the operator discover it as
    // a 400: a rejection without a reason is one the player cannot act on.
    if (!approve && note.length === 0) {
      setError(t('admin.kyc.note'));
      return;
    }
    setBusy(id);
    setError(null);
    try {
      await api(`/api/admin/kyc/${id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ approve, note: note || null }),
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t('admin.kyc.title')}</h1>
        <p className="mt-1 text-sm text-neutral-500">{t('admin.kyc.hint')}</p>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {loading ? (
        <p className="text-neutral-400">…</p>
      ) : rows.length === 0 ? (
        <p className="text-neutral-400">{t('admin.kyc.empty')}</p>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <section
              key={row.id}
              className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4"
            >
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="font-medium">{row.user.username}</span>
                <span className="text-xs text-neutral-500">{row.user.steamId64}</span>
                <span className="ml-auto text-xs text-neutral-500">
                  {new Date(row.submittedAt).toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU')}
                </span>
              </div>

              <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <Field label={t('admin.kyc.name')} value={row.fullName} />
                <Field
                  label={t('admin.kyc.born')}
                  value={new Date(row.dateOfBirth).toLocaleDateString(
                    locale === 'en' ? 'en-US' : 'ru-RU',
                  )}
                />
                <Field label={t('admin.kyc.country')} value={row.country} />
                <Field label={t('admin.kyc.docNo')} value={row.documentNo} />
              </dl>

              <div className="flex flex-wrap gap-2">
                {row.documents.map((doc) => (
                  <a
                    key={doc.id}
                    href={`${API_URL}/api/admin/kyc/documents/${doc.id}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700"
                  >
                    {doc.kind} · {Math.round(doc.byteSize / 1024)} KB
                  </a>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={notes[row.id] ?? ''}
                  onChange={(e) => setNotes((prev) => ({ ...prev, [row.id]: e.target.value }))}
                  placeholder={t('admin.kyc.note')}
                  className="min-w-[240px] flex-1 rounded bg-neutral-800 px-3 py-1.5 text-sm"
                />
                <button
                  onClick={() => void decide(row.id, true)}
                  disabled={busy === row.id}
                  className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
                >
                  {t('admin.kyc.approve')}
                </button>
                <button
                  onClick={() => void decide(row.id, false)}
                  disabled={busy === row.id}
                  className="rounded bg-neutral-800 px-4 py-1.5 text-sm hover:bg-neutral-700 disabled:opacity-40"
                >
                  {t('admin.kyc.reject')}
                </button>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
