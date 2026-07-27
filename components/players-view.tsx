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
import { useEffect, useMemo, useState } from 'react'
import { ColumnPicker } from '@/components/column-picker'
import { PlayerPhoto } from '@/components/player-photo'
import { WatchButton } from '@/components/watch-button'
import { COLUMNS_BY_KEY, PINNED, PRESETS } from '@/lib/columns'
import type { Filters, Preset } from '@/lib/columns'
import { countActive, encodeFilters, passes } from '@/lib/filters'
import { POSITION_VAR, formatCell, statusColour } from '@/lib/format'
import type { SavedView, WideTable } from '@/lib/queries'
import { rankAll } from '@/lib/rank'

/**
 * One table, many views.
 *
 * `/scout` and `/gems` were the same 558 rows with different columns and different row
 * filters, so they are now one screen: a *view* picks the columns, a *filter* picks the rows,
 * and both live in the URL so any combination is a link. Presets ship in lib/columns.ts;
 * anything else the user composes here and saves.
 *
 * The whole dataset is already in the browser — 89 columns × 558 players is 53 KB gzipped,
 * half what the old single-view page shipped — so switching view, sorting and filtering never
 * touch the network.
 */

type Row = Record<string, unknown>

/**
 * Compares present values only. Missing ones never reach it — see the accessor below.
 *
 * A sorting function cannot put nulls last in *both* directions, because TanStack inverts
 * whatever it returns when the sort is descending: "always return 1 for null" is nulls-last
 * ascending and nulls-*first* descending. That is not theoretical. The first render of this
 * table sorted Overview by points descending and put Burstow on top — 1.1% owned, no points
 * at all — and the Defenders view led with a centre-back on 3% of the season and no DC/90.
 * Exactly the class of fault Peder has caught twice by reading the screen.
 *
 * The fix is `sortUndefined: 'last'`, which TanStack applies before the comparator and honours
 * in both directions. It only recognises `undefined`, so the accessor maps null to undefined.
 */
const compare: SortingFn<Row> = (a, b, columnId) => {
  const x = a.getValue(columnId) as number | string
  const y = b.getValue(columnId) as number | string
  return x < y ? -1 : x > y ? 1 : 0
}

const POSITIONS = ['GKP', 'DEF', 'MID', 'FWD'] as const

function HeatCell({ text, p, title }: { text: string; p: number | null; title?: string }) {
  // No rank means unranked, which must not read as ranked-low. Hatching, per DESIGN.md's three
  // kinds of absent: em dash for no value, hatching for not ranked, and neither is a zero.
  if (p === null) {
    return (
      <div className="heat-null flex h-full items-center justify-end px-2 py-1.5" title={title}>
        <span className="num" style={{ color: 'var(--faint)' }}>
          {text}
        </span>
      </div>
    )
  }
  return (
    <div
      className="heat flex h-full items-center justify-end px-2 py-1.5"
      style={{ ['--p' as string]: p }}
      title={title ?? `${Math.round(p * 100)}th percentile`}
    >
      <span className="num">{text}</span>
    </div>
  )
}

export function PlayersView({
  table: wide,
  watchedCodes,
  savedViews,
  statsSeason,
  initialPreset,
  initialFilters,
}: {
  table: WideTable
  watchedCodes: number[]
  savedViews: SavedView[]
  statsSeason: string | null
  initialPreset: string
  initialFilters: Filters
}) {
  // Columnar over the wire, objects in memory. 558 objects is nothing to hold, and it keeps
  // both TanStack and the ranker working with plain records instead of index arithmetic.
  const rows = useMemo<Row[]>(
    () => wide.rows.map((r) => Object.fromEntries(wide.cols.map((c, i) => [c, r[i]]))),
    [wide],
  )

  const watched = useMemo(() => new Set(watchedCodes), [watchedCodes])
  const teams = useMemo(
    () => [...new Set(rows.map((r) => String(r.team_short ?? '')).filter(Boolean))].sort(),
    [rows],
  )

  const startingPreset =
    PRESETS.find((p) => p.key === initialPreset) ?? PRESETS[0]

  const [viewKey, setViewKey] = useState<string>(startingPreset.key)
  const [columns, setColumns] = useState<string[]>(startingPreset.columns)
  const [filters, setFilters] = useState<Filters>(
    countActive(initialFilters) ? initialFilters : (startingPreset.filters ?? {}),
  )
  const [sorting, setSorting] = useState<SortingState>(
    startingPreset.sort ? [{ id: startingPreset.sort.key, desc: startingPreset.sort.desc }] : [],
  )
  const [picking, setPicking] = useState(false)

  function applyPreset(p: Preset) {
    setViewKey(p.key)
    setColumns(p.columns)
    setFilters(p.filters ?? {})
    setSorting(p.sort ? [{ id: p.sort.key, desc: p.sort.desc }] : [])
  }

  function applySaved(v: SavedView) {
    setViewKey(`saved:${v.id}`)
    setColumns(v.columns)
    setFilters(v.filters as Filters)
    setSorting(v.sortKey ? [{ id: v.sortKey, desc: v.sortDesc }] : [])
  }

  // The URL is the shareable state. replaceState rather than a router push: this fires on
  // every slider drag, and a history entry per pixel would make the back button useless.
  useEffect(() => {
    const qs = encodeFilters(filters)
    const url = `/players?view=${encodeURIComponent(viewKey)}${qs ? `&${qs}` : ''}`
    window.history.replaceState(null, '', url)
  }, [viewKey, filters])

  const visible = useMemo(
    () => rows.filter((r) => passes(r, filters, watched)),
    [rows, filters, watched],
  )

  // Ranked over the filtered set, so shading rescales to what is on screen: narrow to forwards
  // under £7.0 and the best of those goes fully green, which is the question being asked.
  const ranks = useMemo(() => rankAll(visible, columns), [visible, columns])
  const rowIndex = useMemo(() => new Map(visible.map((r, i) => [r, i])), [visible])

  const defs = useMemo<ColumnDef<Row>[]>(() => {
    const out: ColumnDef<Row>[] = [
      {
        id: 'player',
        header: () => <span className="pl-2">Player</span>,
        accessorFn: (r) => r.web_name,
        sortingFn: compare,
        sortUndefined: 'last',
        cell: ({ row }) => {
          const r = row.original
          return (
            <div className="flex items-center gap-2 px-2 py-1">
              <PlayerPhoto
                playerCode={Number(r.player_code)}
                name={String(r.web_name ?? '')}
                size={26}
                accent={POSITION_VAR[String(r.position)]}
              />
              {r.status !== 'a' && (
                <span
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: statusColour(String(r.status), null) }}
                  title={(r.news as string) || undefined}
                />
              )}
              <span className="truncate text-[13px] font-medium">{String(r.web_name ?? '')}</span>
              <span
                className="shrink-0 text-[10px] font-semibold"
                style={{ color: POSITION_VAR[String(r.position)] }}
              >
                {String(r.position)}
              </span>
              <span className="shrink-0 text-[11px]" style={{ color: 'var(--faint)' }}>
                {String(r.team_short ?? '')}
              </span>
            </div>
          )
        },
      },
    ]

    for (const key of columns) {
      const col = COLUMNS_BY_KEY.get(key)
      // Silently skipping is right here: a saved view must survive a column being retired from
      // the catalogue, rather than failing to load at all.
      if (!col || PINNED.includes(key)) continue
      out.push({
        id: key,
        header: () => (
          <span title={col.why ? `${col.full}. ${col.why}` : col.full}>{col.label}</span>
        ),
        // undefined, not null: `sortUndefined` is the only mechanism that survives a direction
        // flip, and it does not recognise null. Display still reads row.original, so the
        // em dash is unaffected.
        accessorFn: (r) => r[key] ?? undefined,
        sortingFn: compare,
        sortUndefined: 'last',
        cell: ({ row }) => {
          const i = rowIndex.get(row.original)
          const p = i === undefined ? null : (ranks.get(key)?.[i] ?? null)
          return (
            <HeatCell
              text={formatCell(row.original[key], col.format)}
              p={col.direction === 'none' ? null : p}
              title={
                col.direction === 'none'
                  ? `${col.full} — not shaded${col.why ? `. ${col.why}` : ''}`
                  : undefined
              }
            />
          )
        },
      })
    }

    out.push({
      id: 'watch',
      header: () => '',
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex items-center justify-center px-1">
          <WatchButton
            playerCode={Number(row.original.player_code)}
            watched={watched.has(Number(row.original.player_code))}
          />
        </div>
      ),
    })
    return out
  }, [columns, ranks, rowIndex, watched])

  const table = useReactTable({
    data: visible,
    columns: defs,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const activeSaved = savedViews.find((v) => `saved:${v.id}` === viewKey)
  const activePreset = PRESETS.find((p) => p.key === viewKey)
  const nFilters = countActive(filters)

  return (
    <div className="flex flex-col gap-3">
      {/* ---- view switcher ---- */}
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            onClick={() => applyPreset(p)}
            title={p.blurb}
            className="h-7 rounded-lg border px-2.5 text-[11px] font-medium transition-colors"
            style={{
              background:
                viewKey === p.key
                  ? 'color-mix(in oklab, var(--accent) 18%, var(--surface))'
                  : 'var(--surface)',
              color: viewKey === p.key ? 'var(--accent)' : 'var(--muted)',
              borderColor: viewKey === p.key ? 'var(--accent)' : 'var(--border)',
            }}
          >
            {p.name}
          </button>
        ))}
        {savedViews.map((v) => (
          <button
            key={v.id}
            onClick={() => applySaved(v)}
            title="Your saved view"
            className="h-7 rounded-lg border border-dashed px-2.5 text-[11px] font-medium transition-colors"
            style={{
              background:
                viewKey === `saved:${v.id}`
                  ? 'color-mix(in oklab, var(--accent) 18%, var(--surface))'
                  : 'var(--surface)',
              color: viewKey === `saved:${v.id}` ? 'var(--accent)' : 'var(--muted)',
              borderColor: viewKey === `saved:${v.id}` ? 'var(--accent)' : 'var(--border)',
            }}
          >
            {v.name}
          </button>
        ))}
        <button
          onClick={() => setPicking(true)}
          className="h-7 rounded-lg border px-2.5 text-[11px] font-medium"
          style={{ background: 'var(--surface)', color: 'var(--accent)', borderColor: 'var(--accent)' }}
        >
          + Columns
        </button>
      </div>

      {(activePreset || activeSaved) && (
        <p className="text-[12px]" style={{ color: 'var(--faint)' }}>
          {activePreset?.blurb ?? 'Your saved view'} · {columns.length} columns ·{' '}
          <strong style={{ color: 'var(--muted)' }}>{visible.length}</strong> of {rows.length}{' '}
          players
          {nFilters > 0 && ` · ${nFilters} filter${nFilters === 1 ? '' : 's'}`}
          {statsSeason && ` · ${statsSeason} data`}
        </p>
      )}

      {/* ---- filters ---- */}
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border p-3"
        style={{ background: 'var(--surface)' }}
      >
        <input
          value={filters.search ?? ''}
          onChange={(e) => setFilters({ ...filters, search: e.target.value || undefined })}
          placeholder="Search player or club"
          className="h-7 rounded-lg border px-2 text-[12px]"
          style={{ background: 'var(--surface-2)', borderColor: 'var(--border)', minWidth: 170 }}
        />

        <div className="flex items-center gap-1">
          {POSITIONS.map((p) => {
            const on = filters.positions?.includes(p) ?? false
            return (
              <button
                key={p}
                onClick={() => {
                  const cur = filters.positions ?? []
                  const next = on ? cur.filter((x) => x !== p) : [...cur, p]
                  setFilters({ ...filters, positions: next.length ? next : undefined })
                }}
                className="h-7 rounded-lg border px-2 text-[11px] font-semibold"
                style={{
                  background: on ? 'color-mix(in oklab, var(--accent) 16%, var(--surface))' : 'var(--surface-2)',
                  color: on ? POSITION_VAR[p] : 'var(--faint)',
                  borderColor: on ? 'var(--accent)' : 'var(--border)',
                }}
              >
                {p}
              </button>
            )
          })}
        </div>

        <select
          value={filters.teams?.[0] ?? ''}
          onChange={(e) =>
            setFilters({ ...filters, teams: e.target.value ? [e.target.value] : undefined })
          }
          className="h-7 rounded-lg border px-2 text-[12px]"
          style={{ background: 'var(--surface-2)', borderColor: 'var(--border)' }}
        >
          <option value="">All clubs</option>
          {teams.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <NumberRange
          label="£"
          min={filters.priceMin}
          max={filters.priceMax}
          step={0.5}
          onChange={(min, max) => setFilters({ ...filters, priceMin: min, priceMax: max })}
        />
        <NumberRange
          label="Owned %"
          min={filters.ownedMin}
          max={filters.ownedMax}
          step={1}
          onChange={(min, max) => setFilters({ ...filters, ownedMin: min, ownedMax: max })}
        />

        <Toggle
          on={filters.availableOnly ?? false}
          label="Fit only"
          hint="Status available and no published doubt. Excludes a 75%-doubtful player, which FPL still flags as available."
          onChange={(v) => setFilters({ ...filters, availableOnly: v || undefined })}
        />
        <Toggle
          on={filters.reliableOnly ?? false}
          label="Reliable sample"
          hint="Enough minutes for a per-90 rate to mean anything"
          onChange={(v) => setFilters({ ...filters, reliableOnly: v || undefined })}
        />
        <Toggle
          on={filters.penaltyTakersOnly ?? false}
          label="Pen taker"
          hint="First-choice penalty taker only"
          onChange={(v) => setFilters({ ...filters, penaltyTakersOnly: v || undefined })}
        />
        <Toggle
          on={filters.watchedOnly ?? false}
          label="Watchlist"
          hint="Only players you have hearted"
          onChange={(v) => setFilters({ ...filters, watchedOnly: v || undefined })}
        />

        {nFilters > 0 && (
          <button
            onClick={() => setFilters({})}
            className="h-7 rounded-lg px-2 text-[11px] font-medium"
            style={{ color: 'var(--accent)' }}
          >
            Clear {nFilters}
          </button>
        )}
      </div>

      {/* ---- table ---- */}
      <div className="overflow-x-auto rounded-xl border" style={{ background: 'var(--surface)' }}>
        <table className="w-full border-collapse text-[12px]">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    onClick={h.column.getToggleSortingHandler()}
                    className="sticky top-0 z-10 cursor-pointer border-b px-1 py-2 text-right text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap select-none"
                    style={{ background: 'var(--surface-2)', color: 'var(--muted)' }}
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {{ asc: ' ↑', desc: ' ↓' }[h.column.getIsSorted() as string] ?? ''}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="border-b" style={{ borderColor: 'var(--border)' }}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="p-0 align-middle">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && (
          <p className="p-6 text-center text-[13px]" style={{ color: 'var(--muted)' }}>
            No player matches these filters.
          </p>
        )}
      </div>

      {picking && (
        <ColumnPicker
          selected={columns}
          filters={filters}
          sortKey={sorting[0]?.id ?? null}
          sortDesc={sorting[0]?.desc ?? true}
          existing={activeSaved ?? null}
          onApply={(next) => {
            setColumns(next)
            // Composing columns makes this no longer the preset it started from, and saying so
            // beats a highlighted preset button that no longer describes what is on screen.
            if (!viewKey.startsWith('custom')) setViewKey('custom')
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  )
}

function NumberRange({
  label,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  min: number | undefined
  max: number | undefined
  step: number
  onChange: (min: number | undefined, max: number | undefined) => void
}) {
  const box = {
    background: 'var(--surface-2)',
    borderColor: 'var(--border)',
    width: 58,
  } as const
  return (
    <span className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--faint)' }}>
      {label}
      <input
        type="number"
        step={step}
        value={min ?? ''}
        placeholder="min"
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value), max)}
        className="num h-7 rounded-lg border px-1.5 text-[12px]"
        style={box}
      />
      <input
        type="number"
        step={step}
        value={max ?? ''}
        placeholder="max"
        onChange={(e) => onChange(min, e.target.value === '' ? undefined : Number(e.target.value))}
        className="num h-7 rounded-lg border px-1.5 text-[12px]"
        style={box}
      />
    </span>
  )
}

function Toggle({
  on,
  label,
  hint,
  onChange,
}: {
  on: boolean
  label: string
  hint?: string
  onChange: (v: boolean) => void
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      title={hint}
      className="h-7 rounded-lg border px-2 text-[11px] font-medium"
      style={{
        background: on ? 'color-mix(in oklab, var(--accent) 16%, var(--surface))' : 'var(--surface-2)',
        color: on ? 'var(--accent)' : 'var(--faint)',
        borderColor: on ? 'var(--accent)' : 'var(--border)',
      }}
    >
      {label}
    </button>
  )
}
