'use client'

import { useMemo, useState } from 'react'
import { PlayerIdentity } from '@/components/player-identity'
import { WatchButton } from '@/components/watch-button'
import { fmt, fmtInt, fmtPct } from '@/lib/format'
import type { CaptainPick } from '@/lib/queries'

/**
 * Floor, ceiling, or both.
 *
 * The single blended score this replaces answered "who is best", which is not the question. The
 * question is "do I want a floor or a ceiling this week" — leading the mini-league you want the
 * safe armband, chasing it you want variance. Two axes put that choice back with the user, and
 * they genuinely disagree: Haaland tops the ceiling on shot volume while an Arsenal player tops
 * the floor on a 91% chance of the team scoring at all.
 */
const LENSES = {
  floor: {
    label: 'Safe',
    hint: 'Highest floor — on the pitch, and the team scores at all',
    of: (c: CaptainPick) => c.floorScore,
    parts: [
      { key: 'minutes' as const, label: 'Minutes' },
      { key: 'teamScores' as const, label: 'Team scores' },
      { key: 'involvement' as const, label: 'Involvement' },
    ],
  },
  ceiling: {
    label: 'Explosive',
    hint: 'Highest ceiling — chance volume and quality, and a two-goal team performance',
    of: (c: CaptainPick) => c.ceilingScore,
    parts: [
      { key: 'bigChances' as const, label: 'Big chances' },
      { key: 'shotsInBox' as const, label: 'Box shots' },
      { key: 'teamScores2' as const, label: '2+ goals' },
      { key: 'npXg' as const, label: 'npxG' },
    ],
  },
  combined: {
    label: 'Both',
    hint: 'Floor and ceiling averaged',
    of: (c: CaptainPick) => c.combinedScore,
    parts: [
      { key: 'minutes' as const, label: 'Minutes' },
      { key: 'teamScores' as const, label: 'Team scores' },
      { key: 'bigChances' as const, label: 'Big chances' },
      { key: 'shotsInBox' as const, label: 'Box shots' },
    ],
  },
} as const

type LensKey = keyof typeof LENSES

/** A percentile rank as a thin bar — four of these read faster than four numbers. */
function RankBar({ value, label }: { value: number | null; label: string }) {
  const p = value ?? 0
  return (
    <span
      className="flex items-center gap-1"
      data-tip={`${label}: ${Math.round(p * 100)}th percentile among captain candidates`}
    >
      <span className="text-[9px] uppercase tracking-wide" style={{ color: 'var(--faint)' }}>
        {label}
      </span>
      <span
        className="h-1 w-8 overflow-hidden rounded-full"
        style={{ background: 'var(--surface-2)' }}
      >
        <span
          className="block h-full rounded-full"
          style={{ width: `${p * 100}%`, background: 'var(--accent)' }}
        />
      </span>
    </span>
  )
}

export function CaptainPanel({
  picks,
  watchedCodes,
}: {
  picks: CaptainPick[]
  watchedCodes: number[]
}) {
  const [lens, setLens] = useState<LensKey>('combined')
  const L = LENSES[lens]
  const watched = useMemo(() => new Set(watchedCodes), [watchedCodes])

  const ranked = useMemo(
    () =>
      [...picks]
        .sort((a, b) => {
          const x = L.of(a)
          const y = L.of(b)
          if (x === null) return 1
          if (y === null) return -1
          return y - x
        })
        .slice(0, 6),
    [picks, L],
  )

  const top = ranked[0]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {(Object.keys(LENSES) as LensKey[]).map((k) => {
            const on = k === lens
            return (
              <button
                key={k}
                onClick={() => setLens(k)}
                data-tip={LENSES[k].hint}
                className="h-7 rounded-lg border px-2.5 text-[11px] font-medium transition-colors"
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
          {L.hint}
        </span>
      </div>

      {top && (
        <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
          <strong>{top.webName}</strong>
          {lens === 'floor' && ' is the safest armband'}
          {lens === 'ceiling' && ' has the highest ceiling'}
          {lens === 'combined' && ' balances floor and ceiling best'}
          {' — '}
          {top.isHome ? 'home to' : 'away at'} {top.opponentName},{' '}
          {fmtPct((top.pTeamScores ?? 0) * 100, 0)} the team scores and{' '}
          {fmtPct((top.pTeamScores2Plus ?? 0) * 100, 0)} they score twice.
        </p>
      )}

      <div className="flex flex-col gap-2.5">
        {ranked.map((c, i) => (
          <PlayerIdentity
            key={c.playerCode}
            playerCode={c.playerCode}
            name={c.webName}
            position={c.position}
            teamCode={c.teamCode}
            teamShort={c.teamShort}
            opponent={{ short: c.opponentShort, isHome: c.isHome }}
            chips={
              <>
                {c.penaltiesOrder === 1 && (
                  <span
                    className="rounded px-1 text-[9px] font-bold"
                    style={{
                      background: 'color-mix(in oklab, var(--accent) 22%, transparent)',
                      color: 'var(--accent)',
                    }}
                    data-tip="First-choice penalty taker — a real ceiling spike"
                  >
                    P1
                  </span>
                )}
                {!c.hasShotData && (
                  <span
                    className="rounded px-1 text-[9px] font-semibold uppercase"
                    style={{ background: 'var(--surface-2)', color: 'var(--faint)' }}
                    data-tip="No Understat mapping, so shot volume and chance quality are unknown — ranked on the rest"
                  >
                    no shots
                  </span>
                )}
              </>
            }
            /* The raw availability figure, in words, above the rank bars. A percentile is not
               enough here: the previous version scored a player on 17% of a season the same as
               one on 86%, and nothing on screen would have shown you. */
            sub={
              <>
                played{' '}
                <strong style={{ color: 'var(--muted)' }}>
                  {fmtPct((c.minutesShare ?? 0) * 100, 0)}
                </strong>{' '}
                of last season ({fmtInt(c.minutes)} min) · xGI {fmt(c.xgiPer90, 2)}
                {c.chanceOfPlaying !== null && c.chanceOfPlaying < 100 && (
                  <span style={{ color: 'var(--warn)' }}> · {c.chanceOfPlaying}% to play</span>
                )}
                <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  {L.parts.map((p) => (
                    <RankBar key={p.key} value={c.ranks[p.key]} label={p.label} />
                  ))}
                </span>
              </>
            }
            right={
              <span
                className="num rounded px-1.5 py-0.5 text-[12px] font-bold"
                style={{
                  background:
                    i === 0 ? 'color-mix(in oklab, var(--accent) 20%, transparent)' : 'transparent',
                  color: i === 0 ? 'var(--accent)' : 'var(--muted)',
                }}
                data-tip={`${L.label}: mean of the percentile ranks shown`}
              >
                {fmt(L.of(c), 3)}
              </span>
            }
            action={<WatchButton playerCode={c.playerCode} watched={watched.has(c.playerCode)} />}
          />
        ))}
      </div>

      <p className="text-[11px]" style={{ color: 'var(--faint)' }}>
        {/* Not `picks.length` — that is the display limit, not the pool. The ranks are computed
            in SQL across every candidate, and quoting 30 here understated it by an order of
            magnitude. */}
        Every candidate is fit right now <em>and</em> played at least half of last season — a
        hard gate, not a factor to be outweighed by a kind fixture, because &ldquo;will he
        play&rdquo; is a precondition for an armband. Ranks are percentiles across that pool,
        averaged, not raw values multiplied, which would let whichever metric has the widest
        spread dominate. Deliberately <em>not</em> called expected points: there is no minutes model or
        bonus model behind it, so every component is on screen. Big chances are shots of xG ≥
        0.3; <strong>npxG</strong> excludes penalties, which is only possible because the
        penalty label had to be repaired first.
      </p>
    </div>
  )
}
