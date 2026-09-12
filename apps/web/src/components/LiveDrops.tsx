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
    return (
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4 text-sm text-neutral-500">
        {t('home.dropsEmpty')}
      </div>
    );
  }

  return (
    <div className="flex gap-2 overflow-x-auto pb-2">
      {drops.map((drop) => (
        <div
          key={drop.openingId}
          className="min-w-[150px] shrink-0 rounded-lg border-t-2 bg-neutral-900 p-2"
          style={{ borderTopColor: rarityColor(drop.rarity) }}
        >
          <ItemImage
            src={drop.itemImageUrl}
            alt={drop.itemName}
            rarity={drop.rarity}
            className="mb-1 h-14 w-full"
          />
          <div className="truncate text-xs font-medium">{drop.itemName}</div>
          <div className="truncate text-[11px] text-neutral-500">{drop.username}</div>
          <Money value={drop.price} className="text-xs text-amber-400" />
        </div>
      ))}
    </div>
  );
}
