import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PlayerPhoto } from '@/components/player-photo'
import { ShotMap } from '@/components/shot-map'
import { WatchButton } from '@/components/watch-button'
import { COLUMNS_BY_KEY } from '@/lib/columns'
import { POSITION_VAR, fmt, fmtInt, fmtPct, fmtPrice, formatCell, statusColour } from '@/lib/format'
import {
  getPlayerCareer,
  getPlayerFixtures,
  getPlayerRow,
  getPlayerShots,
  getSeasonContext,
  getWatchlistCodes,
} from '@/lib/queries'

export const revalidate = 300

/**
 * One player, in depth.
 *
 * The table answers "who should I look at"; this answers "tell me about him", which is the
 * question you have once a name is on the shortlist. The shot map is the reason the page
 * exists — it is the only view here that shows habits rather than totals.
 */

/** A metric with its catalogue label, formatted by its catalogue rule. */
function Stat({ row, k, hint }: { row: Record<string, unknown>; k: string; hint?: string }) {
  const col = COLUMNS_BY_KEY.get(k)
  if (!col) return null
  return (
    <div title={hint ?? (col.why ? `${col.full}. ${col.why}` : col.full)}>
      <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--faint)' }}>
        {col.label}
      </div>
      <div className="num mt-0.5 text-[15px] font-semibold">{formatCell(row[k], col.format)}</div>
    </div>
  )
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border p-4" style={{ background: 'var(--surface)' }}>
      <div>
        <h2 className="text-[13px] font-semibold uppercase tracking-wider">{title}</h2>
        {note && (
          <p className="mt-1 max-w-2xl text-[12px]" style={{ color: 'var(--faint)' }}>
            {note}
          </p>
        )}
      </div>
      {children}
    </section>
  )
}

export default async function PlayerPage({ params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params
  const code = Number(raw)
  if (!Number.isInteger(code) || code <= 0) notFound()

  const [row, shots, career, fixtures, ctx, watched] = await Promise.all([
    getPlayerRow(code),
    getPlayerShots(code),
    getPlayerCareer(code),
    getPlayerFixtures(code, 6),
    getSeasonContext(),
    getWatchlistCodes(),
  ])
  if (!row) notFound()

  const position = String(row.position ?? 'MID')
  const isKeeperOrDef = position === 'GKP' || position === 'DEF'
  const name = String(row.web_name ?? '')
  const fullName = [row.first_name, row.second_name].filter(Boolean).join(' ')

  return (
    <div className="flex flex-col gap-4">
      {/* ---- identity ---- */}
      <div
        className="flex flex-wrap items-start justify-between gap-5 rounded-xl border p-4"
        style={{ background: 'var(--surface)' }}
      >
        <div className="flex items-center gap-3">
          <PlayerPhoto playerCode={code} name={name} size={56} accent={POSITION_VAR[position]} />
          <div>
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
              {name}
              <span className="text-[12px] font-semibold" style={{ color: POSITION_VAR[position] }}>
                {position}
              </span>
              {row.penalties_order === 1 && (
                <span
                  className="rounded px-1 text-[10px] font-bold"
                  style={{
                    background: 'color-mix(in oklab, var(--accent) 22%, transparent)',
                    color: 'var(--accent)',
                  }}
                  title="First-choice penalty taker"
                >
                  P1
                </span>
              )}
            </h1>
            <p className="mt-0.5 text-[13px]" style={{ color: 'var(--muted)' }}>
              {fullName && `${fullName} · `}
              <Link href={`/team/${Number(row.team_code)}`} style={{ color: 'var(--accent)' }}>
                {String(row.team_name ?? '')}
              </Link>
              {row.age ? ` · ${fmtInt(row.age as number)} years` : ''}
            </p>
            {row.status !== 'a' && (
              <p className="mt-1 flex items-center gap-1.5 text-[12px]" style={{ color: statusColour(String(row.status), null) }}>
                <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: 'currentColor' }} />
                {String(row.news || 'Flagged as not fully available')}
                {row.chance_of_playing !== null && ` · ${fmtInt(row.chance_of_playing as number)}% to play`}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-start gap-6">
          <Stat row={row} k="price" />
          <Stat row={row} k="selected_by_percent" />
          <Stat row={row} k="total_points" />
          <Stat row={row} k="points_per_million" />
          <Stat row={row} k="minutes_share" />
          <div className="pt-1">
            <WatchButton playerCode={code} watched={watched.includes(code)} />
          </div>
        </div>
      </div>

      {/* ---- shot map ---- */}
      <Section
        title="Shot map"
        note={`Every shot located, from ${ctx.statsSeason}. Own goals are excluded — Understat files them against the defender at his own goal line, which would put 41 dots at the wrong end of the pitch.`}
      >
        {/* `head_xg` is null exactly when Understat has no record for the player — set that
            way in player_wide so "unmeasured" survives all the way to the screen. */}
        <ShotMap shots={shots} name={name} mapped={row.head_xg !== null} />
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---- rates ---- */}
        <Section
          title="Rates"
          note={`Per 90 minutes over ${ctx.statsSeason}.${
            row.has_reliable_sample
              ? ''
              : ' Below the 450-minute reliability floor, so read these as indicative rather than measured.'
          }`}
        >
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-4">
            <Stat row={row} k="points_per_90" />
            <Stat row={row} k="xgi_per_90" />
            <Stat row={row} k="xg_per_90" />
            <Stat row={row} k="xa_per_90" />
            <Stat row={row} k="bps_per_90" />
            <Stat row={row} k="defcon_per_90" />
            {isKeeperOrDef && <Stat row={row} k="xgc_per_90" />}
            {isKeeperOrDef && <Stat row={row} k="clean_sheets" />}
            {position === 'GKP' && <Stat row={row} k="saves" />}
            <Stat row={row} k="shots_in_box_per_90" />
            <Stat row={row} k="big_chances_per_90" />
            <Stat row={row} k="non_penalty_xg_per_90" />
            <Stat row={row} k="head_xg_per_90" />
            <Stat row={row} k="xg_buildup_per_90" />
            <Stat row={row} k="goals_minus_xg" />
          </div>
        </Section>

        {/* ---- fixtures ---- */}
        <Section
          title="Next six"
          note={`Coloured by the half of the fixture that matters for a ${position}: ${
            isKeeperOrDef ? 'the clean sheet' : 'the goals'
          }.`}
        >
          {fixtures.length === 0 ? (
            <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
              No upcoming fixtures.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {fixtures.map((f) => (
                <div key={`${f.gameweek}-${f.opponentShort}`} className="flex items-center gap-2.5">
                  <span className="num w-9 shrink-0 text-[11px]" style={{ color: 'var(--faint)' }}>
                    GW{f.gameweek}
                  </span>
                  <span
                    className="heat w-14 shrink-0 rounded px-1.5 py-1 text-center text-[11px] font-semibold"
                    // Inverted, as everywhere: 0 difficulty is the easiest draw.
                    style={{ ['--p' as string]: 1 - (f.positionDifficulty ?? 0.5) }}
                    title={`Difficulty ${fmt(f.positionDifficulty, 2)}`}
                  >
                    {f.isHome ? f.opponentShort?.toUpperCase() : f.opponentShort?.toLowerCase()}
                  </span>
                  <span className="flex-1 text-[11px]" style={{ color: 'var(--muted)' }}>
                    {isKeeperOrDef
                      ? `${fmtPct((f.pCleanSheet ?? 0) * 100, 0)} clean sheet`
                      : `${fmt(f.expectedGoalsFor, 2)} xG for the side`}
                    {' · '}
                    {fmtPct((f.pWin ?? 0) * 100, 0)} to win
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      {/* ---- career ---- */}
      <Section
        title="Career"
        note="Read from FPL's own history rather than the current-season aggregate: the two disagree for loan and transfer cases, and history is the one that is right. Expected stats are zero before 2022-23 because Opta data does not go back further."
      >
        {career.length === 0 ? (
          <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
            No Premier League history. 63 of 558 players are in this position — promoted-club
            squads and signings from abroad.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr style={{ color: 'var(--muted)' }}>
                  {['Season', 'Mins', 'Pts', 'Pts/90', 'G', 'A', 'xG', 'xA', 'CS', 'Bonus'].map((h) => (
                    <th
                      key={h}
                      className="border-b px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide first:text-left"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {career.map((s) => (
                  <tr key={s.season} className="border-b" style={{ borderColor: 'var(--border)' }}>
                    <td className="px-2 py-1.5 font-medium">
                      {s.season}
                      {s.isCurrentSeason && (
                        <span className="ml-1.5 text-[10px]" style={{ color: 'var(--accent)' }}>
                          current
                        </span>
                      )}
                    </td>
                    <td className="num px-2 py-1.5 text-right">{fmtInt(s.minutes)}</td>
                    <td className="num px-2 py-1.5 text-right font-semibold">{fmtInt(s.totalPoints)}</td>
                    <td className="num px-2 py-1.5 text-right">{fmt(s.pointsPer90, 2)}</td>
                    <td className="num px-2 py-1.5 text-right">{fmtInt(s.goals)}</td>
                    <td className="num px-2 py-1.5 text-right">{fmtInt(s.assists)}</td>
                    <td className="num px-2 py-1.5 text-right">{fmt(s.expectedGoals, 2)}</td>
                    <td className="num px-2 py-1.5 text-right">{fmt(s.expectedAssists, 2)}</td>
                    <td className="num px-2 py-1.5 text-right">{fmtInt(s.cleanSheets)}</td>
                    <td className="num px-2 py-1.5 text-right">{fmtInt(s.bonus)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <p className="text-[12px]" style={{ color: 'var(--faint)' }}>
        <Link href="/players" style={{ color: 'var(--accent)' }}>
          ← All players
        </Link>
        {' · '}
        {fmtPrice(row.price as number)} · {fmtInt(row.minutes as number)} minutes in{' '}
        {ctx.statsSeason}
      </p>
    </div>
  )
}
