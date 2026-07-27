/** Shared display helpers. Keeping them out of the table component means the "—" for a
 *  missing value is one decision, not thirty. */

/** A missing number is an em dash, never 0. A player with no data has not scored zero. */
export function fmt(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return v.toFixed(digits)
}

export function fmtInt(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return Math.round(v).toLocaleString('en-GB')
}

export function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  return `£${v.toFixed(1)}`
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined) return '—'
  return `${v.toFixed(digits)}%`
}

export function fmtSigned(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return '—'
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}`
}

/**
 * One value, formatted the way its catalogue entry says.
 *
 * Centralised because a composed view can put any column anywhere, so "how is this rendered"
 * cannot live in the component that happens to show it. Every branch routes through the
 * helpers above, which means the em-dash-for-missing rule holds for columns nobody has
 * thought of yet.
 */
export function formatCell(v: unknown, format: string): string {
  if (v === null || v === undefined || v === '') return '—'
  if (format === 'text') return String(v)
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return String(v)
  switch (format) {
    case 'int':
      return fmtInt(n)
    case 'num1':
      return fmt(n, 1)
    case 'num2':
      return fmt(n, 2)
    case 'num3':
      return fmt(n, 3)
    case 'price':
      return fmtPrice(n)
    case 'pct':
      return fmtPct(n, 1)
    // A share stored 0..1 rather than 0..100. Multiplying in the formatter keeps the SQL
    // honest — minutes_share really is a fraction — without every caller remembering.
    case 'pct0':
      return fmtPct(n * 100, 0)
    case 'signed1':
      return fmtSigned(n, 1)
    case 'signed2':
      return fmtSigned(n, 2)
    case 'rankOf20':
      return ordinal(n)
    default:
      return fmt(n, 2)
  }
}

/** "18th of 20". Halves survive a double gameweek, where the rank is a mean of two opponents. */
export function ordinal(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  if (!Number.isInteger(v)) return v.toFixed(1)
  const rem100 = v % 100
  if (rem100 >= 11 && rem100 <= 13) return `${v}th`
  return `${v}${['th', 'st', 'nd', 'rd'][v % 10] ?? 'th'}`
}

export const POSITION_VAR: Record<string, string> = {
  GKP: 'var(--pos-gkp)',
  DEF: 'var(--pos-def)',
  MID: 'var(--pos-mid)',
  FWD: 'var(--pos-fwd)',
}

/** FPL availability codes. `a` is fit; the rest all mean "read the news text". */
export const STATUS_LABEL: Record<string, string> = {
  a: 'Available',
  d: 'Doubtful',
  i: 'Injured',
  s: 'Suspended',
  u: 'Unavailable',
  n: 'Not in squad',
}

export function statusColour(status: string | null, chance: number | null): string {
  if (status === 'a') return 'var(--ok)'
  if (status === 'd') return chance !== null && chance <= 25 ? 'var(--danger)' : 'var(--warn)'
  return 'var(--danger)'
}

export function relativeAge(seconds: number | null): string {
  if (seconds === null) return 'never'
  if (seconds < 90) return 'just now'
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
