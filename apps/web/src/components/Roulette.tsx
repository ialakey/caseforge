'use client';

import { useEffect, useRef, useState } from 'react';
import type { CaseItemView } from '@caseforge/shared';
import { ItemImage } from './ItemImage';
import { rarityColor } from './RarityBadge';

/** Strip pitch. Must match the tile dimensions in the markup below. */
const H_TILE = 148;
const V_TILE = 116;
const GAP = 8;

/** Strip length and the winner's position inside it. */
const STRIP_LENGTH = 60;
const WINNER_INDEX = 52;

/** Base spin duration and the per-reel stagger. */
export const SPIN_MS = 5200;
const STAGGER_MS = 260;

export type Orientation = 'horizontal' | 'vertical';

interface RouletteProps {
  /** Case contents — the strip is drawn from them. */
  pool: CaseItemView[];
  /** The item that dropped. null keeps the reel still. */
  winner: CaseItemView | null;
  /** Changes on every opening: rebuilds the strip and starts the spin. */
  spinId: number;
  orientation?: Orientation;
  /**
   * Index of this reel within the batch. Reels stop one after another rather
   * than together, so the eye can read each outcome.
   */
  index?: number;
  onFinish?: () => void;
}

/**
 * The case-opening reel.
 *
 * It behaves like the in-game one: the strip travels and decelerates so the
 * winner ends up under the marker. The outcome is already known — the server
 * returned it — and the reel merely plays it back. Tuning the animation for
 * "fairness" is neither needed nor allowed: the roll was computed from the
 * seed pair before the animation started.
 *
 * The winner sits at a fixed WINNER_INDEX with spare tiles behind it —
 * otherwise the end of the strip becomes visible during deceleration.
 */
export function Roulette({
  pool,
  winner,
  spinId,
  orientation = 'horizontal',
  index = 0,
  onFinish,
}: RouletteProps) {
  const [strip, setStrip] = useState<CaseItemView[]>([]);
  const [offset, setOffset] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [landed, setLanded] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);

  const horizontal = orientation === 'horizontal';
  const tile = horizontal ? H_TILE : V_TILE;
  const stride = tile + GAP;
  const duration = SPIN_MS + index * STAGGER_MS;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!winner || pool.length === 0 || !viewport) return;

    const tiles: CaseItemView[] = [];
    for (let i = 0; i < STRIP_LENGTH; i++) {
      tiles.push(pool[Math.floor(Math.random() * pool.length)]!);
    }
    tiles[WINNER_INDEX] = winner;

    // A small random offset inside the tile: landing dead centre every single
    // time looks fake. Keep it narrow — with a wide spread the marker ends up
    // at the tile edge and it becomes unclear which of two neighbours dropped.
    const jitter = (Math.random() - 0.5) * (tile * 0.22);
    const viewportSize = horizontal ? viewport.clientWidth : viewport.clientHeight;
    const target = WINNER_INDEX * stride + tile / 2 - viewportSize / 2 + jitter;

    setStrip(tiles);
    setLanded(false);
    setAnimating(false);
    setOffset(0);

    // Two frames: the first hands the browser the reset position with no
    // transition, the second sets the target with one. In a single frame the
    // browser would coalesce both styles and there would be no scroll at all.
    let innerRaf = 0;
    const outerRaf = requestAnimationFrame(() => {
      innerRaf = requestAnimationFrame(() => {
        setAnimating(true);
        setOffset(target);
      });
    });

    const timer = setTimeout(() => {
      setLanded(true);
      onFinish?.();
    }, duration);

    return () => {
      cancelAnimationFrame(outerRaf);
      cancelAnimationFrame(innerRaf);
      clearTimeout(timer);
    };
    // onFinish is deliberately out of the deps: a fresh callback reference on
    // every parent render would restart the animation from scratch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinId, winner, pool, horizontal]);

  if (pool.length === 0) return null;

  const winnerColor = winner ? rarityColor(winner.rarity) : '#fbbf24';

  return (
    <div
      ref={viewportRef}
      className="relative overflow-hidden rounded-lg border bg-neutral-950 transition-all duration-500"
      style={{
        height: horizontal ? 168 : 320,
        borderColor: landed ? winnerColor : '#262626',
        boxShadow: landed ? `0 0 26px -6px ${winnerColor}` : undefined,
      }}
    >
      {/* Marker: a line across the strip with arrows at the edges */}
      {horizontal ? (
        <>
          <div className="pointer-events-none absolute inset-y-0 left-1/2 z-20 -ml-px w-0.5 bg-amber-400" />
          <Arrow className="left-1/2 top-0 -ml-1.5" direction="down" />
          <Arrow className="bottom-0 left-1/2 -ml-1.5" direction="up" />
          <Fade className="inset-y-0 left-0 w-24 bg-gradient-to-r" />
          <Fade className="inset-y-0 right-0 w-24 bg-gradient-to-l" />
        </>
      ) : (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-1/2 z-20 -mt-px h-0.5 bg-amber-400" />
          <Fade className="inset-x-0 top-0 h-16 bg-gradient-to-b" />
          <Fade className="inset-x-0 bottom-0 h-16 bg-gradient-to-t" />
        </>
      )}

      <div
        className={horizontal ? 'flex h-full items-center' : 'flex h-full flex-col items-center'}
        style={{
          gap: `${GAP}px`,
          transform: horizontal
            ? `translate3d(${-offset}px, 0, 0)`
            : `translate3d(0, ${-offset}px, 0)`,
          // A sharp start and a long deceleration — the same curve CS uses.
          transition: animating
            ? `transform ${duration}ms cubic-bezier(0.10, 0.82, 0.12, 1)`
            : 'none',
          willChange: 'transform',
        }}
      >
        {strip.map((item, i) => {
          const isWinner = landed && i === WINNER_INDEX;
          // Losing tiles dim once the reel stops: across ten reels a single
          // highlight is not enough and the eye still loses the winner.
          const dimmed = landed && !isWinner;
          const color = rarityColor(item.rarity);
          return (
            <div
              key={`${spinId}-${i}`}
              className="flex shrink-0 flex-col items-center justify-center rounded bg-neutral-900 transition-all duration-500"
              style={{
                width: horizontal ? H_TILE : '86%',
                height: horizontal ? 140 : V_TILE,
                borderBottom: `2px solid ${color}`,
                background: isWinner
                  ? `linear-gradient(180deg, ${color}55 0%, #171717 75%)`
                  : undefined,
                boxShadow: isWinner ? `0 0 34px -2px ${color}` : undefined,
                transform: isWinner ? 'scale(1.08)' : undefined,
                opacity: dimmed ? 0.25 : 1,
                zIndex: isWinner ? 15 : undefined,
              }}
            >
              <ItemImage
                src={item.imageUrl}
                alt={item.marketHashName}
                rarity={item.rarity}
                className={horizontal ? 'h-20 w-full' : 'h-14 w-full'}
                /**
                 * The strip is about 8900px long and the winner sits near its
                 * end, far past the range a lazy image would be preloaded in.
                 * On a cold cache the tile under the marker would arrive after
                 * the reel had already stopped on it. Eager costs nothing here:
                 * the 60 tiles are drawn from the case pool, so they repeat the
                 * same handful of URLs and the browser fetches each one once.
                 */
                loading="eager"
              />
              <div className="w-full truncate px-2 text-center text-[10px] text-neutral-400">
                {item.marketHashName}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Arrow({ className, direction }: { className: string; direction: 'up' | 'down' }) {
  const border =
    direction === 'down'
      ? { borderTop: '9px solid #fbbf24' }
      : { borderBottom: '9px solid #fbbf24' };
  return (
    <div
      className={`pointer-events-none absolute z-20 h-0 w-0 ${className}`}
      style={{ borderLeft: '7px solid transparent', borderRight: '7px solid transparent', ...border }}
    />
  );
}

function Fade({ className }: { className: string }) {
  return (
    <div className={`pointer-events-none absolute z-10 from-neutral-950 to-transparent ${className}`} />
  );
}
