'use client';

import { useMemo, useState } from 'react';
import {
  findPriceBand,
  inPriceBand,
  priceBandOf,
  type CaseView,
  type PriceBandKey,
} from '@caseforge/shared';
import { useT } from '../lib/settings';
import { CaseCard } from './CaseCard';
import { PriceBandFilter } from './PriceBandFilter';

/**
 * The case catalogue and its filter.
 *
 * Filtering happens in the browser over the list the server already sent.
 * A catalogue is tens of cases, not thousands: a round trip per keystroke
 * would buy nothing and would cost the instant response that makes a filter
 * feel worth using. The component is still rendered on the server with the
 * full list, so the markup a crawler sees is the whole catalogue.
 */
export function CaseCatalogue({ cases }: { cases: CaseView[] }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [band, setBand] = useState<PriceBandKey>('all');

  // How many cases sit in each band, so the chips can say so and the bands
  // nobody stocked can stay out of the way.
  const counts = useMemo(() => {
    const tally: Record<string, number> = {};
    for (const item of cases) {
      const found = priceBandOf(item.price);
      if (found) tally[found.key] = (tally[found.key] ?? 0) + 1;
    }
    return tally;
  }, [cases]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const chosen = band === 'all' ? null : findPriceBand(band);
    return cases.filter((item) => {
      if (chosen && !inPriceBand(item.price, chosen)) return false;
      if (!needle) return true;
      // Both names are searched whatever the language is set to: a player
      // typing "dragon" should find the case even while reading the site in
      // Russian, and vice versa.
      return [item.name, item.nameEn ?? ''].some((name) => name.toLowerCase().includes(needle));
    });
  }, [cases, query, band]);

  if (cases.length === 0) return <p className="text-ink-faint">{t('home.noCases')}</p>;

  const filtered = query.trim().length > 0 || band !== 'all';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('common.search')}
          aria-label={t('common.search')}
          className="min-w-[200px] flex-1 rounded-lg border border-edge-subtle bg-surface-overlay px-3 py-1.5 text-sm outline-none transition placeholder:text-ink-faint focus:border-edge-strong"
        />
        {filtered && (
          <>
            <span className="text-xs text-ink-faint">
              {t('home.caseMatches', { shown: visible.length, total: cases.length })}
            </span>
            <button
              onClick={() => {
                setQuery('');
                setBand('all');
              }}
              className="cf-chip px-3 py-1.5"
            >
              {t('home.resetFilters')}
            </button>
          </>
        )}
      </div>

      <PriceBandFilter value={band} onChange={setBand} counts={counts} />

      {visible.length === 0 ? (
        <p className="text-ink-faint">{t('home.noMatches')}</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {visible.map((item) => (
            <CaseCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
