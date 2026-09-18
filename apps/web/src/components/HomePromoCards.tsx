'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { PromoKind, type FeaturedPromo } from '@caseforge/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/store';
import { useSettings } from '../lib/settings';
import { Money } from './Money';

interface BonusStatus {
  enabled: boolean;
  canSpin: boolean;
  nextSpinAt: string | null;
}

/**
 * The promo row under the counters.
 *
 * Two cards, and each renders only when it has something true to say: the
 * bonus card needs a signed-in player with the feature switched on, the promo
 * card needs a code an operator has actually put on the front page. A row of
 * placeholders advertising nothing is worse than a shorter row.
 */
export function HomePromoCards() {
  const { user } = useAuth();
  const { locale, t } = useSettings();
  const [bonus, setBonus] = useState<BonusStatus | null>(null);
  const [promo, setPromo] = useState<FeaturedPromo | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/promo/featured`)
      .then((r) => (r.ok ? (r.json() as Promise<{ promo: FeaturedPromo | null }>) : null))
      .then((data) => {
        if (!cancelled && data) setPromo(data.promo);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setBonus(null);
      return;
    }
    let cancelled = false;
    void api<BonusStatus>('/api/bonus')
      .then((data) => {
        if (!cancelled) setBonus(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Only while there is a countdown to run. A ticker left going on a page with
  // nothing to count is a re-render a second for no reason.
  const counting = bonus?.enabled === true && !bonus.canSpin && bonus.nextSpinAt !== null;
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting]);

  const showBonus = bonus?.enabled === true;
  if (!showBonus && !promo) return null;

  const remaining =
    counting && bonus?.nextSpinAt ? new Date(bonus.nextSpinAt).getTime() - now : 0;

  async function copy(): Promise<void> {
    if (!promo) return;
    try {
      await navigator.clipboard.writeText(promo.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused outright; the code is on screen and
      // can be selected by hand, so there is nothing useful to report.
    }
  }

  return (
    <section className="grid gap-3 sm:grid-cols-2">
      {showBonus && (
        <Link
          href="/bonus"
          className="cf-panel flex items-center gap-4 p-4 transition hover:brightness-110"
        >
          <div className="min-w-0 flex-1">
            <div className="text-xs uppercase tracking-wide text-ink-faint">
              {t('home.promo.bonusTitle')}
            </div>
            <div className="mt-0.5 text-lg font-semibold text-accent">
              {bonus?.canSpin ? t('home.promo.bonusReady') : t('home.promo.bonusIn')}
            </div>
            {!bonus?.canSpin && remaining > 0 && (
              <div className="mt-1 font-mono text-sm text-ink-muted">{countdown(remaining)}</div>
            )}
          </div>
          {bonus?.canSpin && <span className="cf-btn-primary px-4 py-1.5 text-sm">{t('home.promo.bonusCta')}</span>}
        </Link>
      )}

      {promo && (
        <div className="cf-panel flex items-center gap-4 p-4">
          <div className="min-w-0 flex-1">
            <div className="text-xs uppercase tracking-wide text-ink-faint">
              {t('home.promo.codeTitle')}
            </div>
            <div className="mt-0.5 truncate text-lg font-semibold text-accent">{promo.code}</div>
            <div className="mt-0.5 text-xs text-ink-muted">
              {promo.kind === PromoKind.PERCENT ? (
                <>+{(promo.value / 100).toFixed(0)}%</>
              ) : (
                <>
                  +<Money value={promo.value} />
                </>
              )}
              {promo.minDeposit > 0 && (
                <>
                  {' · '}
                  <Money value={promo.minDeposit} />+
                </>
              )}
            </div>
          </div>
          <button onClick={() => void copy()} className="cf-chip shrink-0 px-3 py-1.5 text-sm">
            {copied ? t('home.promo.copied') : t('home.promo.copy')}
          </button>
        </div>
      )}
    </section>
  );

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
}
