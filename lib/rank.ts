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
  const pool = buildPool(rows, key, opts.within)
  if (!pool) return rows.map(() => null)
  const { groupOf, lookup } = pool

  return rows.map((r, i) => {
    const n = numeric(r[key])
    if (n === null) return null
    return lookup.get(groupOf[i])?.get(n) ?? null
  })
}

/** One coercion, used by every path here, so "is this a number" cannot drift between them. */
function numeric(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * The comparison sets, shared by the shading and by the tooltip that describes it.
 *
 * Extracted rather than duplicated, and that is the whole point: the tooltip says "12th of 148
 * midfielders" about the same number the cell shades. Two implementations of "which rows count"
 * would eventually disagree, and a reader looking at a green cell described as median has no
 * way to tell which of the two lied. Sharing the code makes the agreement structural.
 */
function buildPool(rows: Rankable[], key: string, withinOpt?: string | null) {
  const col: Column | undefined = COLUMNS_BY_KEY.get(key)
  if (!col || col.direction === 'none') return null

  const within = withinOpt === undefined ? (col.scope === 'all' ? null : 'position') : withinOpt

  // Group first, so a centre-back's xGI is ranked against other centre-backs. Ranking across
  // the whole pool would put every defender in the bottom third of any attacking metric and
  // make the column useless for the position it matters least to.
  const groups = new Map<string, number[]>()
  const groupOf = rows.map((r) => (within ? String(r[within] ?? '') : ''))
  rows.forEach((r, i) => {
    const n = numeric(r[key])
    if (n === null) return
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

  return { col, within, groups, groupOf, lookup }
}

export type RankDetail = {
  /** Mid-rank percentile, 1 = best. The same number the cell is shaded by. */
  percentile: number
  /**
   * Position from the best end, 1 = best.
   *
   * Derived from the percentile rather than counted separately, so the two can never disagree.
   * A tie group therefore reports the middle of its own span — five players level on 0.00 at
   * the bottom of a 100-row pool all read "98th", which is true of all of them and is what
   * mid-rank means. Rounded, because half a rank is not a thing a reader can use.
   */
  rank: number
  pool: number
  /** The comparison set in words, for the sentence. Null means the whole visible table. */
  within: string | null
}

/**
 * Where one row sits for one column, in words the tooltip can print.
 *
 * Computed on demand — a hover, not a render — so the cost never touches the 8 000 cells that
 * are merely on screen.
 */
export function describeRank(rows: Rankable[], key: string, row: Rankable): RankDetail | null {
  const pool = buildPool(rows, key)
  if (!pool) return null
  const n = numeric(row[key])
  if (n === null) return null

  const within = pool.within ? String(row[pool.within] ?? '') : ''
  const values = pool.groups.get(within)
  const percentile = pool.lookup.get(within)?.get(n)
  if (!values || percentile === undefined) return null

  return {
    percentile,
    rank: Math.max(1, Math.round((1 - percentile) * values.length + 0.5)),
    pool: values.length,
    within: pool.within ? within : null,
  }
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
