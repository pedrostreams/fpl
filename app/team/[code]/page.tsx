import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PlayerPhoto } from '@/components/player-photo'
import { TeamBadge } from '@/components/team-badge'
import { TeamStyleBody } from '@/components/team-style'
import { COLUMNS_BY_KEY } from '@/lib/columns'
import { POSITION_VAR, fmt, fmtInt, fmtPct, formatCell, ordinal } from '@/lib/format'
import {
  getSeasonContext,
  getTeamForm,
  getTeamProfile,
  getTeamSquad,
  getTeamStyle,
} from '@/lib/queries'

export const revalidate = 300

/**
 * One club: how it plays, how it ran, and who is in it.
 *
 * Reached from search or from a player profile. The style numbers are the ones that answer
 * "should I own this club's defenders" — clean-sheet rate, expected goals conceded, and the
 * set-piece threat that decides whether a centre-back is worth a place.
 */

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div data-tip={hint}>
      <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--faint)' }}>
        {label}
      </div>
      <div className="num mt-0.5 text-[15px] font-semibold">{value}</div>
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

const GROUPS: { key: number; title: string }[] = [
  { key: 1, title: 'Goalkeepers' },
  { key: 2, title: 'Defenders' },
  { key: 3, title: 'Midfielders' },
  { key: 4, title: 'Forwards' },
]

const SQUAD_COLS = [
  'price', 'selected_by_percent', 'minutes_share', 'total_points', 'points_per_90',
  'xgi_per_90', 'defcon_per_90', 'bps_per_90',
]

export default async function TeamPage({ params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params
  const code = Number(raw)
  if (!Number.isInteger(code) || code <= 0) notFound()

  const [team, form, squad, ctx, style] = await Promise.all([
    getTeamProfile(code),
    getTeamForm(code, 10),
    getTeamSquad(code),
    getSeasonContext(),
    getTeamStyle(code),
  ])
  if (!team) notFound()

  const hasStyle = Boolean(team.has_style_data)
  const n = (k: string) => team[k] as number | null

  return (
    <div className="flex flex-col gap-4">
      {/* ---- identity ---- */}
      <div
        className="flex flex-wrap items-start justify-between gap-5 rounded-xl border p-4"
        style={{ background: 'var(--surface)' }}
      >
        <div className="flex items-center gap-3">
          <TeamBadge teamCode={code} name={String(team.name ?? '')} size={44} />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{String(team.name ?? '')}</h1>
          <p className="mt-1 text-[13px]" style={{ color: 'var(--muted)' }}>
            {String(team.short_name ?? '')}
            {team.last_position
              ? ` · finished ${ordinal(n('last_position'))} in ${ctx.statsSeason} on ${fmtInt(n('last_points'))} points`
              : ` · no ${ctx.statsSeason} Premier League record`}
            {team.elo ? ` · Elo ${fmtInt(n('elo'))}` : ''}
          </p>
        </div>
        </div>
        <div className="flex flex-wrap items-start gap-6">
          <Stat label="Squad" value={fmtInt(squad.length)} />
          {hasStyle && (
            <>
              <Stat label="xG/match" value={fmt(n('xg_per_match'), 2)} hint="Expected goals created per match" />
              <Stat label="xGA/match" value={fmt(n('xga_per_match'), 2)} hint="Expected goals conceded per match" />
              <Stat label="Clean sheets" value={fmtPct(n('clean_sheet_pct'), 0)} />
              <Stat
                label="PPDA"
                value={fmt(n('ppda'), 1)}
                hint="Opponent passes allowed per defensive action — low means a high press. Not a virtue, just a style."
              />
            </>
          )}
        </div>
      </div>

      {!hasStyle && (
        <div
          className="rounded-xl border px-4 py-3 text-[13px]"
          style={{
            background: 'color-mix(in oklab, var(--warn) 8%, var(--surface))',
            borderColor: 'color-mix(in oklab, var(--warn) 30%, var(--border))',
          }}
        >
          <strong>Promoted.</strong> {String(team.name)} has no {ctx.statsSeason} top-flight
          record, so style, set-piece threat and form below are genuinely unavailable rather
          than zero. The fixture model still covers them — ClubElo is the one source here that
          rates clubs outside the Premier League, which is exactly why the difficulty model is
          built on it.
        </div>
      )}

      {hasStyle && (
        <>
          {/*
            The style section. Season figures rather than form, because a 6-match club mean is
            0.13-0.48 signal and a 38-match mean is 0.49-0.85 — measured, in
            docs/feat/trend-claims.md. Groups are ordered by how firm the property is rather
            than by convention, so creation leads: what a side creates holds up measurably
            better than what it concedes.
          */}
          <Section
            title="How they play"
            note={`${ctx.statsSeason}, all 38 matches, from Understat. Ranks are out of the 17 clubs with a top-flight record — the three promoted sides have none. A metric whose league ordering is no better than chance shows its value and no rank.`}
          >
            <TeamStyleBody style={style} statsSeason={ctx.statsSeason} />
          </Section>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* ---- the rest of the season, unchanged ---- */}
            <Section
              title="Season totals"
              note="The raw counts behind the rates above. xPts is the same model's expected points — the gap against the real total is luck."
            >
              <div className="grid grid-cols-3 gap-4">
                <Stat label="Goals" value={fmtInt(n('goals'))} />
                <Stat label="Conceded" value={fmtInt(n('goals_conceded'))} />
                <Stat label="xG diff" value={fmt(n('xg_difference'), 1)} />
                <Stat label="npxG/match" value={fmt(n('np_xg_per_match'), 2)} hint="Excluding penalties" />
                <Stat label="Clean sheets" value={fmtInt(n('clean_sheets'))} />
                <Stat
                  label="xPts"
                  value={fmt(n('expected_points'), 1)}
                  hint="Expected points from the same model. Compare with the real total above — the gap is luck."
                />
              </div>
            </Section>

            {/* ---- set pieces: where the dead-ball threat comes from ---- */}
            <Section
              title="Set-piece threat"
              note="Where the dead-ball share above comes from. Shots from corners, not corners won — Understat records the shot, and the shot is what scores points."
            >
              <div className="grid grid-cols-3 gap-4">
                <Stat label="Corner xG" value={fmt(n('corner_xg'), 2)} />
                <Stat label="Corner goals" value={fmtInt(n('corner_goals'))} />
                <Stat label="Corner shots" value={fmtInt(n('corner_shots'))} />
                <Stat
                  label="Set-piece xG"
                  value={fmt(style.deadBall?.set_piece_xg ?? null, 2)}
                  hint="Open set pieces other than corners — throw-ins and indirect free kicks worked into the box."
                />
                <Stat
                  label="Free-kick xG"
                  value={fmt(style.deadBall?.free_kick_xg ?? null, 2)}
                  hint="Direct free kicks, shot at goal."
                />
                <Stat label="Header xG" value={fmt(n('head_xg'), 2)} />
              </div>
            </Section>
          </div>
        </>
      )}

      {/* ---- form ---- */}
      {form.length > 0 && (
        <Section
          title="Last ten"
          note="Points against expected points: the gap is where a season was luckier or unluckier than it played."
        >
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr style={{ color: 'var(--muted)' }}>
                  {['', 'Opponent', 'Score', 'xG', 'xGA', 'PPDA', 'Pts', 'xPts', 'Δ'].map((h, i) => (
                    <th
                      key={i}
                      className="border-b px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {form.map((m, i) => (
                  <tr key={i} className="border-b" style={{ borderColor: 'var(--border)' }}>
                    <td className="px-2 py-1.5">
                      <span
                        className="inline-flex h-4 w-4 items-center justify-center rounded text-[9px] font-bold"
                        style={{
                          background:
                            m.result === 'W'
                              ? 'color-mix(in oklab, var(--ok) 25%, transparent)'
                              : m.result === 'D'
                                ? 'var(--surface-2)'
                                : 'color-mix(in oklab, var(--danger) 22%, transparent)',
                          color:
                            m.result === 'W' ? 'var(--ok)' : m.result === 'D' ? 'var(--muted)' : 'var(--danger)',
                        }}
                      >
                        {m.result}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {m.isHome ? m.opponentShort?.toUpperCase() : m.opponentShort?.toLowerCase()}
                    </td>
                    <td className="num px-2 py-1.5 text-right font-semibold">
                      {fmtInt(m.goals)}–{fmtInt(m.opponentGoals)}
                    </td>
                    <td className="num px-2 py-1.5 text-right">{fmt(m.xg, 2)}</td>
                    <td className="num px-2 py-1.5 text-right">{fmt(m.opponentXg, 2)}</td>
                    <td className="num px-2 py-1.5 text-right">{fmt(m.ppda, 1)}</td>
                    <td className="num px-2 py-1.5 text-right">{fmtInt(m.points)}</td>
                    <td className="num px-2 py-1.5 text-right">{fmt(m.expectedPoints, 2)}</td>
                    <td
                      className="num px-2 py-1.5 text-right"
                      style={{
                        color:
                          (m.pointsOverExpected ?? 0) > 0.5
                            ? 'var(--ok)'
                            : (m.pointsOverExpected ?? 0) < -0.5
                              ? 'var(--danger)'
                              : 'var(--faint)',
                      }}
                    >
                      {m.pointsOverExpected === null
                        ? '—'
                        : `${m.pointsOverExpected > 0 ? '+' : ''}${m.pointsOverExpected.toFixed(2)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* ---- squad ---- */}
      <Section
        title="Squad"
        note={`${squad.length} players. Rates from ${ctx.statsSeason} — a summer signing's numbers describe his previous club.`}
      >
        <div className="flex flex-col gap-5">
          {GROUPS.map((g) => {
            const rows = squad.filter((p) => Number(p.element_type) === g.key)
            if (!rows.length) return null
            return (
              <div key={g.key}>
                <div className="mb-1.5 flex items-baseline gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider">{g.title}</span>
                  <span className="num text-[11px]" style={{ color: 'var(--faint)' }}>
                    {rows.length}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-[12px]">
                    <thead>
                      <tr style={{ color: 'var(--muted)' }}>
                        <th
                          className="border-b px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide"
                          style={{ borderColor: 'var(--border)' }}
                        >
                          Player
                        </th>
                        {SQUAD_COLS.map((k) => (
                          <th
                            key={k}
                            className="border-b px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide"
                            style={{ borderColor: 'var(--border)' }}
                            data-tip={COLUMNS_BY_KEY.get(k)?.full}
                          >
                            {COLUMNS_BY_KEY.get(k)?.label ?? k}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((p) => (
                        <tr key={Number(p.player_code)} className="border-b" style={{ borderColor: 'var(--border)' }}>
                          <td className="px-2 py-1">
                            <Link
                              href={`/player/${Number(p.player_code)}`}
                              className="flex items-center gap-2 hover:underline"
                            >
                              <PlayerPhoto
                                playerCode={Number(p.player_code)}
                                name={String(p.web_name ?? '')}
                                size={22}
                                accent={POSITION_VAR[String(p.position)]}
                              />
                              <span className="truncate font-medium">{String(p.web_name ?? '')}</span>
                              {p.status !== 'a' && (
                                <span
                                  className="text-[10px]"
                                  style={{ color: 'var(--warn)' }}
                                  data-tip={String(p.news ?? '')}
                                >
                                  ⚠
                                </span>
                              )}
                            </Link>
                          </td>
                          {SQUAD_COLS.map((k) => (
                            <td key={k} className="num px-2 py-1 text-right">
                              {formatCell(p[k], COLUMNS_BY_KEY.get(k)?.format ?? 'num2')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })}
        </div>
      </Section>

      <p className="text-[12px]" style={{ color: 'var(--faint)' }}>
        <Link href="/teams" style={{ color: 'var(--accent)' }}>
          ← All clubs
        </Link>
        {' · '}
        <Link href={{ pathname: '/players', query: { view: 'overview', team: String(team.short_name) } }} style={{ color: 'var(--accent)' }}>
          Filter the table to {String(team.short_name)}
        </Link>
      </p>
    </div>
  )
}
