import { COLUMNS_BY_KEY } from './columns'
import type { Column } from './columns'

/**
 * Percentiles for shading, computed in the browser from rows already on the page.
 *
 * This is a deliberate exception to the rule in CLAUDE.md that no metric is computed in
 * TypeScript, and the line is drawn at what the number is *for*. A percentile that feeds a
 * score — `gem_score`, `floor_score` — is a metric: it changes a recommendation, so it lives
 * in SQL where `python -m sync.cli verify` can assert on it. A percentile that only decides
 * how green a cell is has no such consequence, and putting it in SQL would mean a migration
 * for every column a user might one day pick. That is precisely the friction the column
 * catalogue exists to remove, so it happens here instead.
 *
 * Ties are the whole difficulty, and both obvious choices are wrong in opposite directions.
 * `percent_rank` hands a tie group the rank of its *first* member — which is how every
 * full-time starter on the captain panel came out at "37th percentile" for minutes, tied at
 * the top and reported near the bottom. `cume_dist` counts rows at or *below*, which put all
 * 22 goalkeepers tied on 0.000 xG/90 at the 96th percentile for scoring.
 *
 * Mid-rank — (strictly worse + half of equal) / n — is honest in both directions, and it is
 * what `player_metric_percentile` in migration 0018 computes. The two must agree: the table
 * shades a cell and the profile prints a sentence about the same number, and a reader looking
 * at a green cell described elsewhere as "median" has no way to tell which one lied.
 */

export type Rankable = Record<string, unknown>

/**
 * Mid-rank percentile per distinct value, 1 = best.
 *
 * `sorted` must already run worst-to-best, so a lower-is-better metric is handled by reversing
 * at the call site rather than by a second near-identical function.
 */
function midRank(sorted: number[]): Map<number, number> {
  const n = sorted.length
  const out = new Map<number, number>()
  let i = 0
  while (i < n) {
    let j = i
    while (j + 1 < n && sorted[j + 1] === sorted[i]) j++
    // i is how many are strictly worse; (j - i + 1) is how many share this value.
    out.set(sorted[i], (i + (j - i + 1) / 2) / n)
    i = j + 1
  }
  return out
}

/**
 * Shading value per row for one column, 1 meaning best.
 *
 * Returns null for a row whose value is missing, and null for every row when the column has
 * no meaningful direction — both render as unshaded rather than as "ranked low". The three
 * kinds of absent in DESIGN.md depend on that distinction being preserved this far up.
 */
export function rankColumn(
  rows: Rankable[],
  key: string,
  opts: { within?: string | null } = {},
): (number | null)[] {
  const col: Column | undefined = COLUMNS_BY_KEY.get(key)
  if (!col || col.direction === 'none') return rows.map(() => null)

  const within = opts.within === undefined ? (col.scope === 'all' ? null : 'position') : opts.within

  // Group first, so a centre-back's xGI is ranked against other centre-backs. Ranking across
  // the whole pool would put every defender in the bottom third of any attacking metric and
  // make the column useless for the position it matters least to.
  const groups = new Map<string, number[]>()
  const groupOf = rows.map((r) => (within ? String(r[within] ?? '') : ''))
  rows.forEach((r, i) => {
    const v = r[key]
    if (v === null || v === undefined) return
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isFinite(n)) return
    const g = groupOf[i]
    const bucket = groups.get(g)
    if (bucket) bucket.push(n)
    else groups.set(g, [n])
  })

  const lookup = new Map<string, Map<number, number>>()
  for (const [g, values] of groups) {
    // Worst-to-best. For a lower-is-better metric that is descending, which is the only
    // difference the direction makes — midRank itself never needs to know.
    values.sort((a, b) => (col.direction === 'lower' ? b - a : a - b))
    lookup.set(g, midRank(values))
  }

  return rows.map((r, i) => {
    const v = r[key]
    if (v === null || v === undefined) return null
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isFinite(n)) return null
    return lookup.get(groupOf[i])?.get(n) ?? null
  })
}

/**
 * Every requested column ranked in one pass.
 *
 * Ranks are computed over whatever rows are handed in. Passing the filtered set means the
 * shading rescales to what is on screen — filter to forwards under £7.0 and the best of those
 * goes fully green. That is the useful behaviour for a screen built around composing filters,
 * and it is the caller's choice rather than a hidden one.
 */
export function rankAll(rows: Rankable[], keys: string[]): Map<string, (number | null)[]> {
  const out = new Map<string, (number | null)[]>()
  for (const key of keys) out.set(key, rankColumn(rows, key))
  return out
}
