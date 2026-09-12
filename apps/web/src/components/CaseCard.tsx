'use client';

import Link from 'next/link';
import { localizedName, type CaseView } from '@caseforge/shared';
import { useSettings } from '../lib/settings';
import { Money } from './Money';

export function CaseCard({ item }: { item: CaseView }) {
  const { locale, t } = useSettings();
  const title = localizedName(locale, item);

  return (
    <Link
      href={`/case/${item.slug}`}
      className="group rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 transition hover:border-amber-500/60"
    >
      <div className="mb-3 flex h-28 items-center justify-center overflow-hidden rounded-lg bg-neutral-800/60">
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt={title}
            loading="lazy"
            className="h-full w-full object-contain p-1 transition group-hover:scale-105"
          />
        ) : (
          <span className="text-3xl opacity-60">📦</span>
        )}
      </div>
      <div className="font-medium">{title}</div>
      <div className="mt-1 flex items-center justify-between text-sm">
        <Money value={item.price} className="text-amber-400" />
        <span className="text-neutral-500">
          {item.items.length} {t('common.itemsCount')}
        </span>
      </div>
    </Link>
  );
}
