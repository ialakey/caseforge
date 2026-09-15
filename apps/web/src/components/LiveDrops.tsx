'use client';

import { useEffect, useState } from 'react';
import { WS_EVENTS, type LiveDrop } from '@caseforge/shared';
import { getSocket } from '../lib/socket';
import { useT } from '../lib/settings';
import { ItemImage } from './ItemImage';
import { Money } from './Money';
import { rarityColor } from './RarityBadge';

const MAX_VISIBLE = 12;

export function LiveDrops() {
  const t = useT();
  const [drops, setDrops] = useState<LiveDrop[]>([]);

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

  if (drops.length === 0) {
    return <div className="cf-panel p-4 text-sm text-ink-faint">{t('home.dropsEmpty')}</div>;
  }

  return (
    <div className="flex gap-2 overflow-x-auto pb-2">
      {drops.map((drop) => (
        <div
          key={drop.openingId}
          className="min-w-[150px] shrink-0 rounded-lg border-t-2 bg-surface-raised/80 p-2 transition hover:bg-surface-overlay"
          style={{ borderTopColor: rarityColor(drop.rarity) }}
        >
          <ItemImage
            src={drop.itemImageUrl}
            alt={drop.itemName}
            rarity={drop.rarity}
            className="mb-1 h-14 w-full"
          />
          <div className="truncate text-xs font-medium">{drop.itemName}</div>
          <div className="truncate text-[11px] text-ink-faint">{drop.username}</div>
          <Money value={drop.price} className="text-xs font-semibold text-accent" />
        </div>
      ))}
    </div>
  );
}
