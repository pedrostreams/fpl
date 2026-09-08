import type { Route } from 'next'
import Link from 'next/link'
import { CaptainPanel } from '@/components/captain-panel'
import { Panel } from '@/components/dash'
import { PlayerIdentity } from '@/components/player-identity'
import { WatchlistBrief } from '@/components/watchlist-brief'
import { fmt, fmtInt, fmtPct, fmtPrice } from '@/lib/format'
import { tipRows } from '@/lib/tooltip'
import {
  getCaptainPicks,
  getGameweekShape,
  getNextMatches,
  getSeasonContext,
  getSellCandidates,
  getTargetPlayers,
} from '@/lib/queries'

/**
 * The gameweek brief — the one thing allaboutfpl has that we did not.
 *
 * Reading a season of their output, the finding was not that they hold better data. On data we are
 * ahead almost everywhere: a calibrated continuous fixture model against a three-tier bucket of
 * last season's table, 92 registered metrics against their six, our own shot-level chance quality
 * against a third-party screenshot. Their advantage is that **every week, in a fixed order, someone
 * answers the five questions a manager actually has and writes a sentence about each.**
 *
 * We had the answers computed and scattered across seven pages with no order and no sentence. This
 * page is the order and the sentences. Almost no new SQL: `fixture_difficulty`, `captain_picks`,
 * `target_players`, `sell_candidates`, `gameweek_shape_summary` and `watchlist_detail` all existed
 * or arrived with F3.
 *
 * The order is theirs, because it is the right one: what is the shape of the week, what do I
 * change, who takes the armband, how do I gain rank, what is coming next.
 */

function Step({
  n,
  question,
  children,
}: {
  n: number
  question: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2.5">
        <span
          className="num flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
          style={{ background: 'var(--surface-2)', color: 'var(--muted)' }}
        >
          {n}
        </span>
        <h2 className="text-[15px] font-semibold tracking-tight">{question}</h2>
      </div>
      <div className="pl-8.5">{children}</div>
    </section>
  )
}

const REASON_LABEL: Record<string, string> = {
  fixtures_turning: 'fixtures turning',
  injured: 'fitness flag',
  defence_declining: 'defence leaking',
  no_attacking_upside: 'nothing at the other end',
  price_falling: 'money leaving',
  rotation_risk: 'minutes falling',
}

export default async function GameweekBrief() {
  const [ctx, matches, captains, targets, sells] = await Promise.all([
    getSeasonContext(),
    getNextMatches(10),
    getCaptainPicks(30),
    getTargetPlayers(5),
    getSellCandidates(6),
  ])

  const gw = captains[0]?.gameweek ?? matches[0]?.gameweek ?? null
  const shape = gw === null ? [] : await getGameweekShape(gw, 6)
  const thisWeek = shape[0]
  const upcoming = shape.slice(1)
  // Only worth a sentence if something is actually irregular. A flat calendar should say so once
  // and take no more space than that.
  const irregular = shape.filter((s) => s.blanking > 0 || s.doubling > 0)
  // The buy/sell conflict is real and must be visible from BOTH sides. The sell rows carry
  // `also a buy candidate`; without this the buy rows said nothing, and a reader working down the
  // buy list would never learn that the same player is flagged three inches to the right.
  const sellCodes = new Set(sells.map((s) => s.playerCode))

  return (
    <div className="flex flex-col gap-7">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {gw === null ? 'Gameweek brief' : `Gameweek ${gw} brief`}
        </h1>
        <p className="mt-1 max-w-3xl text-[13px]" style={{ color: 'var(--muted)' }}>
          The same five questions in the same order every week, each with a sentence. Nothing here
          is new data — it is the answers this app already computes, put in the order a manager
          actually needs them.
          {!ctx.seasonStarted && (
            <>
              {' '}
              <strong>Preseason:</strong> every player rate is {ctx.statsSeason}, and the two
              questions that need this season&rsquo;s matches — form and price movement — say so
              rather than guessing.
            </>
          )}
        </p>
      </div>

      <Step n={1} question="What does the week look like?">
        <div className="flex flex-col gap-2">
          <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
            {thisWeek ? (
              <>
                <strong>{thisWeek.shapeWord}</strong>
                {thisWeek.blankingClubs && <> — {thisWeek.blankingClubs} blank.</>}
                {thisWeek.doublingClubs && <> {thisWeek.doublingClubs} play twice.</>}
                {!thisWeek.blankingClubs && !thisWeek.doublingClubs && (
                  <> — all ten fixtures, so no squad gymnastics needed.</>
                )}
              </>
            ) : (
              'No fixture data for this gameweek.'
            )}
          </p>
          {upcoming.length > 0 && (
            <p className="text-[12px]" style={{ color: 'var(--faint)' }}>
              {irregular.length === 0 ? (
                <>
                  Next {upcoming.length} gameweeks are flat as scheduled. Cup rounds are undrawn
                  beyond GW{shape[0]?.event ?? ''}
                  {upcoming.some((s) => s.provisional > 0) && ' — those weeks are provisional'}, so a
                  blank can still appear. Nothing to plan around yet.
                </>
              ) : (
                <>
                  Coming up:{' '}
                  {irregular.map((s, i) => (
                    <span key={s.event}>
                      {i > 0 && ' · '}
                      GW{s.event} {s.shapeWord}
                    </span>
                  ))}
                  .
                </>
              )}
            </p>
          )}
          <Link
            href={'/teams' as Route}
            className="w-fit text-[12px] underline decoration-dotted"
            style={{ color: 'var(--muted)' }}
          >
            Fixture ticker →
          </Link>
        </div>
      </Step>

      <Step n={2} question="What do I change?">
        <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Buy"
          href="/players?view=overview"
          hrefLabel="All players"
          lead={
            targets.length === 0
              ? 'Nothing clears the target filters this week.'
              : `${targets.length} clear the target filters — output and value against the fixture, position by position. Every one is past the minutes floor, so none is a two-minute rate artefact. The xGI shown is a season rate and means little for a goalkeeper; his case is the clean sheet beside it.`
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
                sub={
                  <>
                    {fmtPrice(t.price)} · {fmtPct(t.selectedByPercent)} owned
                    {/* `opponents` already reads `ARS` home / `ars` away and comma-separates a
                        double, so it is shown as-is rather than re-derived. `blank` where there
                        is no fixture, never an empty string. */}
                    {' · '}
                    {t.fixtureCount === 0 ? 'blank' : (t.opponents ?? '—')}
                    {sellCodes.has(t.playerCode) && (
                      <span style={{ color: 'var(--faint)' }}> · also on the sell list</span>
                    )}
                  </>
                }
                right={
                  <span className="num text-[12px]" style={{ color: 'var(--muted)' }}>
                    {fmt(t.xgiPer90, 3)}
                    <span className="ml-1 text-[10px]" style={{ color: 'var(--faint)' }}>
                      xGI
                    </span>
                  </span>
                }
              />
            ))}
          </div>
        </Panel>

        {/* Sell is the half we never had. Reason codes, never a score — see migration 0032. */}
        <Panel
          title="Sell"
          href="/players?view=enablers"
          hrefLabel="Cheap end"
          lead={
            sells.length === 0 ? (
              <>
                Nobody. Five of the six sell reasons need this season&rsquo;s matches — a fixture
                swing, a price fall, a defence declining — so in preseason only a measured drop in
                minutes can fire, and that is the honest answer rather than a padded list.
              </>
            ) : (
              <>
                {sells.length} to look at, on <strong>measured</strong> grounds only. A run of blanks
                is deliberately not a reason: returns are far noisier than the underlying, and
                selling on a blank run is the most common mistake in this game.
              </>
            )
          }
        >
          {sells.length > 0 && (
            <div className="flex flex-col gap-2.5">
              {sells.map((s) => (
                <PlayerIdentity
                  key={s.playerCode}
                  playerCode={s.playerCode}
                  name={s.webName}
                  position={s.position}
                  teamCode={s.teamCode}
                  teamShort={s.teamShort}
                  status={s.status}
                  news={s.news}
                  sub={
                    <>
                      {fmtPrice(s.price)} · {fmtPct(s.selectedByPercent)} owned
                      {s.alsoATarget && (
                        <span style={{ color: 'var(--faint)' }}> · also a buy candidate</span>
                      )}
                    </>
                  }
                  right={
                    <span
                      className="text-[11px]"
                      style={{ color: 'var(--muted)' }}
                      data-tip={`${s.reasonCount} reason${s.reasonCount === 1 ? '' : 's'}`}
                      data-tip-value={s.sellWord}
                      data-tip-rows={tipRows([
                        ...s.reasons.map(
                          (r) => [REASON_LABEL[r] ?? r, 'flagged'] as [string, string],
                        ),
                        s.recentMinutes !== null
                          ? ['Minutes, last 6', fmt(s.recentMinutes, 0)]
                          : null,
                        s.seasonMinutes !== null ? ['Minutes, season', fmt(s.seasonMinutes, 0)] : null,
                      ])}
                      data-tip-why={
                        s.alsoATarget
                          ? 'He is on both lists, and that conflict is shown rather than resolved: his season numbers are good and his place is going.'
                          : undefined
                      }
                    >
                      {s.reasons.map((r) => REASON_LABEL[r] ?? r).join(' · ')}
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </Panel>
        </div>
      </Step>

      <Step n={3} question="Who takes the armband?">
        {captains.length === 0 ? (
          <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
            No candidate clears the 450-minute reliability floor yet.
          </p>
        ) : (
          <div className="rounded-xl border p-4" style={{ background: 'var(--surface)' }}>
            <p className="mb-3 text-[13px]" style={{ color: 'var(--muted)' }}>
              Two axes, never one score: a <strong>floor</strong> for protecting a lead and a{' '}
              <strong>ceiling</strong> for chasing one. Which you want depends on where you sit in
              the mini-league, and a single number would answer that for you and hide that it had.
            </p>
            <CaptainPanel picks={captains} />
          </div>
        )}
      </Step>

      <Step n={4} question="How do I gain rank?">
        <div className="flex flex-col gap-2">
          <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
            Differentials are under 10% owned, fit, and a regular — the three filters together,
            because a cheap unowned player who does not start is not a differential, he is a bench
            slot.
          </p>
          <Link
            href={'/players?view=differentials' as Route}
            className="w-fit text-[12px] underline decoration-dotted"
            style={{ color: 'var(--muted)' }}
          >
            Differentials →
          </Link>
        </div>
      </Step>

      <Step n={5} question="What am I buying next?">
        {/* Client-side: the watchlist is the only thing on this page a visitor can change, so it
            is the only thing not baked into the prerendered HTML. */}
        <WatchlistBrief />
      </Step>
    </div>
  )
}
