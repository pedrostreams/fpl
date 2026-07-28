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

/**
 * Two sources, and the path names lie about their dimensions. Measured 2026-07-28:
 *
 *     40x40    ->  80 x  80   13 KB   square, the portrait squashed to 1:1
 *     110x140  -> 220 x 280   97 KB   the real portrait, 2x for retina
 *     250x250  ->  403
 *
 * Size decides which. The 97 KB portrait is right for a 56px profile avatar and wrong for a
 * table: `/players` has 558 rows, so scrolling the lot would pull 55 MB of headshots. The 80px
 * square at 13 KB still has 2.9x the pixels a 28px avatar needs.
 */
const SOURCES = { small: '40x40', large: '110x140' } as const

/** Above this the cheap square starts to soften. Below it the retina portrait is waste. */
const LARGE_FROM = 40

export function photoUrl(playerCode: number, size = 28): string {
  const src = size >= LARGE_FROM ? SOURCES.large : SOURCES.small
  return `${PHOTO_BASE}/${src}/${playerCode}.png`
}

/**
 * THE CROP, which is the whole of Peder's "the photo looks like it's on top of the circle,
 * not inside it".
 *
 * These are not face shots. They are head-and-torso studio portraits, so `object-fit: cover`
 * into a circle keeps the *centre* of the frame — which is chest. The forehead gets clipped by
 * the top of the circle and the rest fills with jersey. Nothing reads as contained because the
 * head genuinely is jammed against the edge.
 *
 * Rendered six players (tall, short, afro, bald, headband, keeper) at five candidate crops and
 * looked at the sheet. `50% 15%` with a 1.6x zoom is the only one where all six keep a whole
 * head with margin — 1.8x starts shaving crowns off Palmer and Gibbs-White.
 *
 * Expressed as cover + object-position + a scale about the same point, which is
 * aspect-ratio-agnostic: `cover` normalises first, so one pair of numbers works for both the
 * 1:1 source and the 0.786 portrait. (Checked algebraically as well as by eye — both routes
 * land on 7.6%-56.7% of image height.)
 */
const FOCUS = '50% 15%'
const ZOOM = 1.6

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
        boxShadow: accent ? `inset 0 0 0 1.5px ${accent}` : undefined
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
        src={photoUrl(playerCode, size)}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        // Some CDNs refuse hotlinked requests that carry a referrer.
        referrerPolicy="no-referrer"
        className="relative"
        style={{
          width: size,
          height: size,
          objectFit: 'cover',
          objectPosition: FOCUS,
          // The wrapper's overflow-hidden does the clipping; transform never affects layout,
          // so the circle keeps its exact size whatever the zoom.
          transform: `scale(${ZOOM})`,
          transformOrigin: FOCUS,
        }}
      />
    </span>
  )
}
