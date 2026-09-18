'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { PlayerStats, PublicUser } from '@caseforge/shared';
import { api } from '../lib/api';
import { useSettings } from '../lib/settings';
import { ItemImage } from './ItemImage';
import { Money } from './Money';
import { SteamAvatar } from './SteamAvatar';
import { rarityColor } from './RarityBadge';

/**
 * The card at the top of a player's own profile.
 *
 * Three things side by side, because they answer the three questions somebody
 * opens their profile with: who am I and what have I got, what is the best
 * thing that ever came out of this, and how much have I actually played.
 *
 * The identity column carries the trade URL as a *status* rather than a form.
 * The form is further down the page where it belongs; up here the only thing
 * worth knowing at a glance is whether withdrawing will work, and a red line
 * saying it will not is the whole point of putting it in the summary.
 *
 * The statistics are fetched rather than passed in: they are five counts over
 * tables nobody else on this page reads, and making the profile wait for them
 * would hold up the inventory for a decoration.
 */
export function ProfileSummary({ user }: { user: PublicUser }) {
  const { locale, t } = useSettings();
  const [stats, setStats] = useState<PlayerStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api<PlayerStats>('/api/me/stats')
      .then((data) => {
        if (!cancelled) setStats(data);
      })
      // Silent: the summary is a decoration on a page whose real content is
      // the inventory, and an error banner about a statistic is noise.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const best = stats?.bestDrop ?? null;
  const number = (value: number): string => value.toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU');

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      {/* Who, and what they have */}
      <div className="cf-panel flex flex-wrap items-center gap-4 p-5">
        <SteamAvatar src={user.avatarUrl} name={user.username} size={72} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xl font-semibold">{user.username}</div>
          <div className="truncate text-xs text-ink-faint">{user.steamId64}</div>
          <Money value={user.balance} className="mt-1 block text-2xl font-semibold text-accent" />
          <div className="mt-1 text-xs">
            <span className="text-ink-faint">{t('profile.tradeUrl')}: </span>
            <span className={user.tradeUrl ? 'text-positive' : 'text-negative'}>
              {user.tradeUrl ? t('profile.tradeUrlSet') : t('profile.tradeUrlUnset')}
            </span>
          </div>
        </div>
      </div>

      {/* The best of it, and how much of it there has been */}
      <div className="cf-panel grid gap-4 p-5 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)]">
        <div className="min-w-0">
          <div className="mb-2 text-xs uppercase tracking-wide text-ink-faint">
            {t('profile.bestDrop')}
          </div>
          {best ? (
            <Link
              href={`/case/${best.caseSlug}`}
              className="block rounded-lg p-2 transition hover:brightness-110"
              // Tinted with the drop's own rarity: the card is a claim about
              // how good it was, and the palette says that faster than a number.
              style={{
                background: `linear-gradient(160deg, ${rarityColor(best.rarity)}38, ${rarityColor(best.rarity)}0d)`,
                boxShadow: `inset 0 0 0 1px ${rarityColor(best.rarity)}59`,
              }}
            >
              <Money value={best.price} className="text-sm font-semibold" />
              <ItemImage
                src={best.imageUrl}
                alt={best.itemName}
                rarity={best.rarity}
                className="my-1 h-16 w-full"
              />
              <div className="truncate text-xs font-medium" title={best.itemName}>
                {best.itemName}
              </div>
              <div className="truncate text-[11px] text-ink-faint" title={best.caseName}>
                {best.caseName}
              </div>
            </Link>
          ) : (
            <p className="text-sm text-ink-faint">{t('profile.bestDropNone')}</p>
          )}
        </div>

        <div className="min-w-0">
          <div className="mb-2 text-xs uppercase tracking-wide text-ink-faint">
            {t('profile.stats')}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Stat label={t('profile.stats.cases')} value={stats ? number(stats.casesOpened) : '—'} />
            <Stat
              label={t('profile.stats.upgrades')}
              value={stats ? <WonLost won={stats.upgrades.won} lost={stats.upgrades.lost} /> : '—'}
              hint={stats ? t('profile.stats.wonLost') : undefined}
            />
            <Stat
              label={t('profile.stats.battles')}
              value={stats ? <WonLost won={stats.battles.won} lost={stats.battles.lost} /> : '—'}
              hint={stats ? t('profile.stats.wonLost') : undefined}
            />
            <Stat
              label={t('profile.stats.contracts')}
              value={stats ? number(stats.contracts) : '—'}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs text-ink-faint">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
      {hint && <div className="truncate text-[10px] text-ink-faint">{hint}</div>}
    </div>
  );
}

/** A record as two coloured numbers, which reads faster than "63 of 299". */
function WonLost({ won, lost }: { won: number; lost: number }) {
  return (
    <span>
      <span className="text-positive">{won}</span>
      <span className="text-ink-faint"> / </span>
      <span className="text-negative">{lost}</span>
    </span>
  );
}
