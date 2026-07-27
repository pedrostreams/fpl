'use client'

import { useMemo, useState } from 'react'
import { Scatter } from '@/components/scatter'
import type { Point } from '@/components/scatter'

/**
 * Twenty clubs, two measures, four quadrants.
 *
 * The default is the plot everyone means by "the xG chart": what a side creates against what
 * it concedes. Top right is a good team, bottom left a bad one, and the two off-diagonals are
 * the interesting ones — all-out attack, and dour but solid.
 *
 * Only clubs with a top-flight record can appear. The three promoted sides have no Understat
 * season, and plotting them at the origin would put them in the "worst team in the league"
 * corner on the strength of having no data at all.
 */

export type TeamPoint = {
  teamCode: number
  shortName: string
  name: string
  xgPerMatch: number | null
  xgaPerMatch: number | null
  ppda: number | null
  deepCompletions: number | null
  cornerXg: number | null
  points: number | null
  cleanSheetPct: number | null
}

type AxisKey = keyof Omit<TeamPoint, 'teamCode' | 'shortName' | 'name'>

const AXES: Record<AxisKey, { label: string; lowerIsBetter?: boolean; digits: number }> = {
  xgPerMatch: { label: 'Expected goals per match', digits: 2 },
  xgaPerMatch: { label: 'Expected goals conceded per match', lowerIsBetter: true, digits: 2 },
  ppda: { label: 'PPDA — passes allowed per defensive action', digits: 1 },
  deepCompletions: { label: 'Deep completions per match', digits: 1 },
  cornerXg: { label: 'Expected goals from corners', digits: 1 },
  points: { label: 'Points', digits: 0 },
  cleanSheetPct: { label: 'Clean sheet %', digits: 0 },
}

const PAIRS: { key: string; label: string; x: AxisKey; y: AxisKey; note: string }[] = [
  {
    key: 'attack-defence',
    label: 'Attack v defence',
    x: 'xgPerMatch',
    y: 'xgaPerMatch',
    note: 'Top right creates a lot and concedes little.',
  },
  {
    key: 'press',
    label: 'Press v territory',
    x: 'ppda',
    y: 'deepCompletions',
    note: 'PPDA is not shaded elsewhere because pressing is a style, not a virtue — here it is an axis, so read it as description rather than quality.',
  },
  {
    key: 'setpieces',
    label: 'Set pieces v open play',
    x: 'cornerXg',
    y: 'xgPerMatch',
    note: 'Right-hand side is where a defender is worth owning for his attacking returns.',
  },
  {
    key: 'luck',
    label: 'Points v underlying',
    x: 'xgPerMatch',
    y: 'points',
    note: 'Above the trend is a side outscoring its chances; below it, one due a correction.',
  },
]

export function TeamScatter({ teams }: { teams: TeamPoint[] }) {
  const [pair, setPair] = useState(PAIRS[0])

  const points = useMemo<Point[]>(() => {
    const out: Point[] = []
    for (const t of teams) {
      const xv = t[pair.x]
      const yv = t[pair.y]
      // A promoted club has null on every style measure. Skipping is the point — see the note
      // rendered below the chart.
      if (xv === null || yv === null) continue
      out.push({
        id: t.teamCode,
        label: t.shortName,
        x: xv,
        y: yv,
        detail: t.name,
        href: `/team/${t.teamCode}`,
      })
    }
    return out
  }, [teams, pair])

  const missing = teams.length - points.length

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {PAIRS.map((p) => {
          const on = p.key === pair.key
          return (
            <button
              key={p.key}
              onClick={() => setPair(p)}
              className="h-7 rounded-lg border px-2.5 text-[11px] font-medium"
              style={{
                background: on
                  ? 'color-mix(in oklab, var(--accent) 18%, var(--surface))'
                  : 'var(--surface-2)',
                color: on ? 'var(--accent)' : 'var(--muted)',
                borderColor: on ? 'var(--accent)' : 'var(--border)',
              }}
            >
              {p.label}
            </button>
          )
        })}
      </div>

      <Scatter
        points={points}
        x={AXES[pair.x]}
        y={AXES[pair.y]}
        height={400}
        labelCount={20}
        quadrantNote={pair.note}
      />

      {missing > 0 && (
        <p className="text-[11px]" style={{ color: 'var(--faint)' }}>
          {missing} promoted {missing === 1 ? 'club is' : 'clubs are'} absent: no top-flight
          record to plot. Drawing them at zero would put them in the worst corner for having no
          data, which is a different thing from being bad.
        </p>
      )}
    </div>
  )
}
