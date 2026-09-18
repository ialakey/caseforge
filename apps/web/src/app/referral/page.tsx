'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  type ReferralClaimResult,
  type ReferralSummary,
  REFERRAL_QUERY_PARAM,
  translateError,
} from '@caseforge/shared';
import { api, ApiError, loginUrl } from '../../lib/api';
import { useAuth } from '../../lib/store';
import { useSettings } from '../../lib/settings';
import { Money, useMoneyFormatter } from '../../components/Money';
import { SteamAvatar } from '../../components/SteamAvatar';

export default function ReferralPage() {
  const { user, setBalance } = useAuth();
  const { locale, t } = useSettings();
  const money = useMoneyFormatter();

  const [summary, setSummary] = useState<ReferralSummary | null>(null);
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api<ReferralSummary>('/api/referral');
      setSummary(next);
      setCode(next.code);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(t('referral.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  // Built in the browser rather than on the server: the site is reached under
  // whatever host the visitor typed, and a link hard-coded to another one is a
  // link that works for nobody behind a proxy.
  const link =
    summary && typeof window !== 'undefined'
      ? `${window.location.origin}/?${REFERRAL_QUERY_PARAM}=${summary.code}`
      : '';

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard access can be refused; the field is selectable either way.
    }
  }

  async function saveCode(): Promise<void> {
    if (busy || !summary || code === summary.code) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api('/api/referral/code', { method: 'POST', body: JSON.stringify({ code }) });
      setNotice(t('referral.codeSaved'));
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? translateError(locale, err.code, err.message)
          : t('referral.codeFailed'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function claim(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<ReferralClaimResult>('/api/referral/claim', { method: 'POST' });
      setBalance(result.balanceAfter);
      setNotice(t('referral.claimDone', { amount: money(result.amount) }));
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? translateError(locale, err.code, err.message)
          : t('referral.claimFailed'),
      );
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return (
      <div className="space-y-4 text-center">
        <h1 className="text-2xl font-semibold">{t('referral.title')}</h1>
        <p className="text-ink-muted">{t('referral.signInHint')}</p>
        <a href={loginUrl} className="cf-btn-primary inline-block px-6 py-2.5">
          {t('nav.signIn')}
        </a>
      </div>
    );
  }

  if (!summary) {
    return <p className="text-center text-ink-muted">{error ?? t('common.loading')}</p>;
  }

  const claimable = summary.pending >= summary.minClaim && summary.pending > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('referral.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-faint">
          {t('referral.intro', {
            deposit: summary.depositBps / 100,
            wager: summary.wagerBps / 100,
          })}
        </p>
      </div>

      {!summary.enabled && (
        <p className="rounded bg-surface-overlay px-3 py-2 text-sm text-ink-muted">
          {t('referral.disabled')}
        </p>
      )}
      {error && <p className="rounded bg-negative/15 px-3 py-2 text-sm text-negative">{error}</p>}
      {notice && <p className="rounded bg-positive/15 px-3 py-2 text-sm text-positive">{notice}</p>}

      <section className="cf-panel space-y-4 p-5">
        <div className="space-y-1">
          <label className="text-xs uppercase tracking-wide text-ink-faint">
            {t('referral.yourLink')}
          </label>
          <div className="flex gap-2">
            <input
              readOnly
              value={link}
              onFocus={(event) => event.currentTarget.select()}
              className="flex-1 rounded-lg border border-edge-subtle bg-surface-base px-3 py-2 text-sm text-ink-muted"
            />
            <button onClick={() => void copy()} className="cf-btn-ghost px-4 py-2 text-sm">
              {copied ? t('referral.copied') : t('referral.copy')}
            </button>
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs uppercase tracking-wide text-ink-faint">
            {t('referral.yourCode')}
          </label>
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              maxLength={16}
              className="w-48 rounded-lg border border-edge-subtle bg-surface-base px-3 py-2 font-mono text-sm"
            />
            <button
              onClick={() => void saveCode()}
              disabled={busy || code === summary.code}
              className="cf-btn-ghost px-4 py-2 text-sm"
            >
              {t('referral.saveCode')}
            </button>
          </div>
          <p className="text-xs text-ink-faint">{t('referral.codeHint')}</p>
        </div>

        {summary.invitedBy && (
          <div className="flex items-center gap-2 border-t border-edge-subtle pt-3 text-sm text-ink-muted">
            <SteamAvatar
              src={summary.invitedBy.avatarUrl}
              name={summary.invitedBy.username}
              size={22}
            />
            {t('referral.invitedBy', { username: summary.invitedBy.username })}
          </div>
        )}
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <Stat label={t('referral.invited')} value={String(summary.invited)} />
        <Stat label={t('referral.pending')} value={<Money value={summary.pending} />} />
        <Stat label={t('referral.claimedTotal')} value={<Money value={summary.claimed} />} />
      </section>

      <div className="flex flex-col items-center gap-2">
        <button
          onClick={() => void claim()}
          disabled={busy || !claimable}
          className="cf-btn-primary px-8 py-2.5"
        >
          {busy ? t('referral.claiming') : `${t('referral.claim')} · ${money(summary.pending)}`}
        </button>
        {!claimable && (
          <p className="text-xs text-ink-faint">
            {t('referral.minClaim', { amount: money(summary.minClaim) })}
          </p>
        )}
      </div>

      <section className="cf-panel space-y-3 p-4">
        <h2 className="font-medium">{t('referral.invitees')}</h2>
        {summary.invitees.length === 0 ? (
          <p className="text-sm text-ink-faint">{t('referral.inviteesEmpty')}</p>
        ) : (
          <table className="w-full whitespace-nowrap text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-ink-faint">
              <tr>
                <th className="px-2 pb-2 first:pl-0 last:pr-0">{t('referral.colPlayer')}</th>
                <th className="px-2 pb-2 first:pl-0 last:pr-0">{t('referral.colJoined')}</th>
                <th className="px-2 pb-2 text-right first:pl-0 last:pr-0">
                  {t('referral.colEarned')}
                </th>
              </tr>
            </thead>
            <tbody>
              {summary.invitees.map((invitee) => (
                <tr key={invitee.userId} className="border-t border-edge-subtle">
                  <td className="px-2 py-2 first:pl-0 last:pr-0">
                    <span className="flex items-center gap-2">
                      <SteamAvatar src={invitee.avatarUrl} name={invitee.username} size={22} />
                      <span className="truncate">{invitee.username}</span>
                    </span>
                  </td>
                  <td className="px-2 py-2 text-ink-faint first:pl-0 last:pr-0">
                    {new Date(invitee.joinedAt).toLocaleDateString(locale)}
                  </td>
                  <td className="px-2 py-2 text-right first:pl-0 last:pr-0">
                    <Money value={invitee.earned} className="text-accent" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="cf-panel space-y-3 p-4">
        <h2 className="font-medium">{t('referral.earnings')}</h2>
        {summary.earnings.length === 0 ? (
          <p className="text-sm text-ink-faint">{t('referral.earningsEmpty')}</p>
        ) : (
          <table className="w-full whitespace-nowrap text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-ink-faint">
              <tr>
                <th className="px-2 pb-2 first:pl-0 last:pr-0">{t('referral.colPlayer')}</th>
                <th className="px-2 pb-2 first:pl-0 last:pr-0">{t('referral.colKind')}</th>
                <th className="px-2 pb-2 text-right first:pl-0 last:pr-0">
                  {t('referral.colSource')}
                </th>
                <th className="px-2 pb-2 text-right first:pl-0 last:pr-0">
                  {t('referral.colRate')}
                </th>
                <th className="px-2 pb-2 text-right first:pl-0 last:pr-0">
                  {t('referral.colAmount')}
                </th>
                <th className="px-2 pb-2 first:pl-0 last:pr-0">{t('referral.colStatus')}</th>
                <th className="px-2 pb-2 first:pl-0 last:pr-0">{t('referral.colWhen')}</th>
              </tr>
            </thead>
            <tbody>
              {summary.earnings.map((earning) => (
                <tr key={earning.id} className="border-t border-edge-subtle">
                  <td className="truncate px-2 py-2 first:pl-0 last:pr-0">{earning.username}</td>
                  <td className="px-2 py-2 text-ink-muted first:pl-0 last:pr-0">
                    {t(`referral.kind${earning.kind}`)}
                  </td>
                  <td className="px-2 py-2 text-right first:pl-0 last:pr-0">
                    <Money value={earning.sourceAmount} />
                  </td>
                  <td className="px-2 py-2 text-right text-ink-faint first:pl-0 last:pr-0">
                    {earning.rateBps / 100}%
                  </td>
                  <td className="px-2 py-2 text-right first:pl-0 last:pr-0">
                    <Money value={earning.amount} className="text-accent" />
                  </td>
                  <td className="px-2 py-2 text-xs text-ink-faint first:pl-0 last:pr-0">
                    {earning.claimedAt ? t('referral.statusPaid') : t('referral.statusPending')}
                  </td>
                  <td className="px-2 py-2 text-xs text-ink-faint first:pl-0 last:pr-0">
                    {new Date(earning.createdAt).toLocaleDateString(locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="cf-panel p-4">
      <div className="text-xs uppercase tracking-wide text-ink-faint">{label}</div>
      <div className="mt-1 text-xl font-semibold text-accent">{value}</div>
    </div>
  );
}
