'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/store';
import { useSettings } from '../lib/settings';

interface BonusStatus {
  enabled: boolean;
  canSpin: boolean;
  nextSpinAt: string | null;
}

/**
 * The daily bonus, advertised on the landing page.
 *
 * A reward the player has to go looking for is a reward most of them never
 * claim, so the catalogue says outright that a spin is waiting. It renders
 * nothing at all when there is nothing to say — signed out, feature off, or a
 * status that failed to load — because an empty promise strip is worse than no
 * strip.
 */
export function BonusTeaser() {
  const { user } = useAuth();
  const { t } = useSettings();
  const [status, setStatus] = useState<BonusStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!user) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    void api<BonusStatus>('/api/bonus')
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch((err) => {
        // A teaser is decoration: it must never surface an error over the
        // catalogue, which is what the page is actually for.
        if (!cancelled && !(err instanceof ApiError)) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const waiting = status !== null && !status.canSpin && status.nextSpinAt !== null;

  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [waiting]);

  if (!user || !status || !status.enabled) return null;

  const ready = status.canSpin;
  const remaining = status.nextSpinAt ? new Date(status.nextSpinAt).getTime() - now : 0;

  return (
    <Link
      href="/bonus"
      className="group flex flex-wrap items-center gap-4 rounded-xl border p-4 transition"
      style={{
        borderColor: ready ? 'hsl(var(--accent) / 0.5)' : 'hsl(var(--border-subtle))',
        backgroundImage: ready
          ? 'linear-gradient(90deg, hsl(var(--accent) / 0.16), transparent 70%)'
          : undefined,
        backgroundColor: ready ? undefined : 'hsl(var(--surface-raised) / 0.7)',
      }}
    >
      {/* A ready bonus pulses; a spent one sits still. The difference has to be
          visible from across the page, not read. */}
      <span
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-xl ${
          ready ? 'animate-pulse' : ''
        }`}
        style={{
          backgroundColor: ready ? 'hsl(var(--accent) / 0.2)' : 'hsl(var(--surface-overlay))',
        }}
        aria-hidden
      >
        🎁
      </span>

      <div className="min-w-0 flex-1">
        <div className={`font-semibold ${ready ? 'text-accent' : 'text-ink-primary'}`}>
          {ready
            ? t('bonusTeaser.ready')
            : t('bonusTeaser.waiting', { time: formatCountdown(Math.max(0, remaining)) })}
        </div>
        <div className="text-sm text-ink-faint">
          {ready ? t('bonusTeaser.readyHint') : t('bonusTeaser.waitingHint')}
        </div>
      </div>

      <span
        className={
          ready
            ? 'cf-btn-primary px-5 py-2 text-sm'
            : 'cf-btn-ghost px-5 py-2 text-sm group-hover:border-edge-strong'
        }
      >
        {ready ? t('bonusTeaser.spin') : t('bonusTeaser.open')}
      </span>
    </Link>
  );
}

/** hh:mm:ss, the only format a day-long countdown needs. */
function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}
