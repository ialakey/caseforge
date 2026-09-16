'use client';

import { PRICE_BANDS, type PriceBandKey } from '@caseforge/shared';
import { useT } from '../lib/settings';
import { useMoneyFormatter } from './Money';

/**
 * A row of price-band chips.
 *
 * The bands themselves are fixed in the base currency (see PRICE_BANDS) and
 * only their labels are formatted for the viewer, so switching currency
 * relabels the row without re-sorting anything behind it.
 *
 * Pass `counts` when the whole set being filtered is already in hand: the row
 * then hides bands nothing falls into and shows how much each one holds. A
 * screen that filters on the server cannot know either, so it omits `counts`
 * and gets the full ladder.
 */
export function PriceBandFilter({
  value,
  onChange,
  counts,
}: {
  value: PriceBandKey;
  onChange: (band: PriceBandKey) => void;
  counts?: Record<string, number>;
}) {
  const t = useT();
  const money = useMoneyFormatter();

  const bands = counts ? PRICE_BANDS.filter((b) => (counts[b.key] ?? 0) > 0) : PRICE_BANDS;

  // One band covering everything is not a choice — it filters nothing out.
  if (counts && bands.length < 2) return null;

  return (
    <div className="flex flex-wrap gap-2">
      <button
        data-active={value === 'all'}
        onClick={() => onChange('all')}
        className="cf-chip px-3 py-1.5"
      >
        {t('common.bandAll')}
      </button>
      {bands.map((band) => (
        <button
          key={band.key}
          data-active={value === band.key}
          onClick={() => onChange(band.key)}
          className="cf-chip px-3 py-1.5"
        >
          {band.max === null
            ? t('common.bandOver', { min: money(band.min) })
            : band.min === 0
              ? t('common.bandUnder', { max: money(band.max) })
              : t('common.bandBetween', { min: money(band.min), max: money(band.max) })}
          {counts && <span className="ml-1.5 opacity-60">{counts[band.key]}</span>}
        </button>
      ))}
    </div>
  );
}
