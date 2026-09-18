'use client';

import { useMemo, useState } from 'react';
import {
  findPriceBand,
  inPriceBand,
  localizedName,
  priceBandOf,
  type CaseCategoryView,
  type CaseView,
  type PriceBandKey,
} from '@caseforge/shared';
import { useSettings } from '../lib/settings';
import { CaseCard } from './CaseCard';
import { PriceBandFilter } from './PriceBandFilter';

/**
 * The case catalogue: shelves, a search box and a price filter.
 *
 * Filtering happens in the browser over the list the server already sent.
 * A catalogue is tens of cases, not thousands: a round trip per keystroke
 * would buy nothing and would cost the instant response that makes a filter
 * feel worth using. The component is still rendered on the server with the
 * full list, so the markup a crawler sees is the whole catalogue.
 *
 * Two layouts, and the switch between them is the point: with no filter the
 * cases are grouped into their shelves, because two hundred cards in one grid
 * is a wall rather than a catalogue. The moment somebody searches, the shelves
 * are dropped and the matches shown flat — four results spread across nine
 * headings reads as nine empty shelves.
 */
export function CaseCatalogue({
  cases,
  /**
   * On a small catalogue the filters outnumber the cases, so whether they
   * appear at all is an operator's decision. The list itself is unaffected —
   * hiding the controls resets nothing.
   */
  showFilters = true,
}: {
  cases: CaseView[];
  showFilters?: boolean;
}) {
  const { locale, t } = useSettings();
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

  /**
   * The shelves, in the order an operator put them in.
   *
   * Ungrouped cases are gathered into a shelf of their own at the end rather
   * than hidden: a case that lost its category is still for sale, and a
   * catalogue that silently stops showing it is worse than an untidy heading.
   */
  const shelves = useMemo(() => {
    const byCategory = new Map<string, { category: CaseCategoryView | null; cases: CaseView[] }>();
    for (const item of visible) {
      const key = item.category?.slug ?? '';
      const shelf = byCategory.get(key) ?? { category: item.category, cases: [] };
      shelf.cases.push(item);
      byCategory.set(key, shelf);
    }
    return [...byCategory.values()].sort((a, b) => {
      if (!a.category) return 1;
      if (!b.category) return -1;
      return a.category.sortOrder - b.category.sortOrder;
    });
  }, [visible]);

  if (cases.length === 0) return <p className="text-ink-faint">{t('home.noCases')}</p>;

  const filtered = query.trim().length > 0 || band !== 'all';
  const grouped = !filtered && shelves.length > 1;

  return (
    <div className="space-y-4">
      {showFilters && (
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
      )}

      {showFilters && <PriceBandFilter value={band} onChange={setBand} counts={counts} />}

      {/* Jump links to the shelves. On a catalogue this size the alternative is
          scrolling past a hundred cards to reach the collections. */}
      {grouped && (
        <nav className="flex flex-wrap gap-2">
          {shelves.map((shelf) => (
            <a
              key={shelf.category?.slug ?? 'ungrouped'}
              href={`#shelf-${shelf.category?.slug ?? 'ungrouped'}`}
              className="cf-chip px-3 py-1.5"
            >
              {shelf.category ? localizedName(locale, shelf.category) : t('home.ungrouped')}
              <span className="ml-1.5 text-ink-faint">{shelf.cases.length}</span>
            </a>
          ))}
        </nav>
      )}

      {visible.length === 0 ? (
        <p className="text-ink-faint">{t('home.noMatches')}</p>
      ) : grouped ? (
        <div className="space-y-8">
          {shelves.map((shelf) => (
            <section
              key={shelf.category?.slug ?? 'ungrouped'}
              id={`shelf-${shelf.category?.slug ?? 'ungrouped'}`}
              className="scroll-mt-24 space-y-3"
            >
              <h3 className="flex items-center gap-2.5 text-sm font-semibold uppercase tracking-wider text-ink-muted">
                <span className="h-4 w-1 rounded-full bg-accent" />
                {shelf.category ? localizedName(locale, shelf.category) : t('home.ungrouped')}
                <span className="text-ink-faint">{shelf.cases.length}</span>
              </h3>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {shelf.cases.map((item) => (
                  <CaseCard key={item.id} item={item} />
                ))}
              </div>
            </section>
          ))}
        </div>
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
