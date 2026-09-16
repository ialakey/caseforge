'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { TranslationKey } from '@caseforge/shared';
import { useSettings } from '../../lib/settings';

/**
 * Shared shell for the back office.
 *
 * The panel grew a page at a time and the only way between them was a single
 * link on the dashboard, which stops working the moment there are five. The nav
 * lives in a layout so a new admin page is reachable by adding one entry here
 * rather than by remembering to link it from wherever the operator happens to be.
 */
const TABS: Array<{ href: string; label: TranslationKey }> = [
  { href: '/admin', label: 'admin.nav.dashboard' },
  { href: '/admin/cases', label: 'admin.nav.cases' },
  { href: '/admin/promo', label: 'admin.nav.promo' },
  { href: '/admin/market', label: 'admin.nav.market' },
  { href: '/admin/bots', label: 'admin.nav.bots' },
  { href: '/admin/settings', label: 'admin.nav.settings' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { t } = useSettings();

  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-2 border-b border-edge-subtle pb-3">
        {TABS.map((tab) => {
          // The dashboard is an exact match; everything else owns its subtree,
          // so /admin/cases/starter still lights up "Cases".
          const active =
            tab.href === '/admin' ? pathname === '/admin' : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              data-active={active}
              className="cf-chip px-3 py-1.5"
            >
              {t(tab.label)}
            </Link>
          );
        })}
      </nav>

      {children}
    </div>
  );
}
