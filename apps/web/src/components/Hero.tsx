'use client';

import Link from 'next/link';
import { type AppearanceConfig, UPGRADE_RTP, pickLocalised } from '@caseforge/shared';
import { useSettings } from '../lib/settings';

/**
 * The landing banner.
 *
 * A case site is judged in the first second, and a bare list of cards reads as
 * unfinished however good the cards are. The claim in the shipped headline is
 * the one this project can actually back — the roll is reproducible — so the
 * banner sells the fairness rather than a bonus nobody is offering.
 *
 * Every string here can be replaced from the panel, and an empty one falls
 * back to the translated default: an operator who writes a headline in Russian
 * only still gets a working English site.
 */
export function Hero({
  caseCount,
  itemCount,
  appearance,
}: {
  caseCount: number;
  itemCount: number;
  appearance: AppearanceConfig;
}) {
  const { locale, t } = useSettings();

  const title = pickLocalised(locale, appearance.hero.title) ?? t('home.heroTitle');
  const subtitle = pickLocalised(locale, appearance.hero.subtitle) ?? t('home.heroSubtitle');
  const cta = pickLocalised(locale, appearance.hero.cta) ?? t('home.heroCta');

  return (
    <section className="relative overflow-hidden rounded-2xl border border-edge-subtle">
      {/* Layered washes rather than a flat fill: the banner has to read as the
          brightest thing on the page without becoming a solid colour block. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_70%_120%_at_15%_0%,hsl(var(--accent)/0.22),transparent_60%),radial-gradient(ellipse_60%_120%_at_85%_100%,hsl(262_83%_58%/0.20),transparent_60%)]" />
      {/* An operator's image sits under the washes rather than replacing them,
          so the headline stays readable whatever they upload. */}
      {appearance.hero.imageUrl && (
        <img
          src={appearance.hero.imageUrl}
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full object-cover opacity-40"
        />
      )}
      <div className="absolute inset-0 bg-surface-raised/40" />

      <div className="relative flex flex-col gap-6 p-7 sm:p-10 md:flex-row md:items-center">
        <div className="max-w-xl">
          <span className="inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-medium text-accent">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            provably fair
          </span>

          <h1 className="mt-4 text-3xl font-bold leading-tight sm:text-4xl">{title}</h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-muted sm:text-base">{subtitle}</p>

          <div className="mt-6 flex flex-wrap gap-3">
            <Link href={appearance.hero.ctaHref} className="cf-btn-primary px-6 py-2.5 text-sm">
              {cta}
            </Link>
            <Link href="/profile" className="cf-btn-ghost px-6 py-2.5 text-sm">
              {t('home.heroSecondary')}
            </Link>
          </div>
        </div>

        <dl className="grid grid-cols-3 gap-3 md:ml-auto md:w-auto">
          <Stat label={t('home.statCases')} value={String(caseCount)} />
          <Stat label={t('home.statItems')} value={String(itemCount)} />
          <Stat label={t('home.statRtp')} value={`${(UPGRADE_RTP * 100).toFixed(0)}%`} />
        </dl>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-edge-subtle bg-surface-base/60 px-4 py-3 text-center backdrop-blur-sm">
      <dd className="text-xl font-semibold text-accent">{value}</dd>
      <dt className="mt-0.5 text-[11px] uppercase tracking-wide text-ink-faint">{label}</dt>
    </div>
  );
}
