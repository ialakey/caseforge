import { cache } from 'react';
import {
  type AppearanceConfig,
  type FxRates,
  type LiveDrop,
  DEFAULT_APPEARANCE,
  appearanceCssVariables,
} from '@caseforge/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface PublicConfig {
  depositsEnabled: boolean;
  fxRates: FxRates;
  appearance: AppearanceConfig;
}

/**
 * Whether the appearance changes a request sees at most this long after a save.
 *
 * Not `no-store`: the layout and the landing page both need it, and the
 * appearance changes a few times a month. Not minutes either — an operator
 * saving a colour wants to see it, and half a minute is the longest they should
 * have to wonder whether the save worked.
 */
const REVALIDATE_SECONDS = 30;

/**
 * The public configuration, fetched on the server.
 *
 * `cache()` deduplicates it within a single render: the layout wants the theme
 * and the metadata, the landing page wants the section toggles, and all three
 * are the same request. Falling back to the defaults rather than throwing is
 * deliberate — the API being briefly unavailable should cost the visitor the
 * operator's colour scheme, not the page.
 */
export const getPublicConfig = cache(async (): Promise<PublicConfig> => {
  try {
    const response = await fetch(`${API_URL}/api/config`, {
      next: { revalidate: REVALIDATE_SECONDS },
    });
    if (!response.ok) throw new Error(`config responded ${response.status}`);
    const config = (await response.json()) as Partial<PublicConfig>;
    return {
      depositsEnabled: config.depositsEnabled ?? false,
      fxRates: config.fxRates ?? {},
      // An older API that does not serve an appearance yet still renders a
      // site: the defaults are the same ones the registry declares.
      appearance: config.appearance ?? DEFAULT_APPEARANCE,
    };
  } catch {
    return { depositsEnabled: false, fxRates: {}, appearance: DEFAULT_APPEARANCE };
  }
});

/**
 * The theme as an inline `style` attribute for the document root.
 *
 * Server-rendered on purpose. Applying the palette from a client effect means
 * the first paint uses the built-in colours and then jumps to the operator's,
 * which on a dark-to-light preset is a white flash on every navigation.
 */
export function themeStyle(appearance: AppearanceConfig): Record<string, string> {
  return appearanceCssVariables(appearance);
}

/**
 * The drop strip's opening state, fetched on the server.
 *
 * Not cached at all, unlike the appearance: a feed rendered from a
 * thirty-second-old snapshot would show the same "live" drops to everybody who
 * loaded a page in that window, which is the one thing a live feed must not do.
 * An unavailable API costs the visitor the strip, never the page.
 */
export async function getDropStrip(): Promise<{ recent: LiveDrop[]; best: LiveDrop | null }> {
  try {
    const response = await fetch(`${API_URL}/api/drops`, { cache: 'no-store' });
    if (!response.ok) return { recent: [], best: null };
    return (await response.json()) as { recent: LiveDrop[]; best: LiveDrop | null };
  } catch {
    return { recent: [], best: null };
  }
}
