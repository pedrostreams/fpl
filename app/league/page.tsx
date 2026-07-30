import { Metric, Panel } from '@/components/dash'
import { PlayerIdentity } from '@/components/player-identity'
import { fmt, fmtInt, fmtPct, fmtPrice, fmtSigned } from '@/lib/format'
import { tipRows } from '@/lib/tooltip'
import { getLeague, getLeagueOwnership, getManager } from '@/lib/queries'

export const revalidate = 300

/**
 * The mini-league, and effective ownership against it.
 *
 * This is the feature a subscription structurally cannot provide: Fantasy Football Fix computes
 * effective ownership against the global top-10k because it does not know who you are playing.
 * A player on 45% national ownership that nobody in Hakuna Mateta owns is a differential *to
 * me*; one on 8% that four of my six rivals hold is the opposite. Neither case is visible in a
 * global number.
 *
 * Empty until the GW1 deadline, and for two separate reasons that the page has to keep apart:
 * standings do not exist until a gameweek has been scored, and picks are 404 until the deadline.
 * Before then the member list is real — it just comes from `new_entries` rather than
 * `standings`, which is the trap migration 0035 exists to document.
 */

export default async function LeaguePage() {
  const [league, ownership, manager] = await Promise.all([
    getLeague(),
    getLeagueOwnership(40),
    getManager(),
  ])

  if (!league) {
    return (
      <div className="flex flex-col gap-5">
        <h1 className="text-xl font-semibold tracking-tight">Mini-league</h1>
        <Panel title="No league synced" lead="Run `python -m sync.cli league` to pull it in.">
          <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
            The league id is read from <code>FPL_LEAGUE_ID</code>, defaulting to 422500.
          </p>
        </Panel>
      </div>
    )
  }

  const started = league.members.some((m) => m.rank !== null)
  const mine = manager?.entryId ?? null

  return (
    <div className="flex flex-col gap-5">
      <div
        className="flex flex-wrap items-start justify-between gap-6 rounded-xl border p-4"
        style={{ background: 'var(--surface)' }}
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{league.name ?? 'Mini-league'}</h1>
          <p className="mt-1 max-w-3xl text-[13px]" style={{ color: 'var(--muted)' }}>
            Effective ownership against these squads rather than against the global top-10k —
            the only ownership figure that can tell you whether a pick protects your lead or
            chases someone else&rsquo;s.
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-7">
          <Metric label="Members" value={fmtInt(league.members.length)} />
          <Metric
            label="Standings"
            value={started ? 'Live' : 'Not yet'}
            hint={started ? undefined : 'no gameweek scored'}
          />
          <Metric
            label="Squads known"
            value={ownership.length === 0 ? '—' : fmtInt(ownership[0]?.rivals ?? 0)}
            hint={ownership.length === 0 ? 'picks are 404 until GW1' : 'picks published'}
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Table"
          lead={
            started
              ? 'Rank, and the movement since last gameweek.'
              : 'Nobody has scored yet, so this is the join order. Ranks appear after GW1 is scored — before that FPL publishes members under `new_entries` and the standings list is genuinely empty.'
          }
        >
          <div className="flex flex-col">
            {league.members.map((m, i) => {
              const moved =
                m.rank !== null && m.lastRank !== null && m.lastRank > 0
                  ? m.lastRank - m.rank
                  : null
              return (
                <div
                  key={m.entryId}
                  className="flex items-center gap-3 border-b py-1.5 last:border-b-0"
                  style={
                    m.entryId === mine
                      ? { background: 'color-mix(in oklab, var(--accent) 7%, transparent)' }
                      : undefined
                  }
                  data-tip={m.entryName ?? String(m.entryId)}
                  data-tip-rows={tipRows([
                    ['Manager', m.playerName ?? '—'],
                    ['Total', fmtInt(m.total)],
                    ['This gameweek', fmtInt(m.eventTotal)],
                    ['Source', m.source === 'standings' ? 'standings' : 'new entries'],
                  ])}
                >
                  <span
                    className="num w-6 shrink-0 text-right text-[12px]"
                    style={{ color: 'var(--faint)' }}
                  >
                    {m.rank ?? i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                    {m.entryName ?? '—'}
                    {m.entryId === mine && (
                      <span className="ml-1.5 text-[10px]" style={{ color: 'var(--accent)' }}>
                        you
                      </span>
                    )}
                  </span>
                  <span className="hidden truncate text-[11px] sm:block" style={{ color: 'var(--faint)' }}>
                    {m.playerName}
                  </span>
                  <span className="num w-12 shrink-0 text-right text-[12px]">
                    {m.total === null ? '·' : fmtInt(m.total)}
                  </span>
                  <span
                    className="num w-8 shrink-0 text-right text-[11px]"
                    style={{ color: moved === null || moved === 0 ? 'var(--faint)' : moved > 0 ? 'var(--ok)' : 'var(--warn)' }}
                  >
                    {moved === null ? '' : moved === 0 ? '–' : fmtSigned(moved, 0)}
                  </span>
                </div>
              )
            })}
          </div>
        </Panel>

        <Panel
          title="Effective ownership"
          href="/players?view=differentials"
          hrefLabel="Differentials"
          lead={
            ownership.length === 0 ? (
              <>
                Nothing to compute yet. Picks are a 404 for every entry until the{' '}
                <strong>GW1 deadline</strong>, and effective ownership without picks is just
                national ownership under a different name.
              </>
            ) : (
              <>
                Σ multiplier ÷ rivals, so a benched owner counts nothing and a captain counts
                twice. It can exceed 100% — everyone captaining the same player is 200%, and that
                is exactly the swing you are exposed to by not owning him.
              </>
            )
          }
        >
          {ownership.length > 0 && (
            <div className="flex flex-col gap-2.5">
              {ownership.map((o) => (
                <PlayerIdentity
                  key={o.playerCode}
                  playerCode={o.playerCode}
                  name={o.webName}
                  position={o.position}
                  teamCode={o.teamCode}
                  teamShort={o.teamShort}
                  sub={
                    <>
                      {fmtPrice(o.price)} · {o.owners}/{o.rivals} own
                      {o.captains > 0 && ` · ${o.captains} captain`}
                      {' · '}
                      {o.opponents ?? 'blank'}
                    </>
                  }
                  right={
                    <span
                      className="num text-[12px]"
                      data-tip={o.webName}
                      data-tip-value={`${fmt(o.effectiveOwnership, 1)}% effective ownership`}
                      data-tip-rows={tipRows([
                        ['Owned by', `${o.owners} of ${o.rivals}`],
                        ['Starting', String(o.starters)],
                        ['Captained', String(o.captains)],
                        ['Owned %', fmtPct(o.ownedPct, 1)],
                        ['National %', fmtPct(o.selectedByPercent, 1)],
                      ])}
                      data-tip-why={
                        (o.eoMinusGlobal ?? 0) > 20
                          ? 'Far heavier here than nationally: owning him protects your position rather than gaining on it.'
                          : (o.eoMinusGlobal ?? 0) < -20
                            ? 'Much lighter here than nationally — a differential inside this league even if the country owns him.'
                            : undefined
                      }
                    >
                      {fmt(o.effectiveOwnership, 0)}%
                      <span className="ml-1 text-[10px]" style={{ color: 'var(--faint)' }}>
                        {fmtSigned(o.eoMinusGlobal, 0)}
                      </span>
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}
