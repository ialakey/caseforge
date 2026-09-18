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
export function CatalogueHeadings({ catalogue }: { catalogue: ReactNode }) {
  const t = useT();

  return (
    <>
      {/* The anchor the banner's call to action jumps to. */}
      <section id="cases" className="scroll-mt-24">
        <SectionHeading>{t('home.cases')}</SectionHeading>
        {catalogue}
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
