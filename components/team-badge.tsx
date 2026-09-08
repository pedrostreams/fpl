/**
 * A club crest, keyed on our own `teams.code`.
 *
 * The code in the badge path is the same `code` every FK in this schema uses — verified against
 * all 20 clubs, and 11 really is Everton. That matters more than it sounds: `teams.fpl_id` is
 * season-scoped and reused, so keying artwork on the id would silently repaint half the league
 * the day FPL renumbers.
 *
 * SVG, not the PNG ladder. `badges/50/{code}.png` (22 KB) and `badges/100/{code}.png` (33 KB)
 * both exist, but the SVG is 41 KB of pure vector — no embedded raster, checked — so it is one
 * file per club that stays sharp from a 14px table row to a 40px page header. Twenty files, each
 * fetched once and cached, against a size ladder that would need picking per call site and would
 * still soften on a retina screen.
 *
 * Same two rules as `player-photo.tsx`, for the same measured reasons: plain `<img>` so the
 * browser fetches over the user's own connection instead of a server-side optimiser tripping the
 * CDN's rate limit, and a CSS fallback rather than an onError handler so a missing crest costs
 * nothing and needs no client component.
 */

const BADGE_BASE = 'https://resources.premierleague.com/premierleague25/badges'

export function badgeUrl(teamCode: number): string {
  return `${BADGE_BASE}/${teamCode}.svg`
}

export function TeamBadge({
  teamCode,
  name,
  size = 16,
}: {
  teamCode: number | null | undefined
  /** Used as the tooltip and, if the crest fails, as the visible text. */
  name?: string | null
  size?: number
}) {
  // A player with no club — which happens between a transfer and the next `dimensions` run —
  // gets nothing rather than a broken frame.
  if (!teamCode) return null

  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
      data-tip={name || undefined}
    >
      <img
        src={badgeUrl(teamCode)}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        // `contain`, never `cover`: crests are not square — Everton's is tall, Chelsea's round —
        // and cover would crop the shield's points off.
        style={{ width: size, height: size, objectFit: 'contain' }}
      />
    </span>
  )
}
