'use client';

import { useT } from '../lib/settings';

/**
 * The footer carries the demo disclaimer, which has to be legible to whoever
 * is looking — hence a client component rather than fixed text in the layout:
 * a line printed in both languages at once serves neither reader.
 */
export function Footer() {
  const t = useT();

  return (
    <footer className="mt-4 border-t border-edge-subtle">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-xs text-ink-faint">
        <span>{t('footer.demo')}</span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-positive" />
          {t('footer.fairness')}
        </span>
      </div>
    </footer>
  );
}
