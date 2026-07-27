'use client'

import { useMemo, useRef, useState } from 'react'
import { fmt } from '@/lib/format'

/**
 * Two measures, one dot per entity.
 *
 * The form for "how do these two things relate, and who is unusual" — which is the question
 * a four-quadrant xG/xGA plot answers instantly and no table does.
 *
 * ONE SERIES, ALWAYS. A scatter is an all-pairs form, so the categorical cap is three, and
 * red-against-green fails colourblind separation outright (ΔE 2.5 under deuteranopia). More
 * to the point, mixing positions would break the rule the rest of the app is built on: a
 * centre-back is never compared to a forward. Callers pass one hue and the chart never
 * invents a second, so there is no legend to get wrong.
 *
 * BETTER IS ALWAYS UP AND RIGHT. When an axis measures something where low is good — expected
 * goals conceded, ownership — the axis is reversed and the label says so. That is the same
 * contract as the heatmap's "colour means better, never bigger", and without it the reader has
 * to remember which corner is which on every chart separately.
 */

export type Point = {
  id: string | number
  label: string
  x: number
  y: number
  /** Extra lines for the tooltip. */
  detail?: string
  href?: string
}

export type Axis = {
  label: string
  /** True when a smaller number is the better outcome; the axis is reversed to suit. */
  lowerIsBetter?: boolean
  digits?: number
}

const PAD = { top: 16, right: 18, bottom: 44, left: 52 }

function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min]
  const raw = (max - min) / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag
  const out: number[] = []
  for (let t = Math.ceil(min / step) * step; t <= max + step / 1000; t += step) out.push(t)
  return out
}

export function Scatter({
  points,
  x,
  y,
  colour = 'var(--chart-mark)',
  height = 420,
  labelCount = 8,
  quadrantNote,
}: {
  points: Point[]
  x: Axis
  y: Axis
  colour?: string
  height?: number
  /** How many dots carry a permanent label. Never all of them — see marks-and-anatomy. */
  labelCount?: number
  quadrantNote?: string
}) {
  const [hover, setHover] = useState<Point | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const W = 760
  const H = height

  const { sx, sy, xt, yt, xMean, yMean, labelled } = useMemo(() => {
    const xs = points.map((p) => p.x)
    const ys = points.map((p) => p.y)
    const pad = (a: number[]) => {
      const lo = Math.min(...a)
      const hi = Math.max(...a)
      const m = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1
      return [lo - m, hi + m] as const
    }
    const [x0, x1] = pad(xs)
    const [y0, y1] = pad(ys)

    // Reversal happens in the scale, once, so nothing downstream has to know.
    const sx = (v: number) => {
      const t = (v - x0) / (x1 - x0)
      const u = x.lowerIsBetter ? 1 - t : t
      return PAD.left + u * (W - PAD.left - PAD.right)
    }
    const sy = (v: number) => {
      const t = (v - y0) / (y1 - y0)
      const u = y.lowerIsBetter ? t : 1 - t
      return PAD.top + u * (H - PAD.top - PAD.bottom)
    }

    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length

    // Label the outliers, not everything. Distance from the centroid in units of each axis'
    // own spread, so a wide x-range does not swamp a narrow y-range.
    const mx = mean(xs)
    const my = mean(ys)
    const rx = Math.max(...xs) - Math.min(...xs) || 1
    const ry = Math.max(...ys) - Math.min(...ys) || 1
    const ranked = [...points].sort(
      (a, b) =>
        ((b.x - mx) / rx) ** 2 + ((b.y - my) / ry) ** 2 -
        (((a.x - mx) / rx) ** 2 + ((a.y - my) / ry) ** 2),
    )
    // Greedy de-collision: skip a label that would land on one already placed.
    const placed: { x: number; y: number }[] = []
    const labelled = new Set<string | number>()
    for (const p of ranked) {
      if (labelled.size >= labelCount) break
      const px = sx(p.x)
      const py = sy(p.y)
      if (placed.some((q) => Math.abs(q.x - px) < 46 && Math.abs(q.y - py) < 13)) continue
      placed.push({ x: px, y: py })
      labelled.add(p.id)
    }

    return {
      sx, sy,
      xt: niceTicks(x0, x1),
      yt: niceTicks(y0, y1),
      xMean: mx, yMean: my, labelled,
    }
  }, [points, x, y, H, labelCount])

  if (points.length < 3) {
    return (
      <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
        Not enough points to plot — narrow the filters less.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2" ref={wrap}>
      <div className="relative overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          style={{ minWidth: 440 }}
          role="img"
          aria-label={`${y.label} against ${x.label}, ${points.length} points`}
        >
          {/* Grid, recessive. */}
          <g stroke="var(--border)" strokeWidth={1} opacity={0.5}>
            {xt.map((t) => (
              <line key={`gx${t}`} x1={sx(t)} y1={PAD.top} x2={sx(t)} y2={H - PAD.bottom} />
            ))}
            {yt.map((t) => (
              <line key={`gy${t}`} x1={PAD.left} y1={sy(t)} x2={W - PAD.right} y2={sy(t)} />
            ))}
          </g>

          {/* Mean lines split the plot into the four quadrants people actually read it for. */}
          <g stroke="var(--muted)" strokeWidth={1} strokeDasharray="3 4" opacity={0.55}>
            <line x1={sx(xMean)} y1={PAD.top} x2={sx(xMean)} y2={H - PAD.bottom} />
            <line x1={PAD.left} y1={sy(yMean)} x2={W - PAD.right} y2={sy(yMean)} />
          </g>
          <text
            x={W - PAD.right - 4}
            y={PAD.top + 12}
            textAnchor="end"
            fontSize={10}
            fill="var(--faint)"
          >
            better on both →
          </text>

          {/* Ticks. */}
          <g fontSize={10} fill="var(--faint)">
            {xt.map((t) => (
              <text key={`tx${t}`} x={sx(t)} y={H - PAD.bottom + 14} textAnchor="middle">
                {fmt(t, x.digits ?? 2)}
              </text>
            ))}
            {yt.map((t) => (
              <text key={`ty${t}`} x={PAD.left - 6} y={sy(t) + 3} textAnchor="end">
                {fmt(t, y.digits ?? 2)}
              </text>
            ))}
          </g>

          {/* Axis titles, carrying the reversal so nobody has to infer it. */}
          <text x={(W + PAD.left) / 2} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">
            {x.label}
            {x.lowerIsBetter && ' — reversed, better is right'}
          </text>
          <text
            transform={`rotate(-90 12 ${(H - PAD.bottom + PAD.top) / 2})`}
            x={12}
            y={(H - PAD.bottom + PAD.top) / 2}
            textAnchor="middle"
            fontSize={11}
            fill="var(--muted)"
          >
            {y.label}
            {y.lowerIsBetter && ' — reversed, better is up'}
          </text>

          {/* Marks. A 2px surface ring keeps overlapping dots readable. */}
          {points.map((p) => {
            const on = hover?.id === p.id
            return (
              <circle
                key={p.id}
                cx={sx(p.x)}
                cy={sy(p.y)}
                r={on ? 7 : 5}
                fill={colour}
                stroke="var(--surface)"
                strokeWidth={2}
                opacity={hover && !on ? 0.35 : 0.9}
                pointerEvents="none"
              />
            )
          })}

          {/* Hit targets, drawn last so they sit above every mark.
              A 10px dot you have to land on dead centre is the documented scatter failure —
              the target has to be ~24px regardless of how small the mark is. Invisible, r=13,
              and focusable so a keyboard gets exactly what the mouse gets. The table view is
              still the complete alternative: a tooltip must never be the only way to a value. */}
          {points.map((p) => (
            <circle
              key={`hit${p.id}`}
              cx={sx(p.x)}
              cy={sy(p.y)}
              r={13}
              fill="transparent"
              tabIndex={0}
              role={p.href ? 'link' : 'img'}
              style={{ cursor: p.href ? 'pointer' : 'default', outline: 'none' }}
              onMouseEnter={() => setHover(p)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(p)}
              onBlur={() => setHover(null)}
              onClick={() => p.href && (window.location.href = p.href)}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && p.href) {
                  e.preventDefault()
                  window.location.href = p.href
                }
              }}
            >
              <title>
                {`${p.label} — ${x.label} ${fmt(p.x, x.digits ?? 2)}, ${y.label} ${fmt(p.y, y.digits ?? 2)}${p.detail ? ` · ${p.detail}` : ''}`}
              </title>
            </circle>
          ))}

          {/* Focus ring, drawn only for the active point so the keyboard path is visible. */}
          {hover && (
            <circle
              cx={sx(hover.x)}
              cy={sy(hover.y)}
              r={11}
              fill="none"
              stroke={colour}
              strokeWidth={1.5}
              opacity={0.6}
              pointerEvents="none"
            />
          )}

          {/* Selective direct labels: the outliers, plus whatever is hovered. */}
          <g fontSize={10} fill="var(--text)">
            {points
              .filter((p) => labelled.has(p.id) || hover?.id === p.id)
              .map((p) => (
                <text
                  key={`l${p.id}`}
                  x={sx(p.x) + 8}
                  y={sy(p.y) + 3.5}
                  style={{ paintOrder: 'stroke' }}
                  stroke="var(--surface)"
                  strokeWidth={3}
                  strokeLinejoin="round"
                >
                  {p.label}
                </text>
              ))}
          </g>
        </svg>
      </div>

      <p className="text-[11px]" style={{ color: 'var(--faint)' }}>
        {quadrantNote ? `${quadrantNote} ` : ''}
        Dashed lines are the mean of each axis. {labelled.size} outliers are labelled; hover any
        dot for the rest.
        {hover && (
          <>
            {' '}
            <strong style={{ color: 'var(--muted)' }}>{hover.label}</strong> — {x.label}{' '}
            {fmt(hover.x, x.digits ?? 2)}, {y.label} {fmt(hover.y, y.digits ?? 2)}
            {hover.detail && ` · ${hover.detail}`}
          </>
        )}
      </p>
    </div>
  )
}
