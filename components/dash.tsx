import Link from 'next/link'
import type { Route } from 'next'

/**
 * Dashboard furniture. Each panel leads with a sentence stating what the data says, then shows
 * the evidence — the brief was "an analyst reporting to management": informative enough to
 * decide from, not a wall of numbers to interpret.
 */

export function Panel({
  title,
  lead,
  href,
  hrefLabel,
  children,
}: {
  title: string
  /** The conclusion, in one sentence. If a panel can't state one, it isn't earning its space. */
  lead?: React.ReactNode
  href?: Route
  hrefLabel?: string
  children: React.ReactNode
}) {
  return (
    <section
      className="flex flex-col gap-3 rounded-xl border p-4"
      style={{ background: 'var(--surface)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold uppercase tracking-wider">{title}</h2>
          {lead && (
            <p className="mt-1 text-[13px]" style={{ color: 'var(--muted)' }}>
              {lead}
            </p>
          )}
        </div>
        {href && (
          <Link
            href={href}
            className="shrink-0 text-[11px] font-medium whitespace-nowrap transition-colors hover:underline"
            style={{ color: 'var(--accent)' }}
          >
            {hrefLabel ?? 'Open'} →
          </Link>
        )}
      </div>
      {children}
    </section>
  )
}

/** A small metric with a label under it, for the header strip. */
export function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'ok' | 'warn' | 'accent'
}) {
  const colour =
    tone === 'warn' ? 'var(--warn)' : tone === 'ok' ? 'var(--ok)'
      : tone === 'accent' ? 'var(--accent)' : 'var(--text)'
  return (
    <div>
      <div
        className="text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: 'var(--faint)' }}
      >
        {label}
      </div>
      <div className="num mt-0.5 text-[17px] font-semibold" style={{ color: colour }}>
        {value}
      </div>
      {hint && (
        <div className="text-[11px]" style={{ color: 'var(--faint)' }}>
          {hint}
        </div>
      )}
    </div>
  )
}

/** Difficulty as a filled pip strip — a run reads faster as shape than as a number. */
export function RunPips({
  opponents,
}: {
  opponents: { opponentShort: string; isHome: boolean; difficulty: number | null }[]
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {opponents.map((o, i) => (
        <span
          key={i}
          className="heat rounded px-1.5 py-0.5 text-[10px] font-semibold"
          // Inverted, as everywhere: colour means better, and 0 difficulty is the easiest.
          style={{ ['--p' as string]: o.difficulty === null ? 0 : 1 - o.difficulty }}
          data-tip={`${o.isHome ? 'Home' : 'Away'} v ${o.opponentShort} · difficulty ${
            o.difficulty === null ? '—' : o.difficulty.toFixed(2)
          }`}
        >
          {o.isHome ? o.opponentShort.toUpperCase() : o.opponentShort.toLowerCase()}
        </span>
      ))}
    </div>
  )
}
