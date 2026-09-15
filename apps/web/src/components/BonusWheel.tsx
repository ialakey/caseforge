'use client';

import { useEffect, useRef, useState } from 'react';
import { type WheelSlice, TICKET_SPACE } from '@caseforge/shared';

/** How long the wheel turns, and how many whole turns it makes on the way. */
export const WHEEL_SPIN_MS = 4600;
const FULL_TURNS = 5;

/** Alternating slice fills, so neighbours stay distinct without colour-coding value. */
const FILLS = ['#2a2f3a', '#1d212a'];

/**
 * The daily wheel.
 *
 * Plays back an outcome the server has already decided, exactly as the opening
 * reel does: the roll was computed from the seed pair before the pointer moved,
 * and the animation cannot change where it lands. Slices are drawn in proportion
 * to their real ticket ranges, so a rare prize looks rare.
 */
export function BonusWheel({
  wheel,
  roll,
  spinId,
  onFinish,
  labelFor,
}: {
  wheel: readonly WheelSlice[];
  /** The winning roll, or null to leave the wheel at rest. */
  roll: number | null;
  /** Changes on every spin: restarts the animation. */
  spinId: number;
  onFinish?: () => void;
  labelFor: (slice: WheelSlice) => string;
}) {
  const [angle, setAngle] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;

  useEffect(() => {
    if (roll === null) return;

    // Where the winning ticket sits on the rim, as a fraction of a turn. Using
    // the roll itself rather than the slice index means the pointer lands at a
    // different spot inside the same prize each time, which is what stops five
    // wins in a row from looking identical.
    const fraction = roll / TICKET_SPACE;
    // The pointer is at the top and the wheel turns clockwise, so the wheel has
    // to rotate backwards by the winner's own offset to bring it under there.
    const target = FULL_TURNS * 360 - fraction * 360;

    setSpinning(false);
    setAngle(0);

    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        setSpinning(true);
        setAngle(target);
      });
    });
    // The reel's lesson: a background tab runs timers but not animation frames,
    // so the turn needs a start that does not depend on one.
    const fallback = setTimeout(() => {
      setSpinning(true);
      setAngle(target);
    }, 250);

    const done = setTimeout(() => {
      finishRef.current?.();
    }, WHEEL_SPIN_MS);

    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      clearTimeout(fallback);
      clearTimeout(done);
    };
  }, [spinId, roll]);

  // Slice geometry straight from the ticket ranges: what is drawn and what is
  // rolled are the same numbers.
  const arcs = wheel.map((slice, i) => {
    const from = (slice.rangeFrom / TICKET_SPACE) * 360;
    const to = ((slice.rangeTo + 1) / TICKET_SPACE) * 360;
    return { slice, from, to, mid: (from + to) / 2, fill: FILLS[i % FILLS.length]! };
  });

  return (
    <div className="relative mx-auto aspect-square w-full max-w-[380px]">
      {/* Pointer, fixed at the top; the wheel moves under it. */}
      <div
        className="absolute left-1/2 top-0 z-20 -ml-3 h-0 w-0"
        style={{
          borderLeft: '12px solid transparent',
          borderRight: '12px solid transparent',
          borderTop: '20px solid hsl(var(--accent))',
          filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.6))',
        }}
      />

      <svg
        viewBox="-105 -105 210 210"
        className="h-full w-full"
        style={{
          transform: `rotate(${angle}deg)`,
          transition: spinning
            ? `transform ${WHEEL_SPIN_MS}ms cubic-bezier(0.12, 0.72, 0.10, 1)`
            : 'none',
          willChange: 'transform',
        }}
      >
        <circle
          r="102"
          fill="hsl(var(--surface-base))"
          stroke="hsl(var(--border-strong))"
          strokeWidth="3"
        />

        {arcs.map(({ slice, from, to, mid, fill }) => (
          <g key={slice.key}>
            <path
              d={sectorPath(from, to, 98)}
              fill={fill}
              stroke="hsl(var(--border-subtle))"
              strokeWidth="0.6"
            />
            {/* Labels ride the radius and are flipped on the left half so none
                of them ends up upside down. */}
            <text
              x={0}
              y={0}
              transform={`rotate(${mid}) translate(0, -62) rotate(${mid > 180 ? 90 : -90})`}
              textAnchor="middle"
              dominantBaseline="middle"
              className="fill-ink-primary"
              style={{ fontSize: 7.5, fontWeight: 600 }}
            >
              {labelFor(slice)}
            </text>
          </g>
        ))}

        <circle
          r="17"
          fill="hsl(var(--surface-overlay))"
          stroke="hsl(var(--accent))"
          strokeWidth="2"
        />
      </svg>
    </div>
  );
}

/** An SVG sector from `from` to `to` degrees, measured clockwise from the top. */
function sectorPath(from: number, to: number, radius: number): string {
  const a = polar(from, radius);
  const b = polar(to, radius);
  const large = to - from > 180 ? 1 : 0;
  return `M 0 0 L ${a.x} ${a.y} A ${radius} ${radius} 0 ${large} 1 ${b.x} ${b.y} Z`;
}

function polar(degrees: number, radius: number): { x: number; y: number } {
  // -90 so zero degrees is the top of the circle, where the pointer is.
  const rad = ((degrees - 90) * Math.PI) / 180;
  return { x: radius * Math.cos(rad), y: radius * Math.sin(rad) };
}
