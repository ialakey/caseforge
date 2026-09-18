'use client';

import { useEffect, useState } from 'react';
import type { SiteStats, TranslationKey } from '@caseforge/shared';
import { useSettings } from '../lib/settings';

/** How often the bar asks again. The server caches for a minute regardless. */
const REFRESH_MS = 30_000;

const FIELDS: ReadonlyArray<{ key: keyof SiteStats; label: TranslationKey }> = [
  { key: 'casesOpened', label: 'home.stats.cases' },
  { key: 'contracts', label: 'home.stats.contracts' },
  { key: 'upgrades', label: 'home.stats.upgrades' },
  { key: 'battles', label: 'home.stats.battles' },
  { key: 'users', label: 'home.stats.users' },
  { key: 'online', label: 'home.stats.online' },
];

/**
 * The counters along the top of the landing page.
 *
 * They are there to say the place is busy, which is why the component renders
 * nothing until it has an answer rather than showing six zeroes: a zero is a
 * claim, and it is the opposite of the one the bar exists to make.
 *
 * Refreshed on a timer because "online" is the one figure somebody might watch
 * change. The rest is cached on the server and will not move between polls.
 */
export function SiteStatsBar() {
  const { locale, t } = useSettings();
  const [stats, setStats] = useState<SiteStats | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = (): void => {
      void fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/stats`)
        .then((r) => (r.ok ? (r.json() as Promise<SiteStats>) : null))
        .then((data) => {
          if (!cancelled && data) setStats(data);
        })
        // Silent: a counter that cannot be fetched is a missing decoration,
        // and an error banner about one would be worse than its absence.
        .catch(() => undefined);
    };

    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!stats) return null;

  return (
    <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {FIELDS.map(({ key, label }) => (
        <div key={key} className="cf-panel px-3 py-2.5">
          <div className="truncate text-[11px] uppercase tracking-wide text-ink-faint">
            {t(label)}
          </div>
          <div className="truncate text-lg font-semibold">
            {stats[key].toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU')}
          </div>
        </div>
      ))}
    </section>
  );
}
