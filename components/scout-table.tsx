'use client'

import {
  type ColumnDef,
  type SortingFn,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import type { ScoutRow } from '@/lib/queries'
import {
  POSITION_VAR,
  STATUS_LABEL,
  fmt,
  fmtInt,
  fmtPct,
  fmtPrice,
  fmtSigned,
  statusColour,
} from '@/lib/format'

type PctKey = keyof ScoutRow['pct']

/**
 * Missing values always sort last, in both directions.
 *
 * TanStack's default treats null as a value and interleaves it, which puts players with no
 * data above real ones when sorting ascending. On a screen whose whole point is finding the
 * best rate, a blank row appearing "best" is a bug the user has to learn to ignore.
 */
const nullsLast: SortingFn<ScoutRow> = (a, b, columnId) => {
  const x = a.getValue(columnId) as number | null
  const y = b.getValue(columnId) as number | null
  if (x === null || x === undefined) return 1
  if (y === null || y === undefined) return -1
  return x < y ? -1 : x > y ? 1 : 0
}

function HeatCell({
  value,
  pct,
  digits = 2,
}: {
  value: number | null
  pct: number | null
  digits?: number
}) {
  // No percentile means the sample was too small to rank. Hatched rather than shaded, so it
  // reads as "not ranked" instead of "ranked low".
  if (pct === null) {
    return (
      <div className="heat-null flex h-full items-center justify-end px-2 py-1.5">
        <span className="num" style={{ color: 'var(--faint)' }}>
          {fmt(value, digits)}
        </span>
      </div>
    )
  }
  return (
    <div
      className="heat flex h-full items-center justify-end px-2 py-1.5"
      style={{ ['--p' as string]: pct }}
      title={`${Math.round(pct * 100)}th percentile in position`}
    >
      <span className="num">{fmt(value, digits)}</span>
    </div>
  )
}

function metric(
  id: string,
  header: string,
  get: (r: ScoutRow) => number | null,
  pctKey: PctKey | null,
  digits = 2,
  tooltip?: string,
): ColumnDef<ScoutRow> {
  return {
    id,
    header: () => <span title={tooltip}>{header}</span>,
    accessorFn: get,
    sortingFn: nullsLast,
    sortUndefined: 'last',
    cell: ({ row }) =>
      pctKey ? (
        <HeatCell value={get(row.original)} pct={row.original.pct[pctKey]} digits={digits} />
      ) : (
        <div className="flex h-full items-center justify-end px-2 py-1.5">
          <span className="num">{fmt(get(row.original), digits)}</span>
        </div>
      ),
  }
}

const POSITIONS = ['GKP', 'DEF', 'MID', 'FWD'] as const

export function ScoutTable({
  rows,
  statsSeason,
  seasonStarted,
}: {
  rows: ScoutRow[]
  statsSeason: string | null
  seasonStarted: boolean
}) {
  // Price bounds come from the data, never a literal. A hardcoded 15.0 default silently
  // excluded Haaland at £15.5 — the single most-owned player in the game missing from a scout
  // screen that reported "557 of 558 players" and looked entirely healthy. FPL's ceiling moves
  // between seasons, so any constant here is a future version of the same bug.
  const priceCeiling = useMemo(() => {
    const prices = rows.map((r) => r.price ?? 0).filter((p) => p > 0)
    if (!prices.length) return 15.5
    return Math.ceil(Math.max(...prices) * 2) / 2 // up to the nearest 0.5, as FPL prices are
  }, [rows])
  const priceFloor = useMemo(() => {
    const prices = rows.map((r) => r.price ?? 0).filter((p) => p > 0)
    if (!prices.length) return 3.5
    return Math.floor(Math.min(...prices) * 2) / 2
  }, [rows])

  const [sorting, setSorting] = useState<SortingState>([{ id: 'xgi', desc: true }])
  const [search, setSearch] = useState('')
  const [positions, setPositions] = useState<Set<string>>(new Set())
  const [team, setTeam] = useState('')
  const [maxPrice, setMaxPrice] = useState(priceCeiling)
  const [minMinutes, setMinMinutes] = useState(0)
  const [maxOwnership, setMaxOwnership] = useState(100)
  const [availableOnly, setAvailableOnly] = useState(false)
  const [hideColdStart, setHideColdStart] = useState(false)

  const teams = useMemo(
    () => [...new Set(rows.map((r) => r.teamShort).filter(Boolean) as string[])].sort(),
    [rows],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (q && !r.webName.toLowerCase().includes(q)) return false
      if (positions.size && !positions.has(r.position)) return false
      if (team && r.teamShort !== team) return false
      if (r.price !== null && r.price > maxPrice) return false
      if ((r.minutes ?? 0) < minMinutes) return false
      if ((r.selectedByPercent ?? 0) > maxOwnership) return false
      if (availableOnly && !r.isAvailable) return false
      if (hideColdStart && r.isColdStart) return false
      return true
    })
  }, [
    rows, search, positions, team, maxPrice, minMinutes, maxOwnership,
    availableOnly, hideColdStart,
  ])

  const columns = useMemo<ColumnDef<ScoutRow>[]>(
    () => [
      {
        id: 'player',
        header: 'Player',
        accessorFn: (r) => r.webName,
        cell: ({ row }) => {
          const r = row.original
          return (
            <div className="flex items-center gap-2 px-3 py-1.5">
              <span
                className="w-1 self-stretch rounded-full"
                style={{ background: POSITION_VAR[r.position] }}
                aria-hidden
              />
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: statusColour(r.status, r.chanceOfPlaying) }}
                title={
                  r.news ||
                  `${STATUS_LABEL[r.status ?? 'a'] ?? r.status}${
                    r.chanceOfPlaying !== null ? ` (${r.chanceOfPlaying}% chance)` : ''
                  }`
                }
              />
              <span className="whitespace-nowrap text-[13px] font-medium">{r.webName}</span>
              <span className="text-[11px]" style={{ color: 'var(--faint)' }}>
                {r.teamShort}
              </span>
              {r.isColdStart && (
                <span
                  className="rounded px-1 text-[9px] font-semibold uppercase tracking-wide"
                  style={{ background: 'var(--surface-2)', color: 'var(--faint)' }}
                  title="No reliable prior-season sample — 19% of the pool. Not ranked rather than ranked last."
                >
                  new
                </span>
              )}
              <SetPieceBadges row={r} />
            </div>
          )
        },
      },
      {
        id: 'pos',
        header: 'Pos',
        accessorFn: (r) => r.elementType,
        cell: ({ row }) => (
          <div className="px-2 py-1.5">
            <span
              className="text-[11px] font-semibold"
              style={{ color: POSITION_VAR[row.original.position] }}
            >
              {row.original.position}
            </span>
          </div>
        ),
      },
      {
        id: 'price',
        header: 'Price',
        accessorFn: (r) => r.price,
        sortingFn: nullsLast,
        cell: ({ row }) => (
          <div className="px-2 py-1.5 text-right">
            <span className="num">{fmtPrice(row.original.price)}</span>
          </div>
        ),
      },
      {
        id: 'owned',
        header: 'Owned',
        accessorFn: (r) => r.selectedByPercent,
        sortingFn: nullsLast,
        cell: ({ row }) => (
          <HeatCell
            value={row.original.selectedByPercent}
            pct={row.original.pct.differential}
            digits={1}
          />
        ),
      },
      metric('mins', 'Mins', (r) => r.minutes, null, 0, 'League minutes last season'),
      metric('pts', 'Pts', (r) => r.totalPoints, null, 0),
      metric('ppm', 'Pts/£m', (r) => r.pointsPerMillion, 'value', 2,
        'Total points per million of current price'),
      metric('pp90', 'Pts/90', (r) => r.pointsPer90, 'points', 2),
      metric('xgi', 'xGI/90', (r) => r.xgiPer90, 'xgi', 3,
        'Expected goal involvement per 90 — goals plus assists the model expected'),
      metric('xg', 'xG/90', (r) => r.xgPer90, 'xg', 3),
      metric('xa', 'xA/90', (r) => r.xaPer90, 'xa', 3),
      metric('defcon', 'DC/90', (r) => r.defconPer90, 'defcon', 2,
        'Defensive contribution per 90. Threshold for 2 points is 10 for defenders, 12 for midfielders and forwards. Per-match hit rate arrives at GW1.'),
      metric('xgc', 'xGC/90', (r) => r.xgcPer90, 'xgc', 3,
        'Expected goals conceded per 90 — lower is better, so the colour is inverted'),
      metric('bps', 'BPS/90', (r) => r.bpsPer90, 'bps', 1),
      metric('gmxg', 'G−xG', (r) => r.goalsMinusXg, null, 2,
        'Goals minus expected goals. Positive means outperforming the model, which tends to regress.'),
      metric('buildup', 'Buildup', (r) => r.xgBuildupPer90, null, 3,
        'Understat xG buildup per 90: possessions the player was involved in, excluding their own shots and key passes. No FPL equivalent.'),
      {
        id: 'euro',
        header: 'Euro',
        accessorFn: (r) => r.pctMinutesOutsideLeague,
        sortingFn: nullsLast,
        cell: ({ row }) => {
          const r = row.original
          if (!r.otherMinutes) {
            return <div className="px-2 py-1.5 text-right">
              <span className="num" style={{ color: 'var(--faint)' }}>—</span>
            </div>
          }
          return (
            <div
              className="px-2 py-1.5 text-right"
              title={`${fmtInt(r.otherMinutes)} minutes in cup and European competition — rotation and fatigue risk`}
            >
              <span
                className="num"
                style={{
                  color:
                    (r.pctMinutesOutsideLeague ?? 0) > 25 ? 'var(--warn)' : 'var(--muted)',
                }}
              >
                {fmtPct(r.pctMinutesOutsideLeague, 0)}
              </span>
            </div>
          )
        },
      },
    ],
    [],
  )

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Search">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Player name"
            className="h-9 w-44 rounded-lg border px-3 text-[13px] outline-none focus:border-[var(--accent)]"
            style={{ background: 'var(--surface)' }}
          />
        </Field>

        <Field label="Position">
          <div className="flex h-9 items-center gap-1">
            {POSITIONS.map((p) => {
              const on = positions.has(p)
              return (
                <button
                  key={p}
                  onClick={() => {
                    const next = new Set(positions)
                    if (on) next.delete(p)
                    else next.add(p)
                    setPositions(next)
                  }}
                  className="h-9 rounded-lg border px-2.5 text-[12px] font-semibold transition-colors"
                  style={{
                    background: on ? POSITION_VAR[p] : 'var(--surface)',
                    color: on ? 'var(--bg)' : 'var(--muted)',
                    borderColor: on ? POSITION_VAR[p] : 'var(--border)',
                  }}
                >
                  {p}
                </button>
              )
            })}
          </div>
        </Field>

        <Field label="Team">
          <select
            value={team}
            onChange={(e) => setTeam(e.target.value)}
            className="h-9 w-28 rounded-lg border px-2 text-[13px] outline-none focus:border-[var(--accent)]"
            style={{ background: 'var(--surface)', color: 'var(--text)' }}
          >
            <option value="">All</option>
            {teams.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>

        <Slider label="Max price" value={maxPrice} min={priceFloor} max={priceCeiling} step={0.5}
          onChange={setMaxPrice} display={fmtPrice(maxPrice)} />
        <Slider label="Min mins" value={minMinutes} min={0} max={3000} step={100}
          onChange={setMinMinutes} display={fmtInt(minMinutes)} />
        <Slider label="Max owned" value={maxOwnership} min={0} max={100} step={1}
          onChange={setMaxOwnership} display={`${maxOwnership}%`} />

        <Toggle label="Available only" on={availableOnly} onChange={setAvailableOnly} />
        <Toggle label="Hide new" on={hideColdStart} onChange={setHideColdStart} />
      </div>

      <div className="flex items-center justify-between text-[12px]" style={{ color: 'var(--muted)' }}>
        <span>
          <strong style={{ color: 'var(--text)' }}>{filtered.length}</strong> of {rows.length}{' '}
          players
        </span>
        <span>
          {seasonStarted
            ? `Rates from ${statsSeason} to date`
            : `Rates from ${statsSeason} — the season has not started, so these are last season's numbers against current prices and clubs`}
        </span>
      </div>

      <div
        className="scroll-thin overflow-auto rounded-xl border"
        style={{ background: 'var(--surface)', maxHeight: 'calc(100vh - 260px)' }}
      >
        <table className="w-full border-separate border-spacing-0 text-left">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header, i) => {
                  const sorted = header.column.getIsSorted()
                  return (
                    <th
                      key={header.id}
                      onClick={header.column.getToggleSortingHandler()}
                      className={`sticky top-0 z-20 cursor-pointer select-none border-b px-2 py-2 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap ${
                        i === 0 ? 'left-0 z-30 text-left' : 'text-right'
                      }`}
                      style={{
                        background: 'var(--surface-2)',
                        color: sorted ? 'var(--accent)' : 'var(--muted)',
                      }}
                    >
                      <span className="inline-flex items-center gap-1">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        <span style={{ opacity: sorted ? 1 : 0.25 }}>
                          {sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '▾'}
                        </span>
                      </span>
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="group">
                {row.getVisibleCells().map((cell, i) => (
                  <td
                    key={cell.id}
                    className={`border-b p-0 align-middle ${
                      i === 0 ? 'sticky left-0 z-10' : ''
                    }`}
                    style={i === 0 ? { background: 'var(--surface)' } : undefined}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="px-4 py-12 text-center text-[13px]" style={{ color: 'var(--muted)' }}>
            No players match these filters.
          </div>
        )}
      </div>

      <Legend />
    </div>
  )
}

function SetPieceBadges({ row }: { row: ScoutRow }) {
  const badges: { text: string; title: string }[] = []
  if (row.penaltiesOrder !== null)
    badges.push({ text: `P${row.penaltiesOrder}`, title: `Penalty taker #${row.penaltiesOrder}` })
  if (row.freekicksOrder !== null)
    badges.push({ text: `F${row.freekicksOrder}`, title: `Direct free-kick taker #${row.freekicksOrder}` })
  if (row.cornersOrder !== null)
    badges.push({ text: `C${row.cornersOrder}`, title: `Corner taker #${row.cornersOrder}` })
  if (!badges.length) return null
  return (
    <span className="flex gap-1">
      {badges.map((b) => (
        <span
          key={b.text}
          title={b.title}
          className="rounded px-1 text-[9px] font-bold"
          style={{
            background: 'color-mix(in oklab, var(--accent) 22%, transparent)',
            color: 'var(--accent)',
          }}
        >
          {b.text}
        </span>
      ))}
    </span>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--faint)' }}>
        {label}
      </span>
      {children}
    </label>
  )
}

function Slider({
  label, value, min, max, step, onChange, display,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  display: string
}) {
  return (
    <Field label={`${label} · ${display}`}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-9 w-32 accent-[var(--accent)]"
      />
    </Field>
  )
}

function Toggle({
  label, on, onChange,
}: {
  label: string
  on: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      className="h-9 rounded-lg border px-3 text-[12px] font-medium transition-colors"
      style={{
        background: on ? 'color-mix(in oklab, var(--accent) 18%, var(--surface))' : 'var(--surface)',
        color: on ? 'var(--accent)' : 'var(--muted)',
        borderColor: on ? 'var(--accent)' : 'var(--border)',
      }}
    >
      {label}
    </button>
  )
}

function Legend() {
  return (
    <div
      className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px]"
      style={{ color: 'var(--faint)' }}
    >
      <span className="flex items-center gap-1.5">
        Percentile in position
        <span className="flex overflow-hidden rounded" aria-hidden>
          {[0, 0.25, 0.5, 0.75, 1].map((p) => (
            <span key={p} className="heat h-3 w-6" style={{ ['--p' as string]: p }} />
          ))}
        </span>
        <span>low → high</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="heat-null inline-block h-3 w-6 rounded" aria-hidden /> under 450 mins,
        not ranked
      </span>
      <span>
        <strong style={{ color: 'var(--muted)' }}>P/F/C</strong> = penalty, free-kick and corner
        order
      </span>
      <span>xGC and Owned colour inverted — lower is better</span>
    </div>
  )
}
