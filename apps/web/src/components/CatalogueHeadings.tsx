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
        <SectionHeading>{t('home.latestDrops')}</SectionHeading>
        {children}
      </section>

      <section>
        <SectionHeading>{t('home.cases')}</SectionHeading>
        {!hasCases && <p className="text-ink-faint">{t('home.noCases')}</p>}
      </section>
    </>
  );
}

/** A section title with a short accent rule, so blocks read as separate. */
function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-3 flex items-center gap-2.5 text-sm font-semibold uppercase tracking-wider text-ink-muted">
      <span className="h-4 w-1 rounded-full bg-accent" />
      {children}
    </h2>
  );
}
