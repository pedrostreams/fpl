import { MovementTable } from '@/components/movement-table'
import { fmtInt, relativeAge } from '@/lib/format'
import { getMovement, getSeasonContext, getSnapshotCoverage } from '@/lib/queries'

export const revalidate = 300

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'ok' | 'warn'
}) {
  return (
    <div
      className="flex flex-col gap-0.5 rounded-xl border px-4 py-3"
      style={{ background: 'var(--surface)' }}
    >
      <span
        className="text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: 'var(--faint)' }}
      >
        {label}
      </span>
      <span
        className="num text-[15px] font-semibold"
        style={{
          color: tone === 'warn' ? 'var(--warn)' : tone === 'ok' ? 'var(--ok)' : 'var(--text)',
        }}
      >
        {value}
      </span>
      {hint && (
        <span className="text-[11px]" style={{ color: 'var(--faint)' }}>
          {hint}
        </span>
      )}
    </div>
  )
}

export default async function PricesPage() {
  const [rows, coverage, ctx] = await Promise.all([
    getMovement(),
    getSnapshotCoverage(),
    getSeasonContext(),
  ])

  // Liveness comes from when the job last RAN, not from the last row written: the table is
  // insert-on-change, so a perfectly healthy hourly job writes nothing at all while the
  // market is frozen. Judging freshness by the last row would call that dead.
  const staleRun = coverage.minutesSinceLastRun === null || coverage.minutesSinceLastRun > 150
  const anyMovement = rows.some((r) => (r.netTransfersEvent ?? 0) !== 0)

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Price &amp; ownership watch</h1>
        <p className="mt-1 max-w-3xl text-[13px]" style={{ color: 'var(--muted)' }}>
          The one screen built on data that exists nowhere else. The FPL API has no history
          endpoint — no way to ask what a player cost last Tuesday — so every change below comes
          from our own hourly snapshots, and <strong>none of it can be backfilled</strong>. What
          we did not capture is gone.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Capturing since"
          value={
            coverage.firstChange
              ? new Date(coverage.firstChange).toISOString().slice(0, 16).replace('T', ' ')
              : '—'
          }
          hint={`${fmtInt(coverage.instants)} instants with a change · ${fmtInt(coverage.rows)} rows`}
        />
        <Stat
          label="Last capture run"
          value={relativeAge(
            coverage.minutesSinceLastRun === null ? null : coverage.minutesSinceLastRun * 60,
          )}
          hint={staleRun ? 'Expected hourly — check the workflow' : 'Hourly, on schedule'}
          tone={staleRun ? 'warn' : 'ok'}
        />
        <Stat
          label="24h window"
          value={coverage.covers24h ? 'Ready' : 'Not yet'}
          hint={
            coverage.covers24h
              ? 'Δ columns are meaningful'
              : `${coverage.changeSpanHours ?? 0}h of history so far`
          }
          tone={coverage.covers24h ? 'ok' : undefined}
        />
        <Stat
          label="7d window"
          value={coverage.covers7d ? 'Ready' : 'Not yet'}
          hint={coverage.covers7d ? 'Weekly drift available' : 'Fills in by itself'}
          tone={coverage.covers7d ? 'ok' : undefined}
        />
      </div>

      {!anyMovement && (
        <div
          className="rounded-xl border px-4 py-3 text-[13px]"
          style={{
            background: 'color-mix(in oklab, var(--accent) 8%, var(--surface))',
            borderColor: 'color-mix(in oklab, var(--accent) 30%, var(--border))',
          }}
        >
          <strong>Prices are frozen.</strong> FPL does not move a price, or count a gameweek
          transfer, until the GW1 deadline — verified: every player currently reads 0 net
          transfers and 0 price change since the season start. So the transfer columns are
          genuinely empty rather than broken, and they populate on their own the moment the
          deadline passes.
          {!ctx.seasonStarted && (
            <>
              {' '}
              Ownership <em>does</em> move in the meantime, as the crowd builds squads — which is
              the one signal available now, and the one that tells you which differentials are
              still differentials.
            </>
          )}
        </div>
      )}

      {staleRun && (
        <div
          className="rounded-xl border px-4 py-3 text-[13px]"
          style={{
            background: 'color-mix(in oklab, var(--warn) 9%, var(--surface))',
            borderColor: 'color-mix(in oklab, var(--warn) 28%, var(--border))',
          }}
        >
          <strong>The snapshot job has not run for over 150 minutes.</strong> It is scheduled
          hourly. GitHub&apos;s cron is best-effort and delays of half an hour are routine, but a
          longer gap is lost time series — and this is the only table in the project that cannot
          be rebuilt from a source. Check the <code>sync-snapshot</code> workflow.
        </div>
      )}

      <MovementTable rows={rows} covers24h={coverage.covers24h} />
    </div>
  )
}
