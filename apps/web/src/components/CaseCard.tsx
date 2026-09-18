'use client';

import Link from 'next/link';
import { RARITY_COLORS, localizedName, type CaseView } from '@caseforge/shared';
import { useSettings } from '../lib/settings';
import { Money } from './Money';

/**
 * A case in the catalogue.
 *
 * The glow under the artwork is taken from the best item the case can drop.
 * That is the one piece of information a player actually scans a catalogue for
 * — how good does this one get — and it costs nothing to show, since the case
 * list already carries its contents.
 */
export function CaseCard({ item }: { item: CaseView }) {
  const { locale, t } = useSettings();
  const title = localizedName(locale, item);

  const order = Object.keys(RARITY_COLORS);
  const best = item.items.reduce<string | null>((top, entry) => {
    if (top === null) return entry.rarity;
    return order.indexOf(entry.rarity) > order.indexOf(top) ? entry.rarity : top;
  }, null);
  const glow = best ? RARITY_COLORS[best as keyof typeof RARITY_COLORS] : '#fbbf24';

  return (
    <Link
      href={`/case/${item.slug}`}
      className="group relative overflow-hidden rounded-xl border border-edge-subtle bg-surface-raised/70 transition duration-200 hover:-translate-y-0.5 hover:border-edge-strong"
      style={{ ['--glow' as string]: glow }}
    >
      <div
        className="relative flex h-32 items-center justify-center overflow-hidden"
        style={{
          backgroundImage: `radial-gradient(ellipse 70% 80% at 50% 110%, ${glow}33, transparent 70%)`,
        }}
      >
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt={title}
            loading="lazy"
            className="h-full w-full object-contain p-3 transition duration-300 group-hover:scale-[1.07]"
          />
        ) : (
          <span className="text-4xl opacity-50">📦</span>
        )}
      </div>

      {/* A hairline in the case's own colour, lit on hover. */}
      <div
        className="h-px w-full opacity-40 transition group-hover:opacity-100"
        style={{ background: `linear-gradient(90deg, transparent, ${glow}, transparent)` }}
      />

      <div className="p-3">
        <div className="truncate font-medium" title={title}>
          {title}
        </div>
        <div className="mt-1.5 flex items-center justify-between text-sm">
          {/* A free case shows a word, not "0,00 ₽": the price is the first
              thing scanned on a card, and a zero there reads as a bug. */}
          {item.free ? (
            <span className="font-semibold text-positive">{t('case.free.badge')}</span>
          ) : (
            <Money value={item.price} className="font-semibold text-accent" />
          )}
          <span className="text-xs text-ink-faint">
            {item.items.length} {t('common.itemsCount')}
          </span>
        </div>
      </div>
    </Link>
  );
}
