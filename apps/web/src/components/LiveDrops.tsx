'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { WS_EVENTS, type LiveDrop } from '@caseforge/shared';
import { getSocket } from '../lib/socket';
import { useT } from '../lib/settings';
import { ItemImage } from './ItemImage';
import { Money } from './Money';
import { rarityColor } from './RarityBadge';

/**
 * How many drops are kept in the row.
 *
 * More than fit on any screen, on purpose: the row is clipped rather than
 * scrollable, so the surplus is what lets a wide monitor show more of it than
 * a laptop without either of them running out of cards.
 */
const MAX_VISIBLE = 30;

/**
 * The live drop strip above the header.
 *
 * It does not scroll, by design. A strip that scrolls asks to be dragged, and
 * what is behind the fold is a drop from four minutes ago that nobody went
 * looking for — so the row is simply clipped at the edge of the screen, and a
 * new drop pushes the oldest one out of sight. Nothing here is navigation;
 * it is a sign of life, and the whole of it is visible without a gesture.
 *
 * The opening state is rendered on the server. The strip now sits above the
 * header on every page, and one that mounted empty would shift the entire
 * layout down a moment later, on every single navigation.
 */
export function LiveDrops({
  initial,
  best,
  showBest,
  profilesPublic,
}: {
  initial: LiveDrop[];
  best: LiveDrop | null;
  showBest: boolean;
  profilesPublic: boolean;
}) {
  const t = useT();
  const [drops, setDrops] = useState<LiveDrop[]>(initial);

  useEffect(() => {
    const socket = getSocket();
    // The server sends batches roughly every 300 ms rather than single
    // events: at peak, one-by-one delivery buries both the network and the
    // renderer.
    const onBatch = (batch: LiveDrop[]) => {
      setDrops((prev) => [...batch.slice().reverse(), ...prev].slice(0, MAX_VISIBLE));
    };
    socket.on(WS_EVENTS.DROPS_BATCH, onBatch);
    return () => {
      socket.off(WS_EVENTS.DROPS_BATCH, onBatch);
    };
  }, []);

  if (drops.length === 0 && !best) return null;

  return (
    <div
      className="flex w-full items-stretch gap-2 overflow-hidden bg-surface-base/90 px-2 py-2"
      aria-label={t('drops.feedLabel')}
    >
      {showBest && best && <BestDrop drop={best} profilesPublic={profilesPublic} />}

      {/* `min-w-0` is what makes the clipping work: without it this flex child
          takes its content's intrinsic width and pushes the pinned card off
          the screen instead of hiding its own overflow. */}
      <div className="flex min-w-0 flex-1 gap-2 overflow-hidden">
        {drops.map((drop) => (
          <DropCard key={drop.openingId} drop={drop} profilesPublic={profilesPublic} />
        ))}
      </div>
    </div>
  );
}

/**
 * One drop in the row.
 *
 * A link when profiles are public and the drop knows whose it is — an entry
 * replayed from a backlog written before drops carried a user id has no
 * profile to open, and a link that goes nowhere is worse than plain text.
 */
function DropCard({ drop, profilesPublic }: { drop: LiveDrop; profilesPublic: boolean }) {
  const colour = rarityColor(drop.rarity);

  const body = (
    <>
      <ItemImage
        src={drop.itemImageUrl}
        alt={drop.itemName}
        rarity={drop.rarity}
        className="h-10 w-full"
      />
      <div className="truncate text-[11px] font-medium leading-tight" title={drop.itemName}>
        {drop.itemName}
      </div>
      {/* Each on its own full-width line rather than sharing one: at this card
          width a name and a price side by side leave the username four
          characters and an ellipsis, and the username is the half that makes
          the card worth clicking. */}
      <Money value={drop.price} className="block text-[10px] font-semibold text-accent" />
      <div className="truncate text-[10px] text-ink-faint" title={drop.username}>
        {drop.username}
      </div>
    </>
  );

  // A fixed width rather than a minimum one: the row is non-shrinking flex
  // children, so an auto width is the widest child's intrinsic width — one
  // knife with a long name and a wear suffix would stretch its own card past
  // every neighbour, and `truncate` would never fire because nothing
  // constrained the line.
  const className =
    'w-[116px] shrink-0 rounded-md border-t-2 bg-surface-raised/80 px-1.5 py-1 leading-tight transition hover:bg-surface-overlay';

  if (profilesPublic && drop.userId) {
    return (
      <Link
        href={`/u/${drop.userId}`}
        className={className}
        style={{ borderTopColor: colour }}
        title={drop.username}
      >
        {body}
      </Link>
    );
  }

  return (
    <div className={className} style={{ borderTopColor: colour }}>
      {body}
    </div>
  );
}

/**
 * The priciest drop of the last day, pinned to the left of the row.
 *
 * Wider and louder than the rest because it is the one card that answers the
 * question a visitor actually has about a case site — how good does this get.
 * It never scrolls out of view: it is outside the clipped row, not inside it.
 */
function BestDrop({ drop, profilesPublic }: { drop: LiveDrop; profilesPublic: boolean }) {
  const t = useT();
  const colour = rarityColor(drop.rarity);

  // "AWP | Hyper Beast (Field-Tested)" splits into a weapon and a skin; the
  // wear suffix is dropped because at this size it is three words of noise.
  const [weapon, rest] = drop.itemName.split('|').map((part) => part.trim());
  const skin = (rest ?? '').replace(/\s*\([^()]*\)\s*$/, '');

  const body = (
    <>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-semibold" style={{ color: colour }}>
          {t('drops.bestOfDay')}
        </div>
        <div className="truncate text-[11px] text-ink-faint" title={drop.itemName}>
          {weapon}
        </div>
        <div className="truncate text-xs font-medium" title={drop.itemName}>
          {skin || weapon}
        </div>
        <Money value={drop.price} className="text-[11px] font-semibold text-accent" />
      </div>
      <ItemImage
        src={drop.itemImageUrl}
        alt={drop.itemName}
        rarity={drop.rarity}
        className="h-12 w-16 shrink-0"
      />
    </>
  );

  const className =
    'flex w-[220px] shrink-0 items-center gap-1.5 rounded-md px-2 py-1 transition hover:brightness-110';
  // Tinted with the item's own rarity rather than the accent: the card is
  // making a claim about how rare the drop was, and the palette already says
  // that in a language players read instantly.
  const style = {
    background: `linear-gradient(90deg, ${colour}33, ${colour}0d)`,
    boxShadow: `inset 0 0 0 1px ${colour}59`,
  };

  if (profilesPublic && drop.userId) {
    return (
      <Link href={`/u/${drop.userId}`} className={className} style={style} title={drop.username}>
        {body}
      </Link>
    );
  }

  return (
    <div className={className} style={style}>
      {body}
    </div>
  );
}
