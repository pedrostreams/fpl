import type { Route } from 'next'
import Link from 'next/link'
import { Metric, Panel } from '@/components/dash'
import { PlayerIdentity } from '@/components/player-identity'
import { fmt, fmtInt, fmtPct, fmtPrice } from '@/lib/format'
import { tipRows } from '@/lib/tooltip'
import { getManager, getMySquad, getSeasonContext } from '@/lib/queries'

/**
 * My fifteen.
 *
 * Every other screen answers "who is good" in league-wide terms. This one answers "what do I do
 * with what I own", which is the question a manager actually has, and the difference between the
 * two is a join rather than any new analysis.
 *
 * **No authentication is involved.** `entry/{id}/event/{n}/picks/` is public from the GW1
 * deadline onward; the only thing a login would buy is the pre-deadline delta — transfers queued
 * but not confirmed — which is worth about one gameweek of staleness and is not worth storing
 * credentials for. See `docs/LATER.md` item 10 for why "log in with FPL" is not implementable at
 * all any more.
 *
 * Before 2026-08-21 17:30 UTC there is no squad to show. That is a third state, not zero and not
 * an error, and it is what most of this file is about.
 */

const RISK_LABEL: Record<string, string> = {
  congestion: 'midweek load',
  competition: 'competition for the slot',
  minutes_falling: 'minutes falling',
  unavailable: 'fitness flag',
}

function Row({
  p,
  watchedCaption,
}: {
  p: Awaited<ReturnType<typeof getMySquad>>['players'][number]
  watchedCaption?: boolean
}) {
  return (
    <PlayerIdentity
      key={p.playerCode}
      playerCode={p.playerCode}
      name={p.webName}
      position={p.position}
      teamCode={p.teamCode}
      teamShort={p.teamShort}
      status={p.status}
      news={p.news}
      sub={
        <>
          {fmtPrice(p.price)} · {fmtPct(p.selectedByPercent)} owned
          {' · '}
          {p.fixtureCount === 0 ? 'blank' : (p.opponents ?? '—')}
          {p.isCaptain && (
            <span style={{ color: 'var(--accent)' }}> · captain</span>
          )}
          {p.isVice && !p.isCaptain && <span style={{ color: 'var(--faint)' }}> · vice</span>}
          {watchedCaption && p.riskWord && (
            <span style={{ color: 'var(--warn)' }}> · {p.riskWord}</span>
          )}
        </>
      }
      right={
        <span
          className="num text-[12px]"
          style={{ color: 'var(--muted)' }}
          data-tip={p.webName}
          data-tip-rows={tipRows([
            ['Points', fmtInt(p.totalPoints)],
            ['xGI/90', fmt(p.xgiPer90, 2)],
            ['DEFCON/90', fmt(p.defconPer90, 2)],
            ['Minutes share', fmtPct((p.minutesShare ?? 0) * 100, 0)],
            p.pCleanSheet !== null
              ? ['Clean sheet', fmtPct(p.pCleanSheet * 100, 0)]
              : null,
            p.pTeamScores !== null ? ['Team scores', fmtPct(p.pTeamScores * 100, 0)] : null,
            ...p.riskReasons.map((r) => [RISK_LABEL[r] ?? r, 'flagged'] as [string, string]),
          ])}
        >
          {p.multiplier > 1 ? `${p.multiplier}×` : fmt(p.xgiPer90, 2)}
        </span>
      }
    />
  )
}

export default async function MyTeamPage() {
  const [ctx, manager, squad] = await Promise.all([
    getSeasonContext(),
    getManager(),
    getMySquad(),
  ])

  const xi = squad.players.filter((p) => p.inXi)
  const bench = squad.players.filter((p) => !p.inXi)
  const flagged = squad.players.filter((p) => p.riskWord || p.status !== 'a')
  const lastSeason = manager?.seasons[0]

  return (
    <div className="flex flex-col gap-5">
      <div
        className="flex flex-wrap items-start justify-between gap-6 rounded-xl border p-4"
        style={{ background: 'var(--surface)' }}
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {manager?.name ?? 'My team'}
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
            label="Squad"
            value={squad.players.length === 0 ? '—' : fmtInt(squad.players.length)}
            hint={squad.event === null ? 'not published yet' : `GW${squad.event}`}
          />
          <Metric
            label="Flagged"
            value={squad.players.length === 0 ? '—' : fmtInt(flagged.length)}
            hint="fitness or minutes"
            tone={flagged.length > 0 ? 'warn' : undefined}
          />
          <Metric
            label="Seasons"
            value={fmtInt(manager?.seasons.length ?? 0)}
            hint="on record"
          />
        </div>
      </div>

      {squad.players.length === 0 ? (
        <Panel
          title="Not published yet"
          href="/gw"
          hrefLabel="Gameweek brief"
          lead={
            <>
              FPL does not publish any squad — mine or anyone else&rsquo;s — until the{' '}
              <strong>GW1 deadline on 21 August at 17:30 UTC</strong>. This is not a missing
              integration and there is nothing to log in to: the endpoint returns a 404 to
              everybody, and starts returning the fifteen the moment the deadline passes.
            </>
          }
        >
          <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
            The sync already asks for it on every run, so this page fills in on its own. Until
            then the questions it will answer live elsewhere: the{' '}
            <Link href={'/gw' as Route} className="underline decoration-dotted">
              gameweek brief
            </Link>{' '}
            for what to buy and sell, and{' '}
            <Link href={'/players' as Route} className="underline decoration-dotted">
              players
            </Link>{' '}
            for who is worth owning.
            {!ctx.seasonStarted && (
              <>
                {' '}
                Your record below is real; everything about {ctx.currentSeason} is not yet.
              </>
            )}
          </p>
        </Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            title={`Starting XI${squad.event === null ? '' : ` · GW${squad.event}`}`}
            lead="Formation order, as FPL stores it. The multiplier is shown where it is not 1 — that is the captaincy, and under Triple Captain it reads 3."
          >
            <div className="flex flex-col gap-2.5">
              {xi.map((p) => (
                <Row key={p.playerCode} p={p} watchedCaption />
              ))}
            </div>
          </Panel>

          <Panel
            title="Bench"
            lead="In the order they come on, which is the part that decides who covers a blank."
          >
            <div className="flex flex-col gap-2.5">
              {bench.map((p) => (
                <Row key={p.playerCode} p={p} watchedCaption />
              ))}
            </div>
          </Panel>
        </div>
      )}

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
              {manager.seasons.slice(0, 12).map((s) => (
                <div key={s.seasonName} className="shrink-0">
                  <div
                    className="text-[10px] uppercase tracking-wider"
                    style={{ color: 'var(--faint)' }}
                  >
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
