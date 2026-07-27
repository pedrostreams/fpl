'use client'

import { useMemo, useState } from 'react'
import { fmt, fmtInt } from '@/lib/format'
import type { Shot } from '@/lib/queries'

/**
 * Every shot a player took, where he took it from.
 *
 * The one screen in this app that shows habits rather than totals: two forwards on identical
 * xG per 90 can be a poacher and a long-range hopeful, and no column reveals that. Only
 * possible because the enum repair in sync/sources/understat_raw.py restores `body_part` and
 * `situation`, which soccerdata drops for 19.6% of shots.
 *
 * Coordinates are Understat's, normalised 0..1 with the attacking goal at x = 1. Drawn as the
 * attacking third seen from above, goal at the top, because a full pitch would waste four
 * fifths of the frame — 4 223 of 7 752 shots come from inside the box.
 */

// The plot covers x from `crop` to 1. 0.45 by default, which keeps long-range efforts visible
// without squeezing the box where almost everything happens — 4 231 of 7 779 shots are inside
// the penalty area.
//
// Adaptive rather than fixed, because a fixed 0.45 drew a player's own summary as a lie: seven
// shots across the dataset come from further out than that (Cunha from x = 0.30, 73 metres),
// and they fell outside the viewBox while still being counted. "90 shots" above a picture with
// 89 dots is the silent-truncation failure, on a screen whose whole job is showing you where
// the shots were.
const DEFAULT_CROP = 0.45
const W = 68 // metres, pitch width — the SVG viewBox is in metres so the markings are literal

function cropFor(shots: Shot[]): number {
  const min = shots.reduce((m, s) => Math.min(m, s.x), 1)
  return Math.max(0, Math.min(DEFAULT_CROP, min - 0.03))
}

/** Understat (x, y) → SVG (px, py) in metres, goal along the top edge. */
function project(x: number, y: number): [number, number] {
  return [y * W, (1 - x) * 105]
}

type Filter = 'all' | 'goals' | 'head' | 'foot' | 'setpiece' | 'openplay'

const FILTERS: { key: Filter; label: string; test: (s: Shot) => boolean }[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'goals', label: 'Goals', test: (s) => s.isGoal },
  { key: 'openplay', label: 'Open play', test: (s) => s.situation === 'Open Play' },
  {
    key: 'setpiece',
    label: 'Set piece',
    test: (s) => s.situation !== null && s.situation !== 'Open Play',
  },
  { key: 'head', label: 'Head', test: (s) => s.bodyPart === 'Head' },
  { key: 'foot', label: 'Foot', test: (s) => s.bodyPart?.includes('Foot') ?? false },
]

export function ShotMap({
  shots,
  name,
  mapped,
}: {
  shots: Shot[]
  name: string
  /** Whether Understat has a record for this player at all — a different thing from no shots. */
  mapped: boolean
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const [hover, setHover] = useState<Shot | null>(null)

  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0]
  const visible = useMemo(() => shots.filter(active.test), [shots, active])
  // Framed on the full set, not the filtered one, so switching filter does not rescale the
  // pitch under the reader and make two views incomparable.
  const depth = useMemo(() => (1 - cropFor(shots)) * 105, [shots])

  const summary = useMemo(() => {
    const n = visible.length
    const xg = visible.reduce((a, s) => a + (s.xg ?? 0), 0)
    const goals = visible.filter((s) => s.isGoal).length
    const inBox = visible.filter((s) => s.zone !== 'outside_box').length
    const dist = visible.filter((s) => s.distanceM !== null)
    return {
      n,
      xg,
      goals,
      inBox,
      // Mean distance is the number that makes the picture quotable: "his average shot is 11 m
      // out" says more than a scatter plot to anyone skimming.
      meanDist: dist.length ? dist.reduce((a, s) => a + (s.distanceM ?? 0), 0) / dist.length : null,
      perShot: n ? xg / n : null,
    }
  }, [visible])

  if (shots.length === 0) {
    // Two different absences, and conflating them is the mistake DESIGN.md keeps warning
    // about. "We cannot see his shots" and "he took none" look identical on screen and mean
    // opposite things — one is our gap, the other is a fact about the player.
    return (
      <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
        {mapped ? (
          <>
            <strong>No shots taken.</strong> Understat has a record for {name} and it contains
            no attempt at goal — a fact about the player, not a gap in the data. Common for
            goalkeepers and deep midfielders.
          </>
        ) : (
          <>
            <strong>Not measurable.</strong> {name} has no Understat mapping, so his shots
            cannot be located. Mostly promoted-club squads and players whose last season was
            outside the Premier League — Understat only covers the leagues it covers. This is
            our gap, not a player who never shoots.
          </>
        )}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => {
          const n = shots.filter(f.test).length
          const on = f.key === filter
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              disabled={n === 0}
              className="h-7 rounded-lg border px-2 text-[11px] font-medium disabled:opacity-35"
              style={{
                background: on
                  ? 'color-mix(in oklab, var(--accent) 18%, var(--surface))'
                  : 'var(--surface-2)',
                color: on ? 'var(--accent)' : 'var(--muted)',
                borderColor: on ? 'var(--accent)' : 'var(--border)',
              }}
            >
              {f.label}{' '}
              <span className="num" style={{ color: 'var(--faint)' }}>
                {n}
              </span>
            </button>
          )
        })}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <svg
          viewBox={`0 0 ${W} ${depth}`}
          className="w-full max-w-[380px] shrink-0 rounded-lg border"
          style={{ background: 'var(--surface-2)', borderColor: 'var(--border)' }}
          role="img"
          aria-label={`Shot map for ${name}: ${summary.n} shots, ${summary.goals} goals`}
        >
          {/* Pitch markings, in real metres. The penalty area is 16.5 deep by 40.32 wide, the
              six-yard box 5.5 by 18.32, the spot 11 out, the arc 9.15 radius. */}
          <g fill="none" stroke="var(--border)" strokeWidth={0.25}>
            <rect x={0} y={0} width={W} height={depth} />
            <rect x={(W - 40.32) / 2} y={0} width={40.32} height={16.5} />
            <rect x={(W - 18.32) / 2} y={0} width={18.32} height={5.5} />
            <path d={`M ${W / 2 - 9.15} 16.5 A 9.15 9.15 0 0 0 ${W / 2 + 9.15} 16.5`} />
            <line x1={(W - 7.32) / 2} y1={0} x2={(W + 7.32) / 2} y2={0} strokeWidth={0.7} />
          </g>
          <circle cx={W / 2} cy={11} r={0.35} fill="var(--border)" />

          {/* Non-goals first so a goal is never hidden under a miss. */}
          {[...visible].sort((a, b) => Number(a.isGoal) - Number(b.isGoal)).map((s, i) => {
            const [px, py] = project(s.x, s.y)
            // Area scales with xG, so a 0.7 chance looks meaningfully bigger than a 0.05 one
            // without the radius exaggerating it. Floor of 0.5 m keeps a 0.01 shot visible.
            const r = Math.max(0.5, Math.sqrt((s.xg ?? 0.01) / Math.PI) * 4.2)
            return (
              <circle
                key={i}
                cx={px}
                cy={py}
                r={r}
                fill={s.isGoal ? 'var(--accent)' : 'none'}
                stroke={s.isGoal ? 'var(--accent)' : 'var(--muted)'}
                strokeWidth={0.18}
                opacity={s.isGoal ? 0.85 : 0.5}
                onMouseEnter={() => setHover(s)}
                onMouseLeave={() => setHover(null)}
              >
                <title>
                  {`${s.isGoal ? 'Goal' : s.result} · ${fmt(s.xg, 2)} xG · ${fmt(s.distanceM, 0)} m · ${s.bodyPart ?? '—'} · ${s.situation ?? '—'}`}
                </title>
              </circle>
            )
          })}
        </svg>

        <div className="flex flex-col gap-2 text-[12px]">
          <Row label="Shots" value={fmtInt(summary.n)} />
          <Row label="Goals" value={fmtInt(summary.goals)} />
          <Row label="Total xG" value={fmt(summary.xg, 2)} />
          <Row label="xG per shot" value={fmt(summary.perShot, 3)} />
          <Row
            label="Inside the box"
            value={summary.n ? `${Math.round((summary.inBox / summary.n) * 100)}%` : '—'}
          />
          <Row label="Mean distance" value={summary.meanDist === null ? '—' : `${summary.meanDist.toFixed(1)} m`} />
          <p className="mt-1 max-w-[220px] text-[11px]" style={{ color: 'var(--faint)' }}>
            Circle area is xG. Filled means it went in. Hover a shot for the detail —{' '}
            {hover
              ? `${hover.isGoal ? 'goal' : (hover.result ?? 'shot')}, ${fmt(hover.xg, 2)} xG from ${fmt(hover.distanceM, 0)} m`
              : 'the goal is along the top edge.'}
          </p>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6" style={{ minWidth: 170 }}>
      <span style={{ color: 'var(--faint)' }}>{label}</span>
      <span className="num font-semibold">{value}</span>
    </div>
  )
}
