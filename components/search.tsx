'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { PlayerPhoto } from '@/components/player-photo'
import { TeamBadge } from '@/components/team-badge'
import { POSITION_VAR } from '@/lib/format'
import type { SearchEntry } from '@/lib/queries'

/**
 * One search for players and clubs.
 *
 * Flat rather than two tabs, because nobody thinks "am I looking for a player or a club" — they
 * think of a name. The whole index is 674 rows and matching happens in the browser: no
 * round-trip per keystroke, and it works while a slow query is in flight somewhere else.
 *
 * The index arrives from /search-index.json, fetched the first time the palette opens, rather
 * than as a prop from the layout. As a prop it was serialised into every page of the site — 133KB
 * of JSON, and again into the RSC payload beside it, which came to 468MB of exported output for
 * the player profiles alone and about 400KB of every page load. Now it is one file, downloaded
 * only by people who search, and cached by the browser for the rest of the session.
 */

/**
 * Module scope, so the index survives navigation between pages and is fetched at most once.
 *
 * `inFlight` and not just `cached`: opening the palette, closing it and reopening it before the
 * response lands must not start a second download.
 */
let cached: SearchEntry[] | null = null
let inFlight: Promise<SearchEntry[]> | null = null

function loadIndex(): Promise<SearchEntry[]> {
  if (cached) return Promise.resolve(cached)
  inFlight ??= fetch('/search-index.json')
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json() as Promise<SearchEntry[]>
    })
    .then((rows) => {
      cached = rows
      return rows
    })
    .catch((e) => {
      // Let the next open try again rather than remembering the failure forever.
      inFlight = null
      throw e
    })
  return inFlight
}

/** Score a match. Higher is better; null means no match at all. */
function score(entry: SearchEntry, q: string): number | null {
  const label = entry.label.toLowerCase()
  if (label === q) return 1000
  if (label.startsWith(q)) return 600
  // Word-start anywhere in the haystack: "fer" should find B.Fernandes, whose web_name begins
  // with an initial, and "man u" should find Manchester United.
  if (new RegExp(`(^|\\s)${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(entry.haystack)) {
    return 400
  }
  if (entry.haystack.includes(q)) return 200
  return null
}

export function Search() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState<SearchEntry[]>(cached ?? [])
  const [failed, setFailed] = useState(false)
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Ctrl/Cmd+K from anywhere, and "/" when not already typing in a field — the two conventions
  // a keyboard user will try without being told.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const typing =
        e.target instanceof HTMLElement &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault()
        setOpen(true)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (open) inputRef.current?.focus()
    else {
      setQ('')
      setCursor(0)
    }
  }, [open])

  // On first open, not on mount: nothing needs 133KB of index until someone actually searches,
  // and every page in the app mounts this component.
  useEffect(() => {
    if (!open || cached) return
    let live = true
    loadIndex().then(
      (rows) => {
        if (live) setIndex(rows)
      },
      () => {
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [open])

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) {
      // Empty query offers the clubs. It is the only 20-item list here, so it is genuinely
      // useful as a starting point rather than filler.
      return index.filter((e) => e.kind === 'team').sort((a, b) => a.label.localeCompare(b.label))
    }
    return index
      .map((e) => ({ e, s: score(e, needle) }))
      .filter((r): r is { e: SearchEntry; s: number } => r.s !== null)
      .sort((a, b) => b.s - a.s || b.e.weight - a.e.weight)
      .slice(0, 12)
      .map((r) => r.e)
  }, [index, q])

  function go(entry: SearchEntry) {
    setOpen(false)
    router.push(entry.kind === 'team' ? `/team/${entry.code}` : `/player/${entry.code}`)
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex h-7 items-center gap-2 rounded-lg border px-2.5 text-[12px]"
        style={{ background: 'var(--surface-2)', borderColor: 'var(--border)', color: 'var(--faint)' }}
      >
        <span>Search</span>
        <kbd
          className="rounded px-1 text-[10px]"
          style={{ background: 'var(--surface)', color: 'var(--faint)' }}
        >
          ⌘K
        </kbd>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[100] flex items-start justify-center p-4 pt-[12vh]"
          style={{ background: 'var(--scrim)' }}
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-lg overflow-hidden rounded-xl border"
            style={{ background: 'var(--surface)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setCursor(0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setCursor((c) => Math.min(c + 1, results.length - 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setCursor((c) => Math.max(c - 1, 0))
                } else if (e.key === 'Enter' && results[cursor]) {
                  go(results[cursor])
                }
              }}
              placeholder="Player or club…"
              className="w-full border-b px-4 py-3 text-[14px] outline-none"
              style={{ background: 'transparent', borderColor: 'var(--border)' }}
            />
            <div className="max-h-[60vh] overflow-y-auto">
              {/* Three different reasons for an empty list, and they are not interchangeable:
                  the index is still arriving, it never arrived, or it arrived and nothing
                  matched. */}
              {results.length === 0 && (
                <p className="px-4 py-6 text-center text-[13px]" style={{ color: 'var(--muted)' }}>
                  {failed ? (
                    'Could not load the search index.'
                  ) : index.length === 0 ? (
                    'Loading players and clubs…'
                  ) : (
                    <>Nothing matches &ldquo;{q}&rdquo;.</>
                  )}
                </p>
              )}
              {results.map((e, i) => (
                <button
                  key={`${e.kind}-${e.code}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => go(e)}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
                  style={{
                    background:
                      i === cursor
                        ? 'color-mix(in oklab, var(--accent) 14%, var(--surface))'
                        : 'transparent',
                  }}
                >
                  {e.kind === 'player' ? (
                    <PlayerPhoto
                      playerCode={e.code}
                      name={e.label}
                      size={26}
                      accent={POSITION_VAR[e.position ?? 'MID']}
                    />
                  ) : (
                    <span
                      className="flex h-[26px] w-[26px] shrink-0 items-center justify-center"
                      data-tip={e.label}
                    >
                      {/* The crest, not the three-letter code. A club is the one thing in this
                          app with a universally recognised picture; searching "eve" and seeing
                          Everton's badge confirms the hit faster than reading "EVE" does. */}
                      <TeamBadge teamCode={e.teamCode} name={e.label} size={22} />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{e.label}</span>
                    {e.sublabel && (
                      <span className="block truncate text-[11px]" style={{ color: 'var(--faint)' }}>
                        {e.sublabel}
                      </span>
                    )}
                  </span>
                  <span
                    className="shrink-0 text-[9px] font-semibold uppercase tracking-wide"
                    style={{ color: 'var(--faint)' }}
                  >
                    {e.kind}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
