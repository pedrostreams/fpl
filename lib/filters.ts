import type { Filters, Position } from './columns'

/**
 * Row selection, kept entirely separate from column selection.
 *
 * That separation is Peder's, and it is the right cut: "under £6.0 and fit" means the same
 * thing whether you are looking at finishers or at goalkeepers, so a filter should survive
 * switching view. Everything here is pure so the same code encodes a URL, decodes one, and
 * decides whether a row passes.
 */

export type PlayerRow = Record<string, unknown>

function n(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const x = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(x) ? x : null
}

export function passes(row: PlayerRow, f: Filters, watched: Set<number>): boolean {
  if (f.positions?.length && !f.positions.includes(row.position as Position)) return false
  if (f.teams?.length && !f.teams.includes(String(row.team_short ?? ''))) return false

  const price = n(row.price)
  if (f.priceMin !== undefined && (price === null || price < f.priceMin)) return false
  if (f.priceMax !== undefined && (price === null || price > f.priceMax)) return false

  const owned = n(row.selected_by_percent)
  if (f.ownedMax !== undefined && (owned === null || owned >= f.ownedMax)) return false
  if (f.ownedMin !== undefined && (owned === null || owned < f.ownedMin)) return false

  const mins = n(row.minutes)
  if (f.minutesMin !== undefined && (mins === null || mins < f.minutesMin)) return false

  const share = n(row.minutes_share)
  if (f.minutesShareMin !== undefined && (share === null || share < f.minutesShareMin)) return false

  // `fully_fit` rather than `is_available`: FPL flags a 75%-doubtful player as available, and
  // "available" on a transfer screen has to mean he will actually be on the pitch.
  if (f.availableOnly && row.fully_fit !== true) return false
  if (f.reliableOnly && row.has_reliable_sample !== true) return false
  if (f.penaltyTakersOnly && n(row.penalties_order) !== 1) return false
  if (f.watchedOnly && !watched.has(Number(row.player_code))) return false

  if (f.search) {
    const q = f.search.toLowerCase()
    const hay = `${row.web_name ?? ''} ${row.first_name ?? ''} ${row.second_name ?? ''} ${row.team_name ?? ''}`
    if (!hay.toLowerCase().includes(q)) return false
  }
  return true
}

export function countActive(f: Filters): number {
  return Object.values(f).filter(
    (v) => v !== undefined && v !== false && v !== '' && !(Array.isArray(v) && v.length === 0),
  ).length
}

// ---------------------------------------------------------------------------------------
// URL encoding
// ---------------------------------------------------------------------------------------
// Any view plus filter combination is a link. That is what makes "show me this" possible
// between two people looking at the same mini-league, and it costs one function each way.

export function encodeFilters(f: Filters): string {
  const p = new URLSearchParams()
  if (f.positions?.length) p.set('pos', f.positions.join(','))
  if (f.teams?.length) p.set('team', f.teams.join(','))
  if (f.priceMin !== undefined) p.set('pmin', String(f.priceMin))
  if (f.priceMax !== undefined) p.set('pmax', String(f.priceMax))
  if (f.ownedMin !== undefined) p.set('omin', String(f.ownedMin))
  if (f.ownedMax !== undefined) p.set('omax', String(f.ownedMax))
  if (f.minutesMin !== undefined) p.set('mmin', String(f.minutesMin))
  if (f.minutesShareMin !== undefined) p.set('msmin', String(f.minutesShareMin))
  if (f.availableOnly) p.set('fit', '1')
  if (f.reliableOnly) p.set('rel', '1')
  if (f.watchedOnly) p.set('watch', '1')
  if (f.penaltyTakersOnly) p.set('pen', '1')
  if (f.search) p.set('q', f.search)
  return p.toString()
}

export function decodeFilters(p: URLSearchParams): Filters {
  const f: Filters = {}
  const num_ = (k: string) => (p.has(k) ? Number(p.get(k)) : undefined)
  const pos = p.get('pos')
  if (pos) f.positions = pos.split(',').filter(Boolean) as Position[]
  const team = p.get('team')
  if (team) f.teams = team.split(',').filter(Boolean)
  f.priceMin = num_('pmin')
  f.priceMax = num_('pmax')
  f.ownedMin = num_('omin')
  f.ownedMax = num_('omax')
  f.minutesMin = num_('mmin')
  f.minutesShareMin = num_('msmin')
  if (p.get('fit')) f.availableOnly = true
  if (p.get('rel')) f.reliableOnly = true
  if (p.get('watch')) f.watchedOnly = true
  if (p.get('pen')) f.penaltyTakersOnly = true
  const q = p.get('q')
  if (q) f.search = q
  // Strip the keys that came back undefined, so `countActive` and equality checks are honest.
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) as Filters
}
