'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { GiveawayView } from '@caseforge/shared';
import { useSettings } from '../../lib/settings';
import { ItemImage } from '../../components/ItemImage';
import { Money } from '../../components/Money';
import { rarityColor } from '../../components/RarityBadge';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * Who won what, and the numbers to check it with.
 *
 * Every drawn giveaway publishes its server seed, the client seed derived from
 * the entrant list, and the roll. That is the whole point of drawing it the way
 * the cases are drawn: a winners page that only listed names would be asking to
 * be taken on trust, which is the one thing this site does not ask.
 */
export default function GiveawayHistoryPage() {
  const { locale, t } = useSettings();
  const [rows, setRows] = useState<GiveawayView[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch(`${API_URL}/api/giveaways/history`)
      .then((r) => (r.ok ? (r.json() as Promise<GiveawayView[]>) : []))
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">{t('giveaway.historyTitle')}</h1>

      {rows === null ? (
        <p className="text-ink-faint">…</p>
      ) : rows.length === 0 ? (
        <p className="text-ink-faint">{t('giveaway.historyEmpty')}</p>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <article key={row.id} className="cf-panel flex flex-wrap items-center gap-4 p-4">
              <ItemImage
                src={row.prize.imageUrl}
                alt={row.prize.itemName}
                rarity={row.prize.rarity}
                className="h-16 w-24 shrink-0"
              />

              <div className="min-w-0 flex-1">
                <div className="truncate font-medium" title={row.prize.itemName}>
                  {row.prize.itemName}
                </div>
                <Money value={row.prize.price} className="text-sm text-accent" />
                <div className="mt-0.5 text-xs text-ink-faint">
                  {row.entryCount} {t('giveaway.entrants').toLowerCase()}
                  {row.drawnAt && (
                    <>
                      {' · '}
                      {new Date(row.drawnAt).toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU')}
                    </>
                  )}
                </div>
              </div>

              <div className="min-w-0 text-sm">
                <div className="text-xs text-ink-faint">{t('giveaway.wonBy')}</div>
                {row.winner ? (
                  <Link
                    href={`/u/${row.winner.id}`}
                    className="font-medium hover:underline"
                    style={{ color: rarityColor(row.prize.rarity) }}
                  >
                    {row.winner.username}
                  </Link>
                ) : (
                  <span className="text-ink-faint">{t('giveaway.noEntrants')}</span>
                )}
              </div>

              {/* Collapsed by default: the numbers matter to the handful of
                  people who check them, and would be noise to everybody else. */}
              {row.serverSeed && (
                <details className="w-full">
                  <summary className="cursor-pointer text-xs text-ink-faint hover:text-ink-muted">
                    {t('giveaway.verify')}
                  </summary>
                  <dl className="mt-2 grid gap-1 text-[11px] sm:grid-cols-2">
                    <Row label={t('giveaway.seedHash')} value={row.serverSeedHash} />
                    <Row label={t('giveaway.seed')} value={row.serverSeed} />
                    <Row label={t('giveaway.clientSeed')} value={row.clientSeed ?? ''} />
                    <Row label={t('giveaway.roll')} value={String(row.roll ?? '')} />
                  </dl>
                </details>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="truncate font-mono" title={value}>
        {value}
      </dd>
    </div>
  );
}
