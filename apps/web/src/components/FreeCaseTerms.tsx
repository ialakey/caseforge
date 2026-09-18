'use client';

import { useEffect, useState } from 'react';
import type { FreeCaseStatus, FreeCaseTerms as Terms } from '@caseforge/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/store';
import { useSettings } from '../lib/settings';
import { useMoneyFormatter } from './Money';

/**
 * What a free case asks before it opens, and how far the player has got.
 *
 * Shown as progress rather than as a refusal. "Top up 1000 over 24 hours; you
 * have 600" tells a player what to do next; a disabled button with no
 * explanation tells them the site is broken. The terms render for signed-out
 * visitors too — deciding whether to register is exactly when somebody wants
 * to know the terms.
 *
 * `onStatus` hands the answer back up so the opener can disable its own button
 * from the same numbers, rather than deriving the rule a second time.
 */
export function FreeCaseTerms({
  slug,
  terms,
  onStatus,
}: {
  slug: string;
  terms: Terms;
  onStatus?: (status: FreeCaseStatus | null) => void;
}) {
  const { user } = useAuth();
  const { locale, t } = useSettings();
  const money = useMoneyFormatter();
  const [status, setStatus] = useState<FreeCaseStatus | null>(null);

  useEffect(() => {
    if (!user) {
      setStatus(null);
      onStatus?.(null);
      return;
    }
    let cancelled = false;
    void api<FreeCaseStatus>(`/api/cases/${slug}/free-status`)
      .then((data) => {
        if (cancelled) return;
        setStatus(data);
        onStatus?.(data);
      })
      // A status that cannot be fetched leaves the terms on screen and the
      // progress off it. The server checks them again on open regardless, so
      // the worst case is a player who has to click to find out.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // `onStatus` is deliberately not a dependency: the parent recreates the
    // callback on every render, and including it would refetch in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, user]);

  const depositOk = status !== null && status.deposited >= terms.minDeposit;
  const opensLeft = status === null ? terms.maxOpens : terms.maxOpens - status.opened;

  return (
    <div className="cf-panel space-y-2 p-4 text-sm">
      <p className="font-medium text-accent">{t('case.free.title')}</p>

      <ul className="space-y-1.5">
        {terms.minDeposit > 0 && (
          <Requirement met={depositOk} pending={status === null}>
            {t('case.free.deposit').replace('{amount}', money(terms.minDeposit))}
            {status !== null && (
              <span className="block text-xs text-ink-faint">
                {t('case.free.depositSoFar').replace('{amount}', money(status.deposited))}
              </span>
            )}
          </Requirement>
        )}

        <Requirement met={opensLeft > 0} pending={status === null}>
          {t('case.free.limit').replace('{count}', String(terms.maxOpens))}
          {status !== null && (
            <span className="block text-xs text-ink-faint">
              {t('case.free.opened').replace('{count}', String(status.opened))}
              {status.nextOpenAt && (
                <> · {t('case.free.next').replace('{time}', formatWhen(status.nextOpenAt, locale))}</>
              )}
            </span>
          )}
        </Requirement>
      </ul>
    </div>
  );
}

/** One line of the checklist, with the state of it in the marker. */
function Requirement({
  met,
  pending,
  children,
}: {
  met: boolean;
  pending: boolean;
  children: React.ReactNode;
}) {
  // Three states, not two: before the status arrives — and for a visitor who
  // is not signed in — the requirement is neither met nor failed, and a red
  // cross against somebody who has not even logged in is a lie.
  const marker = pending ? '•' : met ? '✓' : '✕';
  const tone = pending ? 'text-ink-faint' : met ? 'text-positive' : 'text-negative';

  return (
    <li className="flex gap-2">
      <span className={`shrink-0 ${tone}`} aria-hidden>
        {marker}
      </span>
      <span className="text-ink-muted">{children}</span>
    </li>
  );
}

/** The time of day the next opening unlocks, in the viewer's locale. */
function formatWhen(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    day: 'numeric',
    month: 'short',
  });
}
