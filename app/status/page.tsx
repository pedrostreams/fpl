import { Metric, Panel } from '@/components/dash'
import { fmtInt, relativeAge } from '@/lib/format'
import { tipRows } from '@/lib/tooltip'
import { getDispatchHealth, getSnapshotCoverage, getSyncHealth } from '@/lib/queries'

export const revalidate = 300

/**
 * Is the data alive?
 *
 * Split off the dashboard deliberately. Sync health is not a decision — it is the precondition
 * for trusting one — and it was taking a slot on the page that answers "what do I do this week".
 * The dashboard keeps a one-word verdict; the reason lives here.
 *
 * Three sources, and the reason there are three is the whole point of the page:
 *
 *   - `sync_freshness` says when each job last succeeded. It cannot see a run stuck on
 *     'running', which is why `verify` flags those separately.
 *   - `snapshot_coverage` says how much *series* we hold. Distinct from freshness because
 *     `player_snapshots` is insert-on-change: a capture where nothing moved writes no rows at
 *     all, so `max(captured_at)` is the last time something *changed*, not the last time the job
 *     ran. Reading it as freshness reports a perfectly healthy job as dead for the whole
 *     preseason.
 *   - `workflow_dispatch_health` separates "the token is dead" (401) from "the job is
 *     unscheduled" from "GitHub is fine and nothing moved". From `sync_runs` alone those are
 *     indistinguishable, and migration 0019 exists because they were.
 */

// 36 hours. Every job here runs at least daily, so a day and a half is late rather than merely
// off-schedule — and it is loose enough that a single skipped nightly run does not cry wolf.
const STALE_SECONDS = 36 * 60 * 60

export default async function StatusPage() {
  const [health, coverage, dispatch] = await Promise.all([
    getSyncHealth(),
    getSnapshotCoverage(),
    getDispatchHealth(),
  ])

  const stale = health.filter((h) => h.ageSeconds === null || h.ageSeconds > STALE_SECONDS)
  const erroring = health.filter((h) => (h.errors24h ?? 0) > 0)

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Status</h1>
        <p className="mt-1 max-w-3xl text-[13px]" style={{ color: 'var(--muted)' }}>
          {stale.length === 0 && erroring.length === 0 ? (
            <>
              Every job has succeeded inside the last 36 hours and none has errored today. Nothing
              on this page needs you.
            </>
          ) : (
            <>
              {stale.length > 0 && (
                <>
                  <strong>
                    {stale.length} job{stale.length === 1 ? '' : 's'} stale
                  </strong>{' '}
                  — {stale.map((h) => h.job).join(', ')}.{' '}
                </>
              )}
              {erroring.length > 0 && (
                <>
                  <strong>
                    {erroring.length} erroring in the last 24 hours
                  </strong>{' '}
                  — {erroring.map((h) => h.job).join(', ')}.
                </>
              )}
            </>
          )}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Jobs"
          lead="Last successful run per job. Age is measured from the last success, not the last attempt — a job that has been failing for two days is stale even though it ran ten minutes ago."
        >
          <div className="flex flex-col">
            {health.map((h) => {
              const isStale = h.ageSeconds === null || h.ageSeconds > STALE_SECONDS
              return (
                <div
                  key={h.job}
                  className="flex items-center gap-3 border-b py-1.5 last:border-b-0"
                  data-tip={h.job}
                  data-tip-value={
                    h.ageSeconds === null ? 'never succeeded' : relativeAge(h.ageSeconds)
                  }
                  data-tip-rows={tipRows([
                    ['Last success', h.lastOk ?? '—'],
                    ['Last attempt', h.lastAttempt ?? '—'],
                    ['Errors, 24h', fmtInt(h.errors24h)],
                  ])}
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      background: isStale
                        ? 'var(--warn)'
                        : (h.errors24h ?? 0) > 0
                          ? 'var(--warn)'
                          : 'var(--ok)',
                    }}
                    aria-hidden
                  />
                  <span className="w-32 shrink-0 text-[12px] font-medium">{h.job}</span>
                  <span
                    className="num flex-1 text-[12px]"
                    style={{ color: isStale ? 'var(--warn)' : 'var(--muted)' }}
                  >
                    {relativeAge(h.ageSeconds)}
                  </span>
                  {(h.errors24h ?? 0) > 0 && (
                    <span className="num text-[11px]" style={{ color: 'var(--warn)' }}>
                      {fmtInt(h.errors24h)} err
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </Panel>

        <Panel
          title="Dispatch"
          lead="The hourly clock is pg_cron calling the Actions API, not GitHub's own scheduler — which delivered 12 of 33 runs in a day when it was. This is where a dead token shows up as something other than silence."
        >
          {dispatch.length === 0 ? (
            <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
              No dispatch recorded yet.
            </p>
          ) : (
            <div className="flex flex-col">
              {dispatch.map((d) => (
                <div
                  key={d.workflow}
                  className="flex items-center gap-3 border-b py-1.5 last:border-b-0"
                  data-tip={d.workflow}
                  data-tip-rows={tipRows([
                    ['Dispatched, 24h', fmtInt(d.dispatches24h)],
                    ['Accepted', fmtInt(d.ok24h)],
                    ['Failed', fmtInt(d.failed24h)],
                    ['Pending', fmtInt(d.pending)],
                  ])}
                  data-tip-why={d.lastError ?? undefined}
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      background: (d.failed24h ?? 0) > 0 ? 'var(--warn)' : 'var(--ok)',
                    }}
                    aria-hidden
                  />
                  <span className="w-40 shrink-0 truncate text-[12px] font-medium">
                    {d.workflow}
                  </span>
                  <span className="num flex-1 text-[12px]" style={{ color: 'var(--muted)' }}>
                    {fmtInt(d.ok24h)}/{fmtInt(d.dispatches24h)} in 24h
                  </span>
                  <span className="num text-[11px]" style={{ color: 'var(--faint)' }}>
                    {relativeAge(d.minutesSinceLast === null ? null : d.minutesSinceLast * 60)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <div className="lg:col-span-2">
          <Panel
            title="Snapshot coverage"
            href="/prices"
            hrefLabel="Price watch"
            lead={
              coverage.covers7d
                ? 'The series is long enough for every window the app asks of it.'
                : 'The series is still filling. Windows longer than it has been running read as unknown rather than zero — the price columns show a middot until they can be computed.'
            }
          >
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
              <Metric label="Rows" value={fmtInt(coverage.rows)} hint="player_snapshots" />
              <Metric
                label="Players"
                value={fmtInt(coverage.players)}
                hint="with a captured change"
              />
              <Metric
                label="Instants"
                value={fmtInt(coverage.instants)}
                hint="captures that moved"
              />
              <Metric
                label="Span"
                value={coverage.changeSpanHours === null ? '—' : `${coverage.changeSpanHours}h`}
                hint="first to last change"
              />
              <Metric
                label="24h window"
                value={coverage.covers24h ? 'Ready' : 'Not yet'}
                tone={coverage.covers24h ? 'ok' : undefined}
              />
              <Metric
                label="7d window"
                value={coverage.covers7d ? 'Ready' : 'Not yet'}
                tone={coverage.covers7d ? 'ok' : undefined}
              />
            </div>
            <p className="text-[11px]" style={{ color: 'var(--faint)' }}>
              Insert-on-change: a capture where nothing moved writes no rows, so the gap since the
              last change is a fact about the market and not about the job. Liveness is the Jobs
              panel above, never this one.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  )
}
