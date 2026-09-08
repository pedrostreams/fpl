import type { Route } from 'next'
import Link from 'next/link'
import { ChangeFeed } from '@/components/change-feed'
import { Metric, Panel } from '@/components/dash'
import { fmtInt } from '@/lib/format'
import { getChangeFeed, getSeasonContext, getSnapshotCoverage } from '@/lib/queries'

/**
 * What moved since you last looked.
 *
 * The app answered every question in the present tense, so finding the three facts that changed
 * since Tuesday meant sweeping seven pages. That — rather than the number of routes — is what
 * made it feel scattered.
 *
 * Almost no new data. `player_snapshots` is insert-on-change, `player_price_events` is a labelled
 * event log and `market_odds` is append-on-change: three change logs, accumulating since
 * 2026-07-26, none of them previously read as one. Migration 0036 is the reading.
 */

export default async function ChangedPage() {
  const [events, ctx, coverage] = await Promise.all([
    getChangeFeed(150),
    getSeasonContext(),
    getSnapshotCoverage(),
  ])

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const last24 = events.filter((e) => e.at >= since).length
  const byKind = (k: string) => events.filter((e) => e.kind === k).length

  return (
    <div className="flex flex-col gap-5">
      <div
        className="flex flex-wrap items-start justify-between gap-6 rounded-xl border p-4"
        style={{ background: 'var(--surface)' }}
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight">What changed</h1>
          <p className="mt-1 max-w-3xl text-[13px]" style={{ color: 'var(--muted)' }}>
            Everything the hourly capture has seen move: prices, fitness, set-piece duty, and the
            market re-pricing a fixture. Nothing here is ranked or scored — your squad and your
            watchlist are the filter.
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-7">
          <Metric label="Last 24h" value={fmtInt(last24)} hint="events" />
          <Metric label="Fitness" value={fmtInt(byKind('availability'))} hint="all time" />
          <Metric
            label="Price"
            value={fmtInt(byKind('price'))}
            hint={ctx.seasonStarted ? 'all time' : 'frozen until GW1'}
          />
          <Metric
            label="Captured"
            value={coverage.changeSpanHours === null ? '—' : `${coverage.changeSpanHours}h`}
            hint="of series"
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
          <strong>Preseason.</strong> Two of the four kinds cannot fire yet.{' '}
          <strong>Prices</strong> are frozen until the GW1 deadline — FPL counts no transfer
          before then — and the <strong>market</strong> only re-prices a fixture inside about a
          day of kickoff. Fitness and set-piece duty are live now, and they are the two that
          actually change a preseason decision.
        </div>
      )}

      <Panel
        title="Feed"
        href="/status"
        hrefLabel="Is the capture alive?"
        lead={
          events.length === 0 ? (
            'Nothing captured yet.'
          ) : (
            <>
              Newest first. A dot marks what arrived since your last visit — that read position is
              the only thing this page remembers about you, and it never leaves your browser.
            </>
          )
        }
      >
        <ChangeFeed events={events} />
      </Panel>

      <p className="text-[12px]" style={{ color: 'var(--faint)' }}>
        Price movement in detail, once it unfreezes, is on{' '}
        <Link href={'/prices' as Route} className="underline decoration-dotted">
          price &amp; ownership watch
        </Link>
        .
      </p>
    </div>
  )
}
