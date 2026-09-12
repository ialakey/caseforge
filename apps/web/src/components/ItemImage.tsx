import { type ItemRarity } from '@caseforge/shared';
import { rarityColor } from './RarityBadge';

/**
 * A Steam item image on a rarity-coloured backdrop.
 *
 * The backdrop is not decoration: in CS the rarity colour is the primary way to
 * read an item's value at a glance, and that is how the in-game inventory looks.
 * An item without a picture does not break the layout — the same backdrop stays
 * in place with a placeholder.
 *
 * Loading is lazy by default, which suits long lists. Pass `loading="eager"`
 * where the picture has to be ready before it scrolls into view — the opening
 * reel is the case for it.
 */
export function ItemImage({
  src,
  alt,
  rarity,
  className = '',
  loading = 'lazy',
}: {
  src: string | null;
  alt: string;
  rarity: ItemRarity;
  className?: string;
  loading?: 'lazy' | 'eager';
}) {
  const color = rarityColor(rarity);

  return (
    <div
      className={`relative flex items-center justify-center overflow-hidden rounded ${className}`}
      style={{
        background: `radial-gradient(circle at 50% 55%, ${color}33 0%, ${color}11 45%, transparent 75%)`,
      }}
    >
      {src ? (
        <img
          src={src}
          alt={alt}
          loading={loading}
          className="h-full w-full object-contain p-1"
          draggable={false}
        />
      ) : (
        <span className="text-2xl opacity-40" aria-hidden>
          🔫
        </span>
      )}
    </div>
  );
}
