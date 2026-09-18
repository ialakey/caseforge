'use client';

import Link from 'next/link';
import type { PublicProfileView } from '@caseforge/shared';
import { useSettings } from '../lib/settings';
import { ItemImage } from './ItemImage';
import { Money } from './Money';
import { SteamAvatar } from './SteamAvatar';
import { rarityColor } from './RarityBadge';

/**
 * A player's page as a stranger sees it.
 *
 * Everything on it is already public: the name and avatar come from Steam, and
 * the drops are the same ones the live strip broadcasts to every visitor. What
 * is deliberately absent is the rest of a player — balance, top-ups, trade
 * URL, inventory. The API does not send them, and this page could not show
 * them if it wanted to.
 *
 * A client component only because the copy and the money format follow the
 * viewer's language and currency; the page itself is server-rendered.
 */
export function PublicProfile({ profile }: { profile: PublicProfileView }) {
  const { locale, t } = useSettings();

  // The month, not the day: "here since September 2026" says what it needs to
  // about a player without pinning down the day they signed up.
  //
  // Formatted with the day and then thrown away, which looks perverse until
  // you try it without: Russian declines the month, and `ru-RU` only produces
  // the genitive «сентября» when a day is present. Asking for month and year
  // alone gives the nominative «сентябрь», and «с сентябрь 2026» is not a
  // sentence. Reading the parts back is what keeps both locales grammatical.
  const parts = new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).formatToParts(new Date(profile.createdAt));
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  const year = parts.find((part) => part.type === 'year')?.value ?? '';
  const since = `${month} ${year}`.trim();

  return (
    <div className="space-y-6">
      <section className="cf-panel flex flex-wrap items-center gap-4 p-4 sm:p-6">
        <SteamAvatar src={profile.avatarUrl} name={profile.username} size={64} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold">{profile.username}</h1>
          <p className="text-sm text-ink-faint">
            {t('profile.public.since').replace('{date}', since)}
          </p>
        </div>
        {profile.steamId && (
          <a
            href={`https://steamcommunity.com/profiles/${profile.steamId}`}
            target="_blank"
            rel="noreferrer noopener"
            className="cf-chip px-3 py-1.5 text-sm"
          >
            {t('profile.public.steam')}
          </a>
        )}
      </section>

      <section>
        <h2 className="mb-3 flex items-center gap-2.5 text-sm font-semibold uppercase tracking-wider text-ink-muted">
          <span className="h-4 w-1 rounded-full bg-accent" />
          {t('profile.public.drops')}
        </h2>

        {profile.drops.length === 0 ? (
          <p className="text-ink-faint">{t('profile.public.noDrops')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {profile.drops.map((drop) => (
              <Link
                key={drop.openingId}
                // Through to the case it came out of: a stranger looking at a
                // knife on somebody's profile is one click from the case that
                // can produce one, which is the whole point of showing it.
                href={`/case/${drop.caseSlug}`}
                className="rounded-lg border-t-2 bg-surface-raised/70 p-2 transition hover:bg-surface-overlay"
                style={{ borderTopColor: rarityColor(drop.rarity) }}
              >
                <ItemImage
                  src={drop.itemImageUrl}
                  alt={drop.itemName}
                  rarity={drop.rarity}
                  className="mb-2 h-20 w-full"
                />
                <div className="truncate text-xs font-medium" title={drop.itemName}>
                  {drop.itemName}
                </div>
                <div className="mt-1 flex items-baseline justify-between gap-2">
                  <span className="truncate text-[11px] text-ink-faint" title={drop.caseName}>
                    {drop.caseName}
                  </span>
                  <Money value={drop.price} className="shrink-0 text-xs font-semibold text-accent" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
