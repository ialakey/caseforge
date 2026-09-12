'use client';

import type { ReactNode } from 'react';
import { useT } from '../lib/settings';

/**
 * Headings for the landing page.
 *
 * The page itself renders on the server so search engines see the catalogue,
 * but the headings depend on the viewer's language, which is only known in the
 * browser. Keeping just the text in a client component preserves the
 * server-rendered case list.
 */
export function CatalogueHeadings({
  hasCases,
  children,
}: {
  hasCases: boolean;
  children: ReactNode;
}) {
  const t = useT();

  return (
    <>
      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-neutral-500">
          {t('home.latestDrops')}
        </h2>
        {children}
      </section>

      <section>
        <h1 className="mb-4 text-2xl font-semibold">{t('home.cases')}</h1>
        {!hasCases && <p className="text-neutral-500">{t('home.noCases')}</p>}
      </section>
    </>
  );
}
