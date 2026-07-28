import type { Route } from 'next'
import Link from 'next/link'
import { CaptainPanel } from '@/components/captain-panel'
import { Metric, Panel, RunPips } from '@/components/dash'
import { PlayerIdentity } from '@/components/player-identity'
import { TeamBadge } from '@/components/team-badge'
import { WatchButton } from '@/components/watch-button'
import { fmt, fmtInt, fmtPct, fmtPrice, fmtSigned, relativeAge } from '@/lib/format'
import { FixtureNote } from '@/components/fixture-note'
import {
  getCaptainPicks,
  getFormPlayers,
  getManager,
  getNextMatches,
  getSeasonContext,
  getSnapshotCoverage,
  getSyncHealth,
  getTargetPlayers,
  getTeamTargets,
  getWatchlist,
  getWatchlistCodes,
} from '@/lib/queries'

export const revalidate = 300

function kickoff(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Oslo',
  })
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000)
}

export default async function Dashboard() {
  const [
    ctx, manager, watchlist, captains, attackRuns, defenceRuns, targets, form, matches,
    coverage, health, watchedCodes,
  ] = await Promise.all([
    getSeasonContext(),
    getManager(),
    getWatchlist(),
    getCaptainPicks(30),
    getTeamTargets('attack', 5),
    getTeamTargets('defence', 5),
    getTargetPlayers(6),
    getFormPlayers(6),
    getNextMatches(10),
    getSnapshotCoverage(),
    getSyncHealth(),
    getWatchlistCodes(),
  ])

  const gw = captains[0]?.gameweek ?? matches[0]?.gameweek ?? null
  const firstKickoff = matches[0]?.kickoff ?? null
  const days = daysUntil(firstKickoff)
  const stale = health.filter((h) => h.ageSeconds === null || h.ageSeconds > 60 * 60 * 36)
  const lastSeason = manager?.seasons[0]
  const priceFrozen = !watchlist.some((w) => (w.netTransfersEvent ?? 0) !== 0)

  return (
    <div className="flex flex-col gap-5">
      {/* ---- the strip: what a manager needs before anything else ---- */}
      <div
        className="flex flex-wrap items-start justify-between gap-6 rounded-xl border p-4"
        style={{ background: 'var(--surface)' }}
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {manager?.name ?? 'Dashboard'}
          </h1>
          <p className="mt-1 text-[13px]" style={{ color: 'var(--muted)' }}>
            {manager?.playerName}
            {manager?.favouriteTeam && ` · ${manager.favouriteTeam}`}
            {lastSeason &&
              ` · last season ${fmtInt(lastSeason.totalPoints)} pts, rank ${fmtInt(lastSeason.rank)}`}
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-7">
          <Metric
            label="Next deadline"
            value={gw === null ? '—' : `GW${gw}`}
            hint={days === null ? undefined : `${days} days · ${kickoff(firstKickoff)}`}
            tone="accent"
          />
          <Metric
            label="Watchlist"
            value={fmtInt(watchlist.length)}
            hint={watchlist.length === 0 ? 'nothing saved yet' : 'players saved'}
          />
          <Metric
            label="Sync"
            value={stale.length ? `${stale.length} stale` : 'all fresh'}
            hint={
              coverage.minutesSinceLastRun === null
                ? 'no snapshot run recorded'
                : `snapshot ${relativeAge(coverage.minutesSinceLastRun * 60)}`
            }
            tone={stale.length ? 'warn' : 'ok'}
          />
        </div>
      </div>

      {!ctx.seasonStarted && (
        <div
          className="rounded-xl border px-4 py-3 text-[13px]"
          style={{
            background: 'color-mix(in oklab, var(--accent) 8%, var(--surface))',
            borderColor: 'color-mix(in oklab, var(--accent) 30%, var(--border))',
          }}
        >
          <strong>Preseason.</strong> {ctx.currentSeason} has not kicked off, so every player
          rate below is {ctx.statsSeason} shown against current prices and clubs. Two things are
          genuinely unavailable rather than missing:{' '}
          <strong>your squad</strong> — FPL does not publish picks until the GW1 deadline — and{' '}
          <strong>price movement</strong>, which is frozen until the same moment. Both fill in on
          their own.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---- watchlist ---- */}
        <Panel
          title="Your watchlist"
          href="/players"
          hrefLabel="Find players"
          lead={
            watchlist.length === 0
              ? 'Nothing saved. Heart a player anywhere in the app and they appear here with their next fixture.'
              : `${watchlist.length} saved. Their next fixture and ownership drift, so you can decide without leaving this page.`
          }
        >
          {watchlist.length > 0 && (
            <div className="flex flex-col gap-2.5">
              {watchlist.map((w) => (
                <PlayerIdentity
                  key={w.playerCode}
                  playerCode={w.playerCode}
                  name={w.webName}
                  position={w.position}
                  teamCode={w.teamCode}
                  teamShort={w.teamShort}
                  status={w.status}
                  news={w.news}
                  opponent={{ short: w.opponentShort, isHome: w.isHome }}
                  sub={
                    <>
                      {fmtPrice(w.price)} · {fmtPct(w.selectedByPercent)} owned
                      {w.nextDifficulty !== null && ` · ${(1 - w.nextDifficulty).toFixed(2)} ease`}
                    </>
                  }
                  right={
                    <span className="num text-[12px]" style={{ color: 'var(--muted)' }}>
                      {fmt(w.xgiPer90, 3)}
                      <span className="ml-1 text-[10px]" style={{ color: 'var(--faint)' }}>
                        xGI
                      </span>
                    </span>
                  }
                  action={<WatchButton playerCode={w.playerCode} watched />}
                />
              ))}
            </div>
          )}
        </Panel>

        {/* ---- captain: two axes, see components/captain-panel.tsx ---- */}
        <Panel title={gw === null ? 'Captain' : `Captain · GW${gw}`}>
          {captains.length === 0 ? (
            <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
              No candidate clears the 450-minute reliability floor yet.
            </p>
          ) : (
            <CaptainPanel picks={captains} watchedCodes={watchedCodes} />
          )}
        </Panel>

        {/* ---- teams to target ---- */}
        <Panel
          title="Teams to target"
          href="/teams"
          hrefLabel="Full ticker"
          lead={
            attackRuns.length === 0 ? (
              'No fixture data.'
            ) : (
              <>
                <strong>{attackRuns[0].name}</strong> has the kindest attacking run over GW
                {attackRuns[0].firstGameweek}–{attackRuns[0].lastGameweek} at{' '}
                {fmt(attackRuns[0].xgForPerFixture, 2)} expected goals per game.
              </>
            )
          }
        >
          <div className="flex flex-col gap-3">
            <div>
              <div
                className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: 'var(--faint)' }}
              >
                For attackers
              </div>
              {attackRuns.map((t) => (
                <div key={t.teamCode} className="flex items-center gap-2 py-0.5">
                  <Link
                    href={`/team/${t.teamCode}` as Route}
                    className="flex shrink-0 items-center gap-1.5 hover:underline"
                    data-tip={t.name}
                  >
                    <TeamBadge teamCode={t.teamCode} name={t.name} size={16} />
                    <span className="w-9 text-[12px] font-medium">{t.shortName}</span>
                  </Link>
                  <span className="num w-10 shrink-0 text-[11px]" style={{ color: 'var(--muted)' }}>
                    {fmt(t.xgForPerFixture, 2)}
                  </span>
                  <RunPips opponents={t.opponents} />
                </div>
              ))}
            </div>
            <div>
              <div
                className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: 'var(--faint)' }}
              >
                For defenders and keepers
              </div>
              {defenceRuns.map((t) => (
                <div key={t.teamCode} className="flex items-center gap-2 py-0.5">
                  <Link
                    href={`/team/${t.teamCode}` as Route}
                    className="flex shrink-0 items-center gap-1.5 hover:underline"
                    data-tip={t.name}
                  >
                    <TeamBadge teamCode={t.teamCode} name={t.name} size={16} />
                    <span className="w-9 text-[12px] font-medium">{t.shortName}</span>
                  </Link>
                  <span className="num w-10 shrink-0 text-[11px]" style={{ color: 'var(--muted)' }}>
                    {fmtPct((t.pCleanSheetPerFixture ?? 0) * 100, 0)}
                  </span>
                  <RunPips opponents={t.opponents} />
                </div>
              ))}
            </div>
          </div>
          <p className="text-[11px]" style={{ color: 'var(--faint)' }}>
            Per fixture, never summed — mid-gameweek the windows differ in size and a total
            would just reward having more games left. Clean-sheet % for the defensive run.
          </p>
        </Panel>

        {/* ---- players to target ---- */}
        {/* No ownership gate here any more. This panel used to read `hidden_gems`, so the
            answer to "who should I buy" silently excluded Haaland, Saka, Raya and Bruno for
            the crime of being popular — one filter doing two different jobs. `/gems` keeps
            it, because being unowned is that page's entire premise. */}
        <Panel
          title="Players to target"
          href="/gems"
          hrefLabel="Differentials"
          lead={
            targets.length === 0 ? (
              'No player qualifies yet.'
            ) : (
              <>
                Output, minutes, value and this week&apos;s fixture, weighted equally —
                ownership shown but not scored. <strong>{targets[0].webName}</strong> leads
                {targets[0].fixtureCount > 0 && <> against {targets[0].opponents}</>}.
              </>
            )
          }
        >
          <div className="flex flex-col gap-2.5">
            {targets.map((t) => (
              <PlayerIdentity
                key={t.playerCode}
                playerCode={t.playerCode}
                name={t.webName}
                position={t.position}
                teamCode={t.teamCode}
                teamShort={t.teamShort}
                status={t.status}
                news={t.news}
                sub={
                  <span className="flex flex-wrap items-center gap-1.5">
                    <FixtureNote row={t} compact />
                    <span>
                      {fmtPrice(t.price)} · {fmtPct(t.selectedByPercent)} owned ·{' '}
                      {fmt(t.pointsPerMillion, 1)} pts/£m
                    </span>
                    {t.isDifferential && (
                      <span
                        className="rounded px-1 text-[9px] font-bold uppercase"
                        style={{
                          background: 'color-mix(in oklab, var(--accent) 22%, transparent)',
                          color: 'var(--accent)',
                        }}
                        data-tip="Under 10% owned — a differential rather than template"
                      >
                        diff
                      </span>
                    )}
                  </span>
                }
                right={
                  <span className="num text-[12px]" style={{ color: 'var(--accent)' }}>
                    {fmt(t.score, 3)}
                  </span>
                }
                action={
                  <WatchButton
                    playerCode={t.playerCode}
                    watched={watchedCodes.includes(t.playerCode)}
                  />
                }
              />
            ))}
          </div>
        </Panel>

        {/* ---- form ---- */}
        <Panel
          title="Players in form"
          href="/players"
          hrefLabel="Scout"
          lead={
            form[0]?.basis === 'form' ? (
              <>
                FPL&apos;s 30-day scoring average. <strong>{form[0].webName}</strong> leads.
              </>
            ) : (
              <>
                <strong>Form is not live yet.</strong>{' '}
                FPL&apos;s 30-day average reads 0 for
                everyone until matches are played, so this is {ctx.statsSeason} points per 90
                over at least 900 minutes instead — a high floor on purpose, because a rate
                built on a thin sample ranks a bit-part player above Haaland.
              </>
            )
          }
        >
          <div className="flex flex-col gap-2.5">
            {form.map((p) => (
              <PlayerIdentity
                key={p.playerCode}
                playerCode={p.playerCode}
                name={p.webName}
                position={p.position}
                teamCode={p.teamCode}
                teamShort={p.teamShort}
                sub={
                  <>
                    {fmtPrice(p.price)} · {fmtInt(p.minutes)} min · {fmtInt(p.totalPoints)} pts ·
                    xGI {fmt(p.xgiPer90, 2)}
                    {p.goalsMinusXg !== null && ` · G−xG ${fmtSigned(p.goalsMinusXg, 1)}`}
                  </>
                }
                right={
                  <span className="num text-[12px]">{fmt(p.formValue, 2)}</span>
                }
                action={<WatchButton playerCode={p.playerCode} watched={false} />}
              />
            ))}
          </div>
        </Panel>

        {/* ---- price watch ---- */}
        <Panel
          title="Price watch"
          href="/prices"
          hrefLabel="Full watch"
          lead={
            priceFrozen ? (
              <>
                <strong>Frozen until the GW1 deadline.</strong> FPL moves no price and counts no
                transfer before then, so there is nothing to predict yet — the hourly capture is
                running so the series is ready the moment it unfreezes.
              </>
            ) : (
              'Net transfers over the last 24 hours, from our own hourly capture.'
            )
          }
        >
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Metric
              label="Capturing"
              value={coverage.instants === 0 ? '—' : `${fmtInt(coverage.instants)}`}
              hint="instants with a change"
            />
            <Metric
              label="Last run"
              value={relativeAge(
                coverage.minutesSinceLastRun === null ? null : coverage.minutesSinceLastRun * 60,
              )}
              hint="hourly"
              tone={
                coverage.minutesSinceLastRun !== null && coverage.minutesSinceLastRun > 150
                  ? 'warn'
                  : 'ok'
              }
            />
            <Metric
              label="24h window"
              value={coverage.covers24h ? 'Ready' : 'Not yet'}
              hint={coverage.covers24h ? undefined : `${coverage.changeSpanHours ?? 0}h so far`}
              tone={coverage.covers24h ? 'ok' : undefined}
            />
            <Metric
              label="7d window"
              value={coverage.covers7d ? 'Ready' : 'Not yet'}
              tone={coverage.covers7d ? 'ok' : undefined}
            />
          </div>
        </Panel>

        {/* ---- matches: full width. Ten rows in a half-column left the other half empty
             and the list visually truncated. ---- */}
        <div className="lg:col-span-2">
        <Panel
          title={gw === null ? 'Matches' : `Matches · GW${gw}`}
          href="/teams"
          hrefLabel="Difficulty"
          lead="Win probabilities from the Elo model, fitted against last season's betting market."
        >
          <div className="flex flex-col">
            {matches.map((m, i) => (
              <div
                key={i}
                className="flex items-center gap-2 border-b py-1.5 last:border-b-0"
                data-tip={kickoff(m.kickoff)}
              >
                <span className="w-10 shrink-0 text-right text-[12px] font-medium">
                  {m.homeShort}
                </span>
                {/* Probability bar: home / draw / away, so a match reads as a shape. */}
                <span className="flex h-2 flex-1 overflow-hidden rounded-full">
                  <span
                    style={{ width: `${(m.pHome ?? 0) * 100}%`, background: 'var(--accent)' }}
                    data-tip={`${m.homeName} ${fmtPct((m.pHome ?? 0) * 100, 0)}`}
                  />
                  <span
                    style={{ width: `${(m.pDraw ?? 0) * 100}%`, background: 'var(--faint)' }}
                    data-tip={`Draw ${fmtPct((m.pDraw ?? 0) * 100, 0)}`}
                  />
                  <span
                    style={{ width: `${(m.pAway ?? 0) * 100}%`, background: 'var(--surface-2)' }}
                    data-tip={`${m.awayName} ${fmtPct((m.pAway ?? 0) * 100, 0)}`}
                  />
                </span>
                <span className="w-10 shrink-0 text-[12px] font-medium">{m.awayShort}</span>
                <span
                  className="num w-9 shrink-0 text-right text-[11px]"
                  style={{ color: 'var(--faint)' }}
                  data-tip="Model expected goals in the match"
                >
                  {fmt(m.expectedGoals, 1)}
                </span>
              </div>
            ))}
          </div>
        </Panel>
        </div>
      </div>

      {manager && manager.seasons.length > 0 && (
        <Panel
          title="Your record"
          lead={
            <>
              {manager.seasons.length} seasons on file.{' '}
              {(() => {
                const last3 = manager.seasons.slice(0, 3).reverse()
                if (last3.length < 2) return null
                const improving = (last3[last3.length - 1].rank ?? 0) < (last3[0].rank ?? 0)
                return improving
                  ? 'Your overall rank has improved across the last three.'
                  : 'Your overall rank has slipped across the last three.'
              })()}
            </>
          }
        >
          <div className="scroll-thin overflow-x-auto">
            <div className="flex gap-4">
              {manager.seasons.slice(0, 8).map((s) => (
                <div key={s.seasonName} className="shrink-0">
                  <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--faint)' }}>
                    {s.seasonName}
                  </div>
                  <div className="num text-[14px] font-semibold">{fmtInt(s.totalPoints)}</div>
                  <div className="num text-[11px]" style={{ color: 'var(--muted)' }}>
                    {fmtInt(s.rank)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      )}
    </div>
  )
}
