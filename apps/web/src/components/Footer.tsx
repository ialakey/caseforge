'use client';

import { type AppearanceConfig, pickLocalised } from '@caseforge/shared';
import { useSettings } from '../lib/settings';

/**
 * The footer carries the note the operator wrote, and the links they set.
 *
 * Still a client component: the note exists in both languages and a line
 * printed in both at once serves neither reader. What it shows when nothing
 * has been configured is the shipped disclaimer from the dictionary — the same
 * rule as every other appearance text.
 */
export function Footer({ appearance }: { appearance: AppearanceConfig }) {
  const { locale, t } = useSettings();

  const note = pickLocalised(locale, appearance.footer.note) ?? t('footer.demo');
  const links = (
    [
      ['Telegram', appearance.footer.telegram],
      ['Discord', appearance.footer.discord],
      ['VK', appearance.footer.vk],
      ['Steam', appearance.footer.steam],
    ] as const
  ).filter(([, href]) => href !== '');

  return (
    <footer className="mt-4 border-t border-edge-subtle">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-xs text-ink-faint">
        <span>{note}</span>

        {links.length > 0 && (
          <span className="flex items-center gap-3">
            {links.map(([label, href]) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="transition hover:text-ink-primary"
              >
                {label}
              </a>
            ))}
          </span>
        )}

        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-positive" />
          {t('footer.fairness')}
        </span>
      </div>
    </footer>
  );
}
