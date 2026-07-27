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
 * Matching `cume_dist()` rather than `percent_rank()` is not a detail. They disagree on ties,
 * and percent_rank hands a tie group the rank of its *first* member — which is how every
 * full-time starter on the captain panel came out at "37th percentile" for minutes. These
 * distributions are heavily tied at the top, so the same bug is one careless line away.
 */

export type Rankable = Record<string, unknown>

/** Ascending cume_dist: the share of rows whose value is at or below this one. */
function cumeDist(sorted: number[]): Map<number, number> {
  const n = sorted.length
  const out = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    // The last index holding this value decides it, so every tied row gets the same share.
    if (i + 1 === n || sorted[i + 1] !== sorted[i]) out.set(sorted[i], (i + 1) / n)
  }
  return out
}

/** Descending equivalent: the share of rows at or above this one. */
function cumeDistDesc(sorted: number[]): Map<number, number> {
  const n = sorted.length
  const out = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    if (i === 0 || sorted[i - 1] !== sorted[i]) out.set(sorted[i], (n - i) / n)
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
    values.sort((a, b) => a - b)
    lookup.set(g, col.direction === 'lower' ? cumeDistDesc(values) : cumeDist(values))
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
