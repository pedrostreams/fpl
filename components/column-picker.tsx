'use client'

import { useState, useTransition } from 'react'
import { COLUMNS, GROUP_ORDER, PINNED } from '@/lib/columns'
import type { Filters } from '@/lib/columns'
import { deleteView, saveView } from '@/lib/actions'
import type { SavedView } from '@/lib/queries'

/**
 * Compose a view: pick columns, optionally save the result with its filters and sort.
 *
 * Grouped by what the metric is about rather than listed alphabetically — nobody looks for
 * "big chances per 90" under B. Each entry carries its own explanation, including the ones
 * that are deliberately not shaded, because "why is this column grey" is otherwise a mystery
 * the user has to guess at.
 */
export function ColumnPicker({
  selected,
  filters,
  sortKey,
  sortDesc,
  existing,
  onApply,
  onClose,
}: {
  selected: string[]
  filters: Filters
  sortKey: string | null
  sortDesc: boolean
  existing: SavedView | null
  onApply: (columns: string[]) => void
  onClose: () => void
}) {
  const [picked, setPicked] = useState<string[]>(selected)
  const [name, setName] = useState(existing?.name ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, startTransition] = useTransition()

  // Order matters and is the user's: columns render left to right in the order they were
  // added, so toggling off and on again moves a column to the end. That is predictable, and
  // it is the only reordering control the picker needs.
  function toggle(key: string) {
    setSaved(false)
    setPicked((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]))
  }

  function submit() {
    setError(null)
    startTransition(async () => {
      const res = await saveView({
        id: existing?.id,
        name,
        columns: picked,
        filters: filters as Record<string, unknown>,
        sortKey,
        sortDesc,
      })
      if (!res.ok) setError(res.error ?? 'Could not save that view.')
      else {
        setSaved(true)
        onApply(picked)
      }
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
      style={{ background: 'var(--scrim)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl rounded-xl border p-5"
        style={{ background: 'var(--surface)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold">Columns</h2>
            <p className="mt-0.5 text-[12px]" style={{ color: 'var(--muted)' }}>
              {picked.length} selected. Player, position and club are always shown. Columns
              appear in the order you add them.
            </p>
          </div>
          <button
            onClick={onClose}
            className="h-7 rounded-lg border px-2.5 text-[11px]"
            style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
          >
            Close
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-4">
          {GROUP_ORDER.map((group) => {
            const cols = COLUMNS.filter((c) => c.group === group && !PINNED.includes(c.key))
            if (!cols.length) return null
            return (
              <div key={group}>
                <div
                  className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider"
                  style={{ color: 'var(--faint)' }}
                >
                  {group}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {cols.map((c) => {
                    const on = picked.includes(c.key)
                    return (
                      <button
                        key={c.key}
                        onClick={() => toggle(c.key)}
                        data-tip={
                          [
                            c.full,
                            c.direction === 'none'
                              ? 'Shown as a plain number — “better” is not well defined for this one.'
                              : c.direction === 'lower'
                                ? 'Lower is better, and the shading is inverted to match.'
                                : null,
                            c.why,
                          ]
                            .filter(Boolean)
                            .join(' ')
                        }
                        className="flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition-colors"
                        style={{
                          background: on
                            ? 'color-mix(in oklab, var(--accent) 18%, var(--surface))'
                            : 'var(--surface-2)',
                          color: on ? 'var(--accent)' : 'var(--muted)',
                          borderColor: on ? 'var(--accent)' : 'var(--border)',
                        }}
                      >
                        {c.label}
                        {c.direction === 'lower' && (
                          <span style={{ color: 'var(--faint)' }} data-tip="Lower is better">
                            ↓
                          </span>
                        )}
                        {c.direction === 'none' && (
                          <span style={{ color: 'var(--faint)' }} data-tip="Not shaded">
                            ·
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>

        <div
          className="mt-5 flex flex-wrap items-center gap-2 border-t pt-4"
          style={{ borderColor: 'var(--border)' }}
        >
          <button
            onClick={() => {
              onApply(picked)
              onClose()
            }}
            className="h-8 rounded-lg border px-3 text-[12px] font-medium"
            style={{
              background: 'color-mix(in oklab, var(--accent) 18%, var(--surface))',
              color: 'var(--accent)',
              borderColor: 'var(--accent)',
            }}
          >
            Apply
          </button>

          <span className="text-[11px]" style={{ color: 'var(--faint)' }}>
            or save it —
          </span>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setSaved(false)
            }}
            placeholder="View name"
            className="h-8 rounded-lg border px-2 text-[12px]"
            style={{ background: 'var(--surface-2)', borderColor: 'var(--border)', minWidth: 150 }}
          />
          <button
            onClick={submit}
            disabled={pending || !name.trim() || !picked.length}
            className="h-8 rounded-lg border px-3 text-[12px] font-medium disabled:opacity-40"
            style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
          >
            {pending ? 'Saving…' : existing ? 'Update' : 'Save view'}
          </button>

          {existing && (
            <button
              onClick={() =>
                startTransition(async () => {
                  await deleteView(existing.id)
                  onClose()
                })
              }
              className="h-8 rounded-lg px-2 text-[11px]"
              style={{ color: 'var(--danger)' }}
            >
              Delete
            </button>
          )}

          {saved && (
            <span className="text-[11px]" style={{ color: 'var(--ok)' }}>
              Saved — the current filters and sort are stored with it.
            </span>
          )}
          {error && (
            <span className="text-[11px]" style={{ color: 'var(--danger)' }}>
              {error}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
