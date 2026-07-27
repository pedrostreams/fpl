'use client'

import { useMemo, useState } from 'react'
import { Scatter } from '@/components/scatter'
import type { Point } from '@/components/scatter'
import { COLUMNS, COLUMNS_BY_KEY } from '@/lib/columns'

/**
 * The same rows the table is showing, plotted against each other.
 *
 * Not a separate screen: the view and the filters above it already decided which players and
 * which columns matter, so this is a second rendering of the current selection rather than a
 * new query. Pick any two metrics from the catalogue.
 *
 * ONE POSITION AT A TIME, enforced rather than suggested. Two reasons that happen to agree:
 * a scatter is an all-pairs form so the categorical cap is three, and every percentile in this
 * app is computed within position because a centre-back's xGI against a forward's is
 * meaningless. Plotting all four positions together would be a prettier version of the mistake
 * the rest of the app refuses to make.
 */

const POSITION_MARK: Record<string, string> = {
  GKP: 'var(--chart-gkp)',
  DEF: 'var(--chart-def)',
  MID: 'var(--chart-mid)',
  FWD: 'var(--chart-fwd)',
}

/** Only metrics with a direction can go on an axis — "better is up and right" needs one. */
const PLOTTABLE = COLUMNS.filter(
  (c) => c.direction !== 'none' && c.format !== 'text' && !c.pinned,
)

export function PlayerScatter({
  rows,
  positions,
}: {
  rows: Record<string, unknown>[]
  /** Positions currently selected in the filter bar. */
  positions: string[]
}) {
  const [xKey, setXKey] = useState('shots_per_90')
  const [yKey, setYKey] = useState('xa_per_90')

  // What the filters actually left on screen, not what the user ticked — if they filtered to
  // one club the position may be implied rather than selected.
  const present = useMemo(
    () => [...new Set(rows.map((r) => String(r.position)))].sort(),
    [rows],
  )
  const [pos, setPos] = useState<string | null>(null)
  const active = pos && present.includes(pos) ? pos : present.length === 1 ? present[0] : null

  const xCol = COLUMNS_BY_KEY.get(xKey)
  const yCol = COLUMNS_BY_KEY.get(yKey)

  const points = useMemo<Point[]>(() => {
    if (!active) return []
    const out: Point[] = []
    for (const r of rows) {
      if (String(r.position) !== active) continue
      const xv = r[xKey]
      const yv = r[yKey]
      if (xv === null || xv === undefined || yv === null || yv === undefined) continue
      const x = Number(xv)
      const y = Number(yv)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      out.push({
        id: Number(r.player_code),
        label: String(r.web_name ?? ''),
        x,
        y,
        detail: `${r.team_short} · £${Number(r.price).toFixed(1)}`,
        href: `/player/${Number(r.player_code)}`,
      })
    }
    return out
  }, [rows, active, xKey, yKey])

  const dropped = active
    ? rows.filter((r) => String(r.position) === active).length - points.length
    : 0

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-1">
          {present.map((p) => {
            const on = p === active
            return (
              <button
                key={p}
                onClick={() => setPos(p)}
                className="h-7 rounded-lg border px-2 text-[11px] font-semibold"
                style={{
                  background: on
                    ? 'color-mix(in oklab, var(--accent) 16%, var(--surface))'
                    : 'var(--surface-2)',
                  color: on ? POSITION_MARK[p] : 'var(--faint)',
                  borderColor: on ? 'var(--accent)' : 'var(--border)',
                }}
              >
                {p}
              </button>
            )
          })}
        </span>

        <AxisPicker label="X" value={xKey} onChange={setXKey} />
        <AxisPicker label="Y" value={yKey} onChange={setYKey} />
      </div>

      {!active ? (
        <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
          Pick a position. A scatter compares like with like, and every rate in this app is
          ranked within position because a centre-back&apos;s expected goal involvement against
          a forward&apos;s says nothing — putting all four on one plot would look informative
          and mean less than the table already does.
        </p>
      ) : (
        <Scatter
          points={points}
          x={{
            label: xCol?.full ?? xKey,
            lowerIsBetter: xCol?.direction === 'lower',
            digits: xCol?.format === 'int' ? 0 : 2,
          }}
          y={{
            label: yCol?.full ?? yKey,
            lowerIsBetter: yCol?.direction === 'lower',
            digits: yCol?.format === 'int' ? 0 : 2,
          }}
          colour={POSITION_MARK[active] ?? 'var(--chart-mark)'}
          height={440}
          labelCount={10}
          quadrantNote={`${points.length} ${active}s from the current filters.`}
        />
      )}

      {dropped > 0 && (
        <p className="text-[11px]" style={{ color: 'var(--faint)' }}>
          {dropped} {active}
          {dropped === 1 ? ' is' : 's are'} missing from the plot: no value for one of the two
          metrics. Absent, not zero — a dot at the origin would put them in the worst corner
          for being unmeasured.
        </p>
      )}
    </div>
  )
}

function AxisPicker({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--faint)' }}>
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 rounded-lg border px-1.5 text-[12px]"
        style={{ background: 'var(--surface-2)', borderColor: 'var(--border)', maxWidth: 190 }}
      >
        {PLOTTABLE.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label}
            {c.direction === 'lower' ? ' ↓' : ''}
          </option>
        ))}
      </select>
    </label>
  )
}
