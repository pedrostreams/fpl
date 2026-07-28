'use client'

import { useMemo, useState } from 'react'
import { PlayerIdentity } from '@/components/player-identity'
import type { MovementRow } from '@/lib/queries'
import { fmt, fmtInt, fmtPct, fmtPrice, fmtSigned } from '@/lib/format'

/**
 * Sorting keys. Each names the column it sorts and whether the interesting end is the top or
 * the bottom, so "biggest faller" is a first-class view rather than something the user has to
 * reach by clicking a header twice.
 */
const SORTS = {
  owned: { label: 'Most owned', of: (r: MovementRow) => r.selectedByPercent, desc: true },
  transfersIn: {
    label: 'Most transferred in',
    of: (r: MovementRow) => r.netTransfersEvent,
    desc: true,
  },
  transfersOut: {
    label: 'Most transferred out',
    of: (r: MovementRow) => r.netTransfersEvent,
    desc: false,
  },
  rising: {
    label: 'Rising ownership',
    of: (r: MovementRow) => r.ownershipDelta24h,
    desc: true,
  },
  falling: {
    label: 'Falling ownership',
    of: (r: MovementRow) => r.ownershipDelta24h,
    desc: false,
  },
  fplWatch: {
    label: "FPL's own signal",
    of: (r: MovementRow) => r.priceChangePercent,
    desc: true,
  },
} as const

type SortKey = keyof typeof SORTS

/** A signed number that colours by direction. Null renders as an em dash, never as zero. */
function Delta({
  value,
  known,
  digits = 2,
  suffix = '',
  invert = false,
}: {
  value: number | null
  known?: boolean
  digits?: number
  suffix?: string
  invert?: boolean
}) {
  if (known === false) {
    return (
      <span className="num text-[12px]" style={{ color: 'var(--faint)' }} data-tip="Not enough history yet — the snapshot series does not reach back this far">
        ·
      </span>
    )
  }
  if (value === null) {
    return (
      <span className="num text-[12px]" style={{ color: 'var(--faint)' }}>
        —
      </span>
    )
  }
  const good = invert ? value < 0 : value > 0
  const bad = invert ? value > 0 : value < 0
  return (
    <span
      className="num text-[12px]"
      style={{ color: good ? 'var(--ok)' : bad ? 'var(--danger)' : 'var(--faint)' }}
    >
      {value === 0 ? '0' : fmtSigned(value, digits)}
      {suffix}
    </span>
  )
}

export function MovementTable({ rows, covers24h }: { rows: MovementRow[]; covers24h: boolean }) {
  // Default to ownership: during a frozen preseason it is the only column with real spread,
  // so opening on a transfer sort would show an all-zero table and read as broken.
  const [sort, setSort] = useState<SortKey>(covers24h ? 'transfersIn' : 'owned')
  const [search, setSearch] = useState('')
  const [maxOwnership, setMaxOwnership] = useState(100)

  const sorted = useMemo(() => {
    const S = SORTS[sort]
    const q = search.trim().toLowerCase()
    return rows
      .filter((r) => (!q || r.webName.toLowerCase().includes(q)))
      .filter((r) => (r.selectedByPercent ?? 0) <= maxOwnership)
      .slice()
      .sort((a, b) => {
        const x = S.of(a)
        const y = S.of(b)
        // Missing values last in both directions, same rule as the scout table.
        if (x === null || x === undefined) return 1
        if (y === null || y === undefined) return -1
        return S.desc ? y - x : x - y
      })
      .slice(0, 60)
  }, [rows, sort, search, maxOwnership])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span
            className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--faint)' }}
          >
            Show
          </span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="h-9 rounded-lg border px-2 text-[13px] outline-none focus:border-[var(--accent)]"
            style={{ background: 'var(--surface)', color: 'var(--text)' }}
          >
            {(Object.keys(SORTS) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORTS[k].label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span
            className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--faint)' }}
          >
            Search
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Player name"
            className="h-9 w-44 rounded-lg border px-3 text-[13px] outline-none focus:border-[var(--accent)]"
            style={{ background: 'var(--surface)' }}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span
            className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--faint)' }}
          >
            Max owned · {maxOwnership}%
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={maxOwnership}
            onChange={(e) => setMaxOwnership(Number(e.target.value))}
            className="h-9 w-32 accent-[var(--accent)]"
          />
        </label>
      </div>

      <div
        className="scroll-thin overflow-auto rounded-xl border"
        style={{ background: 'var(--surface)' }}
      >
        <table className="w-full border-separate border-spacing-0 text-left">
          <thead>
            <tr>
              {[
                ['Player', 'left', ''],
                ['Price', 'right', 'Current price'],
                ['Owned', 'right', 'Share of all squads containing this player'],
                ['Δ owned 24h', 'right', 'Change in ownership over the last 24 hours'],
                ['Net GW', 'right', 'Net transfers this gameweek: in minus out. Zero for everyone until the GW1 deadline.'],
                ['Net 24h', 'right', 'Net transfers over the last 24 hours, differenced from our own cumulative series. No FPL endpoint exposes this.'],
                ['FPL %', 'right', "FPL's own price-change signal, new for 2026/27. Treated as an input, not an answer."],
                ['Δ£ start', 'right', 'Price change since the season started'],
                ['Form', 'right', ''],
                ['Pts', 'right', ''],
              ].map(([label, align, tip]) => (
                <th
                  key={label}
                  data-tip={tip || undefined}
                  className={`sticky top-0 z-10 border-b px-2 py-2 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap text-${align}`}
                  style={{ background: 'var(--surface-2)', color: 'var(--muted)' }}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.playerCode}>
                <td className="border-b px-3 py-1.5 whitespace-nowrap">
                  {/* The shared identity block. This screen had no photo, no crest and no way
                      through to a profile — a price move is exactly the moment you want to look
                      at the player. `status` here carries `chanceOfPlaying` too, which the
                      component's dot cannot express, so the news tooltip keeps both. */}
                  <PlayerIdentity
                    playerCode={r.playerCode}
                    name={r.webName}
                    position={r.position ?? ''}
                    teamCode={r.teamCode}
                    teamShort={r.teamShort}
                    status={r.status}
                    news={
                      r.chanceOfPlaying !== null && r.chanceOfPlaying < 100
                        ? `${r.chanceOfPlaying}% to play${r.news ? ` — ${r.news}` : ''}`
                        : r.news
                    }
                    size={26}
                    wrap={false}
                  />
                </td>
                <td className="border-b px-2 py-1.5 text-right">
                  <span className="num text-[12px]">{fmtPrice(r.price)}</span>
                </td>
                <td className="border-b px-2 py-1.5 text-right">
                  <span className="num text-[12px]">{fmtPct(r.selectedByPercent)}</span>
                </td>
                <td className="border-b px-2 py-1.5 text-right">
                  <Delta value={r.ownershipDelta24h} known={r.has24hHistory} digits={2} suffix="%" />
                </td>
                <td className="border-b px-2 py-1.5 text-right">
                  <Delta value={r.netTransfersEvent} digits={0} />
                </td>
                <td className="border-b px-2 py-1.5 text-right">
                  <Delta value={r.netTransfers24h} known={r.has24hHistory} digits={0} />
                </td>
                <td className="border-b px-2 py-1.5 text-right">
                  <span className="num text-[12px]" style={{ color: 'var(--muted)' }}>
                    {fmt(r.priceChangePercent, 1)}
                  </span>
                </td>
                <td className="border-b px-2 py-1.5 text-right">
                  <Delta value={r.costChangeStart === null ? null : r.costChangeStart / 10} digits={1} />
                </td>
                <td className="border-b px-2 py-1.5 text-right">
                  <span className="num text-[12px]" style={{ color: 'var(--muted)' }}>
                    {fmt(r.form, 1)}
                  </span>
                </td>
                <td className="border-b px-2 py-1.5 text-right">
                  <span className="num text-[12px]">{fmtInt(r.totalPoints)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sorted.length === 0 && (
          <div className="px-4 py-12 text-center text-[13px]" style={{ color: 'var(--muted)' }}>
            No players match.
          </div>
        )}
      </div>

      <div
        className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px]"
        style={{ color: 'var(--faint)' }}
      >
        <span>Top 60 of {rows.length} by the selected order.</span>
        <span>
          <strong style={{ color: 'var(--muted)' }}>·</strong> means the snapshot series does not
          reach back that far yet — not that the value is zero.
        </span>
        <span>
          <strong style={{ color: 'var(--muted)' }}>Net 24h</strong> exists only because we
          capture hourly; the FPL API has no history endpoint.
        </span>
      </div>
    </div>
  )
}
