'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { trackPageView } from '../lib/analytics';

/**
 * Reports a page view per navigation.
 *
 * The app router does not reload the document, so there is no second request
 * for a server log to count — a route change is invisible unless something in
 * the browser says so. Mounted once in the layout and renders nothing.
 *
 * The ref guards against React running the effect twice in development, which
 * would double every figure on the traffic report while nobody is looking.
 */
export function AnalyticsTracker() {
  const pathname = usePathname();
  const lastReported = useRef<string | null>(null);

  useEffect(() => {
    if (!pathname || lastReported.current === pathname) return;
    lastReported.current = pathname;
    trackPageView(pathname);
  }, [pathname]);

  return null;
}
