import Link from 'next/link'
import type { Route } from 'next'
import { PlayerPhoto } from '@/components/player-photo'
import { TeamBadge } from '@/components/team-badge'
import { POSITION_VAR, statusColour } from '@/lib/format'

/**
 * Who a player is, rendered the same way everywhere.
 *
 * Before this there were five: the dashboard's `PlayerLine`, the captain panel's own copy, the
 * players table's first cell, a search result, and the gems card — each with slightly different
 * spacing, a different idea of whether the name was a link, and only two of them showing a club
 * crest. A player is the app's main noun; it should look like one thing.
 *
 * WHAT IS FIXED HERE, so no call site can drift:
 *
 * - The name always links to the profile, and the club always links to the club page. Peder's
 *   LATER.md item 7 was that the dashboard, gems and teams screens were dead ends; the fix is
 *   not "add links to three screens" but "identity is a link, wherever it appears".
 * - `v OPP` / `@ OPP` for the fixture. The `opponents` column encodes home and away as upper
 *   and lower case, which is compact and completely invisible unless you have read the column
 *   help — fine for a column with a header, wrong for a line of prose. Note the two
 *   conventions now coexist deliberately: this component for identity, the column for the table.
 * - The status dot appears only when status is not 'a', carries the news as its tooltip, and
 *   never replaces text. Colour alone is not a message.
 *
 * WHAT CALLERS DECIDE: the slots. `sub` is a line under the name, `right` is numbers, `action`
 * is a button, `lead` is whatever goes before the photo (a rank number, usually). The panels
 * differ in what they measure, not in who they are measuring.
 */

export type IdentityOpponent = {
  short: string | null
  /** null when the club blanks this gameweek — rendered as "no fixture", never as an empty v. */
  isHome: boolean | null
}

export function PlayerIdentity({
  playerCode,
  name,
  position,
  teamCode,
  teamShort,
  teamName,
  status,
  news,
  opponent,
  size = 30,
  wrap = true,
  lead,
  sub,
  right,
  action,
  chips,
}: {
  playerCode: number
  name: string
  position: string
  teamCode?: number | null
  teamShort?: string | null
  teamName?: string | null
  status?: string | null
  news?: string | null
  opponent?: IdentityOpponent | null
  size?: number
  /**
   * Whether the identity line may break onto a second line.
   *
   * True suits a narrow dashboard panel, where a chip wrapping under the name is better than a
   * squeezed row. False is required in a table: a wrapping cell makes row height depend on name
   * length, so the rows stop lining up and the eye loses the column.
   */
  wrap?: boolean
  lead?: React.ReactNode
  sub?: React.ReactNode
  right?: React.ReactNode
  action?: React.ReactNode
  /** Badges that qualify the player — P1, "no shots". Kept a slot so they stay optional. */
  chips?: React.ReactNode
}) {
  const accent = POSITION_VAR[position]

  return (
    <div className="flex items-center gap-2.5">
      {lead}
      <PlayerPhoto playerCode={playerCode} name={name} size={size} accent={accent} />

      <div className="min-w-0 flex-1">
        <div className={`flex items-center gap-1.5 ${wrap ? 'flex-wrap' : ''}`}>
          {status && status !== 'a' && (
            <span
              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: statusColour(status, null) }}
              data-tip={news || undefined}
            />
          )}
          <Link
            href={`/player/${playerCode}` as Route}
            className="truncate text-[13px] font-medium hover:underline"
          >
            {name}
          </Link>
          <span className="shrink-0 text-[10px] font-semibold" style={{ color: accent }}>
            {position}
          </span>

          {teamCode ? (
            <Link
              href={`/team/${teamCode}` as Route}
              className="flex shrink-0 items-center gap-1 text-[11px] hover:underline"
              style={{ color: 'var(--faint)' }}
            >
              <TeamBadge teamCode={teamCode} name={teamName ?? teamShort} size={14} />
              {teamShort}
            </Link>
          ) : (
            teamShort && (
              <span className="shrink-0 text-[11px]" style={{ color: 'var(--faint)' }}>
                {teamShort}
              </span>
            )
          )}

          {opponent && <Opponent opponent={opponent} />}
          {chips}
        </div>

        {sub && (
          <div className="mt-0.5 text-[11px]" style={{ color: 'var(--faint)' }}>
            {sub}
          </div>
        )}
      </div>

      {right && <div className="shrink-0 text-right">{right}</div>}
      {action}
    </div>
  )
}

/**
 * The next fixture. A blank gameweek says so in words — an earlier version of the gems card
 * printed a fixture rank of 0 for a blanking club, which reads as "hardest possible fixture"
 * when the truth is "no fixture at all".
 */
function Opponent({ opponent }: { opponent: IdentityOpponent }) {
  if (!opponent.short || opponent.isHome === null) {
    return (
      <span
        className="shrink-0 text-[11px]"
        style={{ color: 'var(--faint)' }}
        data-tip="No fixture in the next gameweek"
      >
        blank
      </span>
    )
  }
  return (
    <span
      className="num shrink-0 text-[11px]"
      style={{ color: 'var(--faint)' }}
      data-tip={opponent.isHome ? 'At home' : 'Away'}
    >
      {opponent.isHome ? 'v' : '@'} {opponent.short}
    </span>
  )
}
