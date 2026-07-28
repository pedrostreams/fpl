import { PlayersView } from '@/components/players-view'
import { decodeFilters } from '@/lib/filters'
import { relativeAge } from '@/lib/format'
import {
  getPlayerWide,
  getSavedViews,
  getSeasonContext,
  getSyncHealth,
  getWatchlistCodes,
} from '@/lib/queries'
import { tipRows } from '@/lib/tooltip'

export const revalidate = 300

/**
 * The one table.
 *
 * `/scout` and `/gems` were the same 558 rows with different columns and different row
 * filters, which meant every new lens needed a new page. Here a view picks the columns and a
 * filter picks the rows, both live in the URL, and anything the presets do not cover the user
 * composes and saves.
 *
 * Everything ships at once — 89 columns × 558 players, 53 KB gzipped, measured — because a
 * column picker that had to fetch on every choice would be unusable, and because that is
 * still less than the old single-view page sent.
 */
export default async function PlayersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const [table, watchedCodes, savedViews, ctx, health] = await Promise.all([
    getPlayerWide(),
    getWatchlistCodes(),
    getSavedViews(),
    getSeasonContext(),
    getSyncHealth(),
  ])
  const stale = health.filter((h) => h.ageSeconds === null || h.ageSeconds > 60 * 60 * 36)

  const flat = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string') flat.set(k, v)
    else if (Array.isArray(v) && v[0]) flat.set(k, v[0])
  }
  const view = flat.get('view') ?? 'overview'

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Players</h1>
          <p className="mt-1 max-w-3xl text-[13px]" style={{ color: 'var(--muted)' }}>
            A view chooses the columns, a filter chooses the rows, and both are in the URL — any
            combination is a link. Shading is a percentile within position and always means
            better, never bigger, so expected goals conceded is green when it is low. Columns
            where &ldquo;better&rdquo; is not well defined are shown as plain numbers and say so.
          </p>
        </div>
        {/* Sync freshness in the UI rather than only in `verify`: a silently stale page is the
            failure mode a data tool has to guard against. Carried over from /scout.
            One job per row now, rather than the newline-joined string this used to be —
            browsers render `\n` inside a native `title` inconsistently and several ignore it,
            so a list of five stale jobs arrived as one unreadable line. */}
        <div className="flex items-center gap-3 text-[11px]" style={{ color: 'var(--faint)' }}>
          {stale.length > 0 ? (
            <span
              className="rounded-full px-2.5 py-1 font-medium"
              style={{
                background: 'color-mix(in oklab, var(--warn) 18%, transparent)',
                color: 'var(--warn)',
              }}
              data-tip="Stale sync jobs"
              data-tip-note="Every figure on this page is only as fresh as the job that wrote it."
              data-tip-rows={tipRows(
                stale.map((s) => [s.job, relativeAge(s.ageSeconds), 'bad'] as [string, string, 'bad']),
              )}
            >
              {stale.length} sync job{stale.length > 1 ? 's' : ''} stale
            </span>
          ) : (
            <span
              data-tip="Sync freshness"
              data-tip-note="When each job last completed."
              data-tip-rows={tipRows(
                health.map((h) => [h.job, relativeAge(h.ageSeconds)] as [string, string]),
              )}
            >
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
          clubs and ownership. Players with no reliable Premier League sample — promoted clubs
          and new signings — are left unranked rather than ranked last, and their cells are
          hatched.
        </div>
      )}

      <PlayersView
        table={table}
        watchedCodes={watchedCodes}
        savedViews={savedViews}
        statsSeason={ctx.statsSeason}
        initialPreset={view}
        initialFilters={decodeFilters(flat)}
      />
    </div>
  )
}
