'use client';

import { useEffect, useRef, useState } from 'react';
import { useT } from '../lib/settings';

const SIZE = 200;
const CENTER = SIZE / 2;
const RADIUS = 82;
const STROKE = 14;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const SPIN_MS = 3600;
/** Full turns before stopping, so the needle does not merely creep to the target. */
const FULL_TURNS = 4;

interface UpgradeGaugeProps {
  /** Win probability, 0..1. The green arc matches it. */
  chance: number;
  spinning: boolean;
  /** Server outcome: the roll and threshold decide exactly where the needle lands. */
  result: { isWin: boolean; roll: number; threshold: number } | null;
  onSpinEnd?: () => void;
}

/**
 * The upgrade gauge.
 *
 * The green arc is the share of winning rolls, and the needle stops exactly at
 * the point of the circle the drawn roll corresponds to. This is not
 * decoration: the needle position reads as "where the roll out of a million
 * tickets landed", and the arc agreeing with the outcome is visible at a
 * glance, without reading any numbers.
 */
export function UpgradeGauge({ chance, spinning, result, onSpinEnd }: UpgradeGaugeProps) {
  const t = useT();
  const [angle, setAngle] = useState(0);
  const [settled, setSettled] = useState(false);
  const spunFor = useRef<string | null>(null);

  useEffect(() => {
    if (!result || !spinning) return;

    // The same result must not restart the animation on every parent render.
    const key = `${result.roll}:${result.threshold}`;
    if (spunFor.current === key) return;
    spunFor.current = key;

    // The roll maps straight onto an angle: 0 tickets is the top of the
    // gauge, 1,000,000 is a full circle.
    const targetAngle = FULL_TURNS * 360 + (result.roll / 1_000_000) * 360;

    setSettled(false);
    setAngle(0);

    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setAngle(targetAngle));
    });
    const timer = setTimeout(() => {
      setSettled(true);
      onSpinEnd?.();
    }, SPIN_MS);

    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, spinning]);

  const winArc = Math.max(0, Math.min(1, chance)) * CIRCUMFERENCE;
  const showResult = settled && result;

  return (
    <div className="relative" style={{ width: SIZE, height: SIZE }}>
      <svg width={SIZE} height={SIZE} className="-rotate-90">
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          stroke="#262626"
          strokeWidth={STROKE}
        />
        {/* Green arc = the share of winning rolls */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          stroke="#10b981"
          strokeWidth={STROKE}
          strokeDasharray={`${winArc} ${CIRCUMFERENCE - winArc}`}
          strokeLinecap="butt"
          className="transition-all duration-300"
        />
      </svg>

      {/* Needle */}
      <div
        className="absolute inset-0 flex items-start justify-center"
        style={{
          transform: `rotate(${angle}deg)`,
          transition: angle === 0 ? 'none' : `transform ${SPIN_MS}ms cubic-bezier(0.12, 0.78, 0.1, 1)`,
        }}
      >
        <div
          className="h-0 w-0"
          style={{
            marginTop: 6,
            borderLeft: '8px solid transparent',
            borderRight: '8px solid transparent',
            borderTop: '22px solid #fbbf24',
          }}
        />
      </div>

      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {showResult ? (
          <span
            className={`text-lg font-bold ${result.isWin ? 'text-emerald-400' : 'text-red-400'}`}
          >
            {result.isWin ? t('upgrade.success') : t('upgrade.miss')}
          </span>
        ) : (
          <>
            <span className="text-2xl font-bold text-emerald-400">
              {(chance * 100).toFixed(1)}%
            </span>
            <span className="text-[11px] uppercase tracking-wide text-neutral-600">
              {t('upgrade.chance')}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
