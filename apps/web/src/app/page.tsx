import type { CaseView } from '@caseforge/shared';
import { CaseCatalogue } from '../components/CaseCatalogue';
import { CatalogueHeadings } from '../components/CatalogueHeadings';
import { BonusTeaser } from '../components/BonusTeaser';
import { Hero } from '../components/Hero';
import { LiveDrops } from '../components/LiveDrops';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function loadCases(): Promise<CaseView[]> {
  // The case list renders on the server: this is the main landing page and
  // search engines must see it, not an empty SPA shell.
  const response = await fetch(`${API_URL}/api/cases`, { cache: 'no-store' });
  if (!response.ok) return [];
  return response.json() as Promise<CaseView[]>;
}

export default async function HomePage() {
  const cases = await loadCases();

  // Counted from the catalogue that was just fetched rather than from a second
  // endpoint: the banner is decoration, and it must not cost a round trip or
  // fail the page when it is unavailable.
  const distinctItems = new Set(cases.flatMap((c) => c.items.map((i) => i.itemId))).size;

  return (
    <div className="space-y-10">
      <Hero caseCount={cases.length} itemCount={distinctItems} />

      {/* Right under the banner: a player who has a spin waiting should not
          have to find the bonus page to learn that. */}
      <BonusTeaser />

      <CatalogueHeadings drops={<LiveDrops />} catalogue={<CaseCatalogue cases={cases} />} />
    </div>
  );
}
