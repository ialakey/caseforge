'use client';

import { RARITY_COLORS, rarityLabel, type ItemRarity } from '@caseforge/shared';
import { useSettings } from '../lib/settings';

export function rarityColor(rarity: ItemRarity): string {
  return RARITY_COLORS[rarity] ?? '#b0c3d9';
}

export function RarityBadge({ rarity }: { rarity: ItemRarity }) {
  const locale = useSettings((s) => s.locale);
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
      style={{ backgroundColor: `${rarityColor(rarity)}22`, color: rarityColor(rarity) }}
    >
      {rarityLabel(locale, rarity)}
    </span>
  );
}
