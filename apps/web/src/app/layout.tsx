import type { Metadata } from 'next';
import { DEFAULT_LOCALE, pickLocalised } from '@caseforge/shared';
import './globals.css';
import { Footer } from '../components/Footer';
import { Header } from '../components/Header';
import { ReferralCapture } from '../components/ReferralCapture';
import { AnalyticsTracker } from '../components/AnalyticsTracker';
import { LiveDrops } from '../components/LiveDrops';
import { getDropStrip, getPublicConfig, themeStyle } from '../lib/public-config';

/**
 * The title and description come from the appearance settings.
 *
 * Generated rather than constant because they are the one piece of the site a
 * search engine and a chat preview see, and an operator who renamed the site
 * would otherwise find the old name in every shared link. The base locale is
 * used here: metadata is rendered once per request, before the visitor's stored
 * language preference has been read.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { appearance } = await getPublicConfig();
  const tagline = pickLocalised(DEFAULT_LOCALE, appearance.tagline);
  const description =
    pickLocalised(DEFAULT_LOCALE, appearance.seo.description) ??
    tagline ??
    'CS2 case opening with provable fairness';

  return {
    title: tagline ? `${appearance.siteName} — ${tagline}` : appearance.siteName,
    description,
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { appearance } = await getPublicConfig();
  // Only fetched when the strip is switched on: an operator who turned the
  // feed off should not be paying for its query on every page of the site.
  const strip = appearance.dropFeed.enabled
    ? await getDropStrip()
    : { recent: [], best: null };

  return (
    // The lang attribute starts at the default locale and is corrected on the
    // client once the stored preference is read.
    //
    // The palette rides on an inline style rather than a class: it is one
    // operator's choice out of a continuous range, so there is no class to
    // name — and rendering it here means the first paint is already the right
    // colour instead of flashing the built-in one.
    <html lang="ru" style={themeStyle(appearance)}>
      <body className="flex min-h-dvh flex-col">
        {/* Both render nothing: one catches an invite on whatever page the link
            pointed at, the other reports a page view per navigation. */}
        <ReferralCapture />
        <AnalyticsTracker />

        {/* Above the header, full width, on every page: the feed is chrome
            rather than a section of the landing page, and a visitor who
            arrives straight on a case should see the site is alive too. */}
        {appearance.dropFeed.enabled && (
          <LiveDrops
            initial={strip.recent}
            best={strip.best}
            showBest={appearance.dropFeed.bestDrop}
            profilesPublic={appearance.profiles.public}
          />
        )}

        <Header appearance={appearance} />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:py-8">{children}</main>
        <Footer appearance={appearance} />
      </body>
    </html>
  );
}
