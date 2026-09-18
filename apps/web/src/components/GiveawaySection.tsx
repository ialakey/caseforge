'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  translateError,
  type GiveawayStanding,
  type GiveawayView,
} from '@caseforge/shared';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/store';
import { useSettings } from '../lib/settings';
import { ItemImage } from './ItemImage';
import { Money } from './Money';
import { rarityColor } from './RarityBadge';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * The skins being given away.
 *
 * Renders nothing when there is no giveaway running — an empty section headed
 * "skin giveaway" advertises an absence, which is worse than saying nothing.
 *
 * Each card carries the one thing a player needs to decide: how far they are
 * from qualifying. "Your top-ups: 600 of 1 000" is an instruction; a disabled
 * button is a dead end, and this is a promotion whose whole purpose is to be
 * acted on.
 */
export function GiveawaySection() {
  const { user } = useAuth();
  const { locale, t } = useSettings();
  const [giveaways, setGiveaways] = useState<GiveawayView[]>([]);
  const [standings, setStandings] = useState<Record<string, GiveawayStanding>>({});
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`${API_URL}/api/giveaways`);
      if (response.ok) setGiveaways((await response.json()) as GiveawayView[]);
    } catch {
      // Silent: a section that cannot load is a missing section, and an error
      // banner about a promotion would be louder than the promotion.
    }
  }, []);

  const loadStandings = useCallback(async (): Promise<void> => {
    if (!user) {
      setStandings({});
      return;
    }
    try {
      const rows = await api<GiveawayStanding[]>('/api/giveaways/standings');
      setStandings(Object.fromEntries(rows.map((r) => [r.giveawayId, r])));
    } catch {
      setStandings({});
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadStandings();
  }, [loadStandings]);

  // One ticker for every card. A countdown per card would be one interval per
  // knife, all of them re-rendering the same second.
  const live = giveaways.some((g) => g.status === 'OPEN' || g.status === 'SCHEDULED');
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  async function enter(id: string): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      await api<GiveawayStanding>(`/api/giveaways/${id}/enter`, { method: 'POST' });
      await Promise.all([load(), loadStandings()]);
    } catch (err) {
      setError(
        err instanceof ApiError ? translateError(locale, err.code, err.message) : String(err),
      );
    } finally {
      setBusy(null);
    }
  }

  const showing = giveaways.filter((g) => g.status !== 'CANCELLED');
  if (showing.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="flex items-center gap-2.5 text-sm font-semibold uppercase tracking-wider text-ink-muted">
          <span className="h-4 w-1 rounded-full bg-accent" />
          {t('giveaway.title')}
        </h2>
        <Link href="/giveaways" className="text-sm text-accent hover:underline">
          {t('giveaway.winners')}
        </Link>
      </div>

      {error && <p className="text-sm text-negative">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {showing.map((giveaway) => (
          <GiveawayCard
            key={giveaway.id}
            giveaway={giveaway}
            standing={standings[giveaway.id] ?? null}
            signedIn={user !== null}
            remaining={new Date(giveaway.drawsAt).getTime() - now}
            busy={busy === giveaway.id}
            onEnter={enter}
          />
        ))}
      </div>
    </section>
  );
}

function GiveawayCard({
  giveaway,
  standing,
  signedIn,
  remaining,
  busy,
  onEnter,
}: {
  giveaway: GiveawayView;
  standing: GiveawayStanding | null;
  signedIn: boolean;
  remaining: number;
  busy: boolean;
  onEnter: (id: string) => void;
}) {
  const { locale, t } = useSettings();
  const colour = rarityColor(giveaway.prize.rarity);
  const drawn = giveaway.status === 'DRAWN';
  const title = locale === 'en' ? giveaway.titleEn?.trim() || giveaway.title : giveaway.title;

  return (
    <div
      className="flex flex-col rounded-lg p-3"
      // Tinted with the prize's own rarity, like every other card on the site
      // that is making a claim about how good something is.
      style={{
        background: `linear-gradient(160deg, ${colour}33, ${colour}0d)`,
        boxShadow: `inset 0 0 0 1px ${colour}59`,
      }}
    >
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate text-ink-faint" title={title}>
          {title}
        </span>
        <span className="shrink-0 rounded-full bg-surface-base/60 px-2 py-0.5">
          {giveaway.entryCount} {t('giveaway.entrants').toLowerCase()}
        </span>
      </div>

      <ItemImage
        src={giveaway.prize.imageUrl}
        alt={giveaway.prize.itemName}
        rarity={giveaway.prize.rarity}
        className="h-20 w-full"
      />

      <div className="mt-1 truncate text-xs font-medium" title={giveaway.prize.itemName}>
        {giveaway.prize.itemName}
      </div>
      <Money value={giveaway.prize.price} className="text-sm font-semibold text-accent" />

      {drawn ? (
        <div className="mt-2 text-xs">
          {giveaway.winner ? (
            <>
              <span className="text-ink-faint">{t('giveaway.wonBy')} </span>
              <Link href={`/u/${giveaway.winner.id}`} className="font-medium hover:underline">
                {giveaway.winner.username}
              </Link>
            </>
          ) : (
            <span className="text-ink-faint">{t('giveaway.noEntrants')}</span>
          )}
        </div>
      ) : (
        <>
          <div className="mt-2 font-mono text-sm">{countdown(remaining)}</div>

          {giveaway.minDeposit > 0 && (
            <div className="mt-1 text-[11px] text-ink-faint">
              {standing ? (
                <span className={standing.deposited >= giveaway.minDeposit ? 'text-positive' : ''}>
                  {t('giveaway.yourDeposits')
                    .replace('{have}', formatMinor(standing.deposited, locale))
                    .replace('{need}', formatMinor(giveaway.minDeposit, locale))}
                </span>
              ) : (
                t('giveaway.step1').replace('{amount}', formatMinor(giveaway.minDeposit, locale))
              )}
            </div>
          )}

          <div className="mt-2">
            {!signedIn ? (
              <span className="text-[11px] text-ink-faint">{t('giveaway.signIn')}</span>
            ) : standing?.entered ? (
              <span className="text-xs font-medium text-positive">{t('giveaway.entered')}</span>
            ) : (
              <button
                onClick={() => onEnter(giveaway.id)}
                disabled={busy || standing?.canEnter !== true}
                className="cf-btn-primary w-full py-1.5 text-xs disabled:opacity-40"
              >
                {t('giveaway.enter')}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** `dd:hh:mm:ss`, dropping the day when there is not one. */
function countdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return days > 0
    ? `${pad(days)}:${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Minor units as a plain number.
 *
 * Not the shared money formatter: these two figures sit either side of "of" in
 * one sentence, and a currency symbol on each turns a comparison into a list.
 */
function formatMinor(minor: number, locale: string): string {
  return (minor / 100).toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU', {
    maximumFractionDigits: 0,
  });
}
