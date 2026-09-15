'use client';

import { useState } from 'react';

/**
 * A Steam avatar.
 *
 * The picture lives on someone else's CDN and may fail to load (hidden profile,
 * blocked domain, host down). Hence the fallback — an initial on a coloured
 * circle: a broken-image box in the header reads as a broken site.
 */
export function SteamAvatar({
  src,
  name,
  size = 32,
}: {
  src: string | null;
  name: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const initial = name.trim().charAt(0).toUpperCase() || '?';

  if (!src || failed) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-full bg-surface-hover font-medium text-ink-muted"
        style={{ width: size, height: size, fontSize: size * 0.45 }}
        aria-hidden
      >
        {initial}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={`${name} avatar`}
      width={size}
      height={size}
      onError={() => setFailed(true)}
      className="shrink-0 rounded-full object-cover"
      style={{ width: size, height: size }}
    />
  );
}
