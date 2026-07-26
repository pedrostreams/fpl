'use client'

import { useMemo, useState } from 'react'
import type { Ticker, TickerFixture, TickerTeam } from '@/lib/queries'
import { fmt } from '@/lib/format'

/**
 * Three lenses over the same fixtures. A striker's easy fixture and a centre-back's easy
 * fixture are different fixtures, and collapsing them into one number is precisely what
 * FPL's integer FDR does wrong — so the lens changes the colour AND the summary metric,
 * rather than adding three more columns nobody reads.
 */
const LENSES = {
  overall: {
    label: 'Overall',
    hint: 'Chance of winning',
    of: (f: TickerFixture) => f.difficulty,
    summary: (t: TickerTeam) => t.run.avgDifficulty,
    metric: (t: TickerTeam) => t.run.expectedWins,
    metricLabel: 'xWins',
    metricDigits: 2,
    metricHint:
      'Expected wins across the run — the sum of win probabilities, so a double gameweek counts twice',
  },
  attack: {
    label: 'Attack',
    hint: 'How hard it is to score',
    of: (f: TickerFixture) => f.attackDifficulty,
    summary: (t: TickerTeam) => t.run.avgAttackDifficulty,
    metric: (t: TickerTeam) => t.run.expectedGoalsFor,
    metricLabel: 'xG',
    metricDigits: 1,
    metricHint: 'Expected goals for, summed across the run',
  },
  defence: {
    label: 'Defence',
    hint: 'How hard it is to keep a clean sheet',
    of: (f: TickerFixture) => f.defenceDifficulty,
    summary: (t: TickerTeam) => t.run.avgDefenceDifficulty,
    metric: (t: TickerTeam) => t.run.expectedCleanSheets,
    metricLabel: 'xCS',
    metricDigits: 2,
    metricHint: 'Expected clean sheets, summed across the run',
  },
} as const

type LensKey = keyof typeof LENSES

function tooltip(f: TickerFixture): string {
  const venue = f.isHome ? 'home' : 'away'
  return [
    `GW${f.gameweek} ${venue} v ${f.opponentName}`,
    `win ${Math.round((f.pWin ?? 0) * 100)}%`,
    `xG ${fmt(f.expectedGoalsFor, 2)} / xGA ${fmt(f.expectedGoalsAgainst, 2)}`,
    `clean sheet ${Math.round((f.pCleanSheet ?? 0) * 100)}%`,
    f.fplDifficulty !== null ? `FPL rates this ${f.fplDifficulty}/5` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

function Cell({ fixtures, lens }: { fixtures: TickerFixture[]; lens: LensKey }) {
  // A blank gameweek. Hatched, not shaded: no fixture is not the same as an easy fixture,
  // and for a manager it is the worst outcome on the row.
  if (fixtures.length === 0) {
    return (
      <div className="heat-null flex h-full min-h-[30px] items-center justify-center">
        <span
          className="text-[10px] font-semibold uppercase"
          style={{ color: 'var(--faint)' }}
        >
          blank
        </span>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-px">
      {fixtures.map((f, i) => {
        const d = LENSES[lens].of(f)
        // Invert: colour means better, so an easy fixture is the strong shade.
        const p = d === null ? null : 1 - d
        return (
          <div
            key={i}
            className={p === null ? 'heat-null' : 'heat'}
            style={p === null ? undefined : { ['--p' as string]: p }}
            title={tooltip(f)}
          >
            <div className="flex min-h-[30px] items-center justify-center gap-1 px-1">
              {/* Uppercase for home, lowercase for away — the ticker convention every FPL
                  site uses, and it saves a column. */}
              <span className="text-[11px] font-semibold tracking-tight">
                {f.isHome ? f.opponentShort.toUpperCase() : f.opponentShort.toLowerCase()}
              </span>
              <span className="text-[9px]" style={{ color: 'var(--faint)' }}>
                {f.isHome ? 'H' : 'A'}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function FixtureTicker({ ticker }: { ticker: Ticker }) {
  const [lens, setLens] = useState<LensKey>('overall')
  const L = LENSES[lens]

  const teams = useMemo(
    () =>
      [...ticker.teams].sort((a, b) => {
        const x = L.summary(a)
        const y = L.summary(b)
        if (x === null) return 1
        if (y === null) return -1
        return x - y // easiest run first
      }),
    [ticker.teams, L],
  )

  const doubles = teams.flatMap((t) =>
    ticker.gameweeks
      .filter((gw) => (t.byGameweek[gw]?.length ?? 0) > 1)
      .map((gw) => ({ t, gw })),
  )
  const blanks = teams.flatMap((t) =>
    ticker.gameweeks
      .filter((gw) => (t.byGameweek[gw]?.length ?? 0) === 0)
      .map((gw) => ({ t, gw })),
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          {(Object.keys(LENSES) as LensKey[]).map((k) => {
            const on = k === lens
            return (
              <button
                key={k}
                onClick={() => setLens(k)}
                title={LENSES[k].hint}
                className="h-8 rounded-lg border px-3 text-[12px] font-medium transition-colors"
                style={{
                  background: on
                    ? 'color-mix(in oklab, var(--accent) 18%, var(--surface))'
                    : 'var(--surface)',
                  color: on ? 'var(--accent)' : 'var(--muted)',
                  borderColor: on ? 'var(--accent)' : 'var(--border)',
                }}
              >
                {LENSES[k].label}
              </button>
            )
          })}
        </div>
        <span className="text-[11px]" style={{ color: 'var(--faint)' }}>
          {L.hint} · easiest run first
        </span>
      </div>

      {(doubles.length > 0 || blanks.length > 0) && (
        <div className="text-[12px]" style={{ color: 'var(--muted)' }}>
          {doubles.length > 0 && (
            <span>
              Double gameweek:{' '}
              <strong>
                {doubles.map((d) => `${d.t.shortName} GW${d.gw}`).join(', ')}
              </strong>
              .{' '}
            </span>
          )}
          {blanks.length > 0 && (
            <span>
              Blank:{' '}
              <strong>
                {blanks.map((b) => `${b.t.shortName} GW${b.gw}`).join(', ')}
              </strong>
              .
            </span>
          )}
        </div>
      )}

      <div
        className="scroll-thin overflow-auto rounded-xl border"
        style={{ background: 'var(--surface)' }}
      >
        <table className="w-full border-separate border-spacing-0 text-left">
          <thead>
            <tr>
              <th
                className="sticky left-0 top-0 z-30 border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-wide"
                style={{
                  background: 'var(--surface-2)',
                  color: 'var(--muted)',
                }}
              >
                Team
              </th>
              <th
                className="sticky top-0 z-20 border-b px-2 py-2 text-right text-[11px] font-semibold uppercase tracking-wide"
                style={{
                  background: 'var(--surface-2)',
                  color: 'var(--muted)',
                }}
                title={`Mean ${L.label.toLowerCase()} difficulty over the run — 0 easiest, 1 hardest`}
              >
                Run
              </th>
              <th
                className="sticky top-0 z-20 border-b px-2 py-2 text-right text-[11px] font-semibold uppercase tracking-wide"
                style={{
                  background: 'var(--surface-2)',
                  color: 'var(--muted)',
                }}
                title={L.metricHint}
              >
                {L.metricLabel}
              </th>
              {ticker.gameweeks.map((gw) => (
                <th
                  key={gw}
                  className="sticky top-0 z-20 border-b px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wide"
                  style={{
                    background: 'var(--surface-2)',
                    color: 'var(--muted)',
                  }}
                >
                  GW{gw}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => {
              const s = L.summary(t)
              return (
                <tr key={t.teamCode}>
                  <td
                    className="sticky left-0 z-10 border-b px-3 py-1 whitespace-nowrap"
                    style={{ background: 'var(--surface)' }}
                  >
                    <span className="text-[13px] font-medium">{t.shortName}</span>
                    <span
                      className="ml-2 num text-[10px]"
                      style={{ color: 'var(--faint)' }}
                    >
                      {t.elo === null ? '' : Math.round(t.elo)}
                    </span>
                  </td>
                  <td className="border-b p-1">
                    <div
                      className={s === null ? 'heat-null rounded' : 'heat rounded'}
                      style={s === null ? undefined : { ['--p' as string]: 1 - s }}
                      title={`Mean ${L.label.toLowerCase()} difficulty ${fmt(s, 3)} over ${t.run.fixtures} fixtures`}
                    >
                      <span className="num block px-2 py-1 text-right">{fmt(s, 3)}</span>
                    </div>
                  </td>
                  <td className="border-b px-2 py-1 text-right">
                    <span className="num text-[12px]">
                      {fmt(L.metric(t), L.metricDigits)}
                    </span>
                  </td>
                  {ticker.gameweeks.map((gw) => (
                    <td key={gw} className="border-b p-px align-middle">
                      <Cell fixtures={t.byGameweek[gw] ?? []} lens={lens} />
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div
        className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px]"
        style={{ color: 'var(--faint)' }}
      >
        <span className="flex items-center gap-1.5">
          Fixture difficulty
          <span className="flex overflow-hidden rounded" aria-hidden>
            {[0, 0.25, 0.5, 0.75, 1].map((p) => (
              <span key={p} className="heat h-3 w-6" style={{ ['--p' as string]: p }} />
            ))}
          </span>
          <span>hard → easy</span>
        </span>
        <span>
          <strong style={{ color: 'var(--muted)' }}>ARS</strong> home ·{' '}
          <strong style={{ color: 'var(--muted)' }}>ars</strong> away
        </span>
        <span>The number beside each club is its current Elo rating.</span>
      </div>
    </div>
  )
}
