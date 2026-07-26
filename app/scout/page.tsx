import { ScoutTable } from '@/components/scout-table'
import { relativeAge } from '@/lib/format'
import { getScoutRows, getSeasonContext, getSyncHealth } from '@/lib/queries'

// The sync writes hourly at most, so a 5-minute page cache costs nothing in freshness and
// spares the pooler a full 558-row read per visit.
export const revalidate = 300

export default async function ScoutPage() {
  const [rows, ctx, health] = await Promise.all([
    getScoutRows(),
    getSeasonContext(),
    getSyncHealth(),
  ])

  const stale = health.filter((h) => h.ageSeconds === null || h.ageSeconds > 60 * 60 * 36)

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Player scout</h1>
          <p className="mt-1 text-[13px]" style={{ color: 'var(--muted)' }}>
            {rows.length} players · rates per 90 with percentile rank within position
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px]" style={{ color: 'var(--faint)' }}>
          {/* Surfacing sync freshness in the UI rather than only in `verify`: a silently
              stale page is the failure mode a data tool has to guard against. */}
          {stale.length > 0 ? (
            <span
              className="rounded-full px-2.5 py-1 font-medium"
              style={{
                background: 'color-mix(in oklab, var(--warn) 18%, transparent)',
                color: 'var(--warn)',
              }}
              title={stale.map((s) => `${s.job}: ${relativeAge(s.ageSeconds)}`).join('\n')}
            >
              {stale.length} sync job{stale.length > 1 ? 's' : ''} stale
            </span>
          ) : (
            <span title={health.map((h) => `${h.job}: ${relativeAge(h.ageSeconds)}`).join('\n')}>
              all sync jobs fresh
            </span>
          )}
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
          <strong>Preseason.</strong> {ctx.currentSeason} has not kicked off, so every rate
          below comes from <strong>{ctx.statsSeason}</strong> shown against current prices,
          clubs and ownership. Players marked <em>new</em> have no reliable Premier League
          sample — 19% of the pool, including promoted clubs and new signings — and are left
          unranked rather than ranked last.
        </div>
      )}

      <ScoutTable
        rows={rows}
        statsSeason={ctx.statsSeason}
        seasonStarted={ctx.seasonStarted}
      />
    </div>
  )
}
