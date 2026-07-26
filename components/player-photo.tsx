/**
 * A player's face, with a monogram behind it and no JavaScript involved.
 *
 * TWO DELIBERATE CHOICES, both from measuring the CDN rather than guessing:
 *
 * 1. Plain `<img>`, never `next/image`. The optimizer would fetch each photo *server-side*
 *    through Vercel — and resources.premierleague.com throttles sequential requests from one
 *    IP hard. Testing it: five codes in a row returned 200, 200, 200, then dropped the TCP
 *    connection twice; requesting the "failing" code first returned 200 immediately. Nothing
 *    was missing, the IP was rate-limited. A browser spreads those requests across the user's
 *    own connection and its own cache, which is exactly what we want and what the optimizer
 *    would take away.
 *
 * 2. The fallback is CSS, not an onError handler. A client component per row would mean 558 of
 *    them on the scout screen for a purely visual concern. Instead the monogram is painted on
 *    the wrapper and the image sits on top; `alt=""` means a failed load renders nothing at all
 *    rather than a broken-image glyph, so the monogram simply shows through.
 *
 * The URL is derivable — `players.photo` is `{code}.jpg` and the code IS the photo id, so no
 * extra column is needed, only `.jpg` swapped for `.png`. Verified 100% populated across all
 * 558 players.
 */

// `premierleague25` is a versioned asset root that FPL bumps on its own schedule — it still
// serves current-season photos, while `premierleague26` never answered. One constant, so the
// day it breaks there is a single line to change. Tracked in FIX_WHEN_LIVE.md.
const PHOTO_BASE = 'https://resources.premierleague.com/premierleague25/photos/players'

/** Only 40x40 was confirmed to exist; 250x250 never answered. Enough for an avatar. */
const SIZE = '40x40'

export function photoUrl(playerCode: number): string {
  return `${PHOTO_BASE}/${SIZE}/${playerCode}.png`
}

function monogram(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function PlayerPhoto({
  playerCode,
  name,
  size = 28,
  accent,
}: {
  playerCode: number
  name: string
  size?: number
  /** A CSS colour for the ring — position colour reads faster than a text label. */
  accent?: string
}) {
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full"
      style={{
        width: size,
        height: size,
        background: 'var(--surface-2)',
        boxShadow: accent ? `inset 0 0 0 1.5px ${accent}` : undefined,
      }}
      title={name}
    >
      {/* Underneath: initials. Visible only when the photo is absent or still loading. */}
      <span
        aria-hidden
        className="absolute font-semibold"
        style={{ fontSize: Math.round(size * 0.36), color: 'var(--faint)' }}
      >
        {monogram(name)}
      </span>
      <img
        src={photoUrl(playerCode)}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        // Some CDNs refuse hotlinked requests that carry a referrer.
        referrerPolicy="no-referrer"
        className="relative"
        style={{ width: size, height: size, objectFit: 'cover' }}
      />
    </span>
  )
}
