import type { CaseView } from '@caseforge/shared';
import { CaseCatalogue } from '../components/CaseCatalogue';
import { CatalogueHeadings } from '../components/CatalogueHeadings';
import { BonusTeaser } from '../components/BonusTeaser';
import { Hero } from '../components/Hero';
import { SiteStatsBar } from '../components/SiteStatsBar';
import { HomePromoCards } from '../components/HomePromoCards';
import { GiveawaySection } from '../components/GiveawaySection';
import { getPublicConfig } from '../lib/public-config';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function loadCases(): Promise<CaseView[]> {
  // The case list renders on the server: this is the main landing page and
  // search engines must see it, not an empty SPA shell.
  const response = await fetch(`${API_URL}/api/cases`, { cache: 'no-store' });
  if (!response.ok) return [];
  return response.json() as Promise<CaseView[]>;
}

export default async function HomePage() {
  // Both on the server, and the configuration is the same request the layout
  // already made. Deciding here rather than inside each component is what
  // stops a section the operator switched off from rendering and then
  // disappearing on the first client paint.
  const [cases, { appearance }] = await Promise.all([loadCases(), getPublicConfig()]);

  // Counted from the catalogue that was just fetched rather than from a second
  // endpoint: the banner is decoration, and it must not cost a round trip or
  // fail the page when it is unavailable.
  const distinctItems = new Set(cases.flatMap((c) => c.items.map((i) => i.itemId))).size;

  return (
    <div className="space-y-10">
      {appearance.hero.enabled && (
        <Hero caseCount={cases.length} itemCount={distinctItems} appearance={appearance} />
      )}

      {/* What the site has done, and who is on it. Above everything else a
          visitor might read, because it is the fastest answer to "is this
          place real". */}
      {appearance.home.statsBar && <SiteStatsBar />}

      {/* The bonus with its countdown, and whatever promotion is running. */}
      {appearance.home.promoCards && <HomePromoCards />}

      {/* The skins being given away. Renders nothing when none is running. */}
      {appearance.home.giveaways && <GiveawaySection />}

      {/* A player who has a spin waiting should not have to find the bonus page
          to learn that — but the promo row above already says so when it is on,
          and two strips about the same spin is one too many. The setting still
          decides whether the site advertises the bonus at all; this only picks
          which of the two does it. */}
      {appearance.home.bonusTeaser && !appearance.home.promoCards && <BonusTeaser />}

      {/* The drop feed used to be the first section here; it now lives above
          the header, in the layout, on every page. */}
      <CatalogueHeadings
        catalogue={<CaseCatalogue cases={cases} showFilters={appearance.home.caseFilters} />}
      />
    </div>
  );
}
