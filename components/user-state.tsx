'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { SavedView, WatchRow } from '@/lib/queries'

/**
 * The watchlist and the saved views, fetched in the browser rather than baked into the page.
 *
 * Every other number in this app is public football data that changes only when the Python sync
 * runs, so it is prerendered at build time and served as a static file — that is what makes the
 * site free to host and instant to open. These two are different in kind: they are the only
 * things a visitor can change, so HTML built an hour ago would show a heart that had since been
 * un-hearted, and a saved view that had since been renamed.
 *
 * So the pages render without them and this provider fills them in on mount, from
 * /api/user-state. The cost is one small request per visit and a heart that is briefly hollow
 * on a cold load; the alternative was rebuilding the entire site on every click.
 *
 * Writes are optimistic and then authoritative: the click updates `overlay` so the heart
 * responds immediately, the POST happens, and the reply is followed by a re-read of the whole
 * list — because the dashboard panel shows a hearted player's next fixture and ownership drift,
 * which the client cannot invent. On failure the overlay entry is dropped and the heart snaps
 * back to whatever the server last said, which is the honest thing to show.
 */

type Save = (input: {
  id?: number
  name: string
  columns: string[]
  filters: Record<string, unknown>
  sortKey: string | null
  sortDesc: boolean
}) => Promise<{ ok: boolean; error?: string; id?: number }>

type UserState = {
  /** False until the first fetch settles, so panels can hold their shape instead of flashing. */
  ready: boolean
  /** The watchlist could not be read. Panels say so rather than claiming it is empty. */
  failed: boolean
  watchlist: WatchRow[]
  watched: Set<number>
  views: SavedView[]
  toggle: (playerCode: number) => void
  saveView: Save
  deleteView: (id: number) => Promise<void>
}

const EMPTY: UserState = {
  ready: false,
  failed: false,
  watchlist: [],
  watched: new Set(),
  views: [],
  toggle: () => {},
  saveView: async () => ({ ok: false, error: 'Not ready yet.' }),
  deleteView: async () => {},
}

const Context = createContext<UserState>(EMPTY)

export function UserStateProvider({ children }: { children: React.ReactNode }) {
  const [watchlist, setWatchlist] = useState<WatchRow[]>([])
  const [views, setViews] = useState<SavedView[]>([])
  // Codes the user has just clicked, layered over what the server said. Cleared by every
  // successful read, at which point the server's answer is the only truth again.
  const [overlay, setOverlay] = useState<Record<number, boolean>>({})
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/user-state', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { watchlist?: WatchRow[]; views?: SavedView[] }
      setWatchlist(data.watchlist ?? [])
      setViews(data.views ?? [])
      setOverlay({})
      setFailed(false)
    } catch (e) {
      console.error('[user-state] could not load', e)
      setFailed(true)
    } finally {
      setReady(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const watched = useMemo(() => {
    const set = new Set(watchlist.map((w) => w.playerCode))
    for (const [code, on] of Object.entries(overlay)) {
      if (on) set.add(Number(code))
      else set.delete(Number(code))
    }
    return set
  }, [watchlist, overlay])

  // `toggle` must see the current set without being rebuilt on every change to it — a new
  // callback identity per keystroke would re-render every heart on a 558-row table.
  const watchedRef = useRef(watched)
  watchedRef.current = watched

  const toggle = useCallback(
    (playerCode: number) => {
      const next = !watchedRef.current.has(playerCode)
      setOverlay((o) => ({ ...o, [playerCode]: next }))
      void (async () => {
        try {
          const res = await fetch('/api/watchlist', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ playerCode }),
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          await load()
        } catch (e) {
          console.error('[user-state] could not toggle', e)
          setOverlay((o) => {
            const copy = { ...o }
            delete copy[playerCode]
            return copy
          })
        }
      })()
    },
    [load],
  )

  const saveView = useCallback<Save>(
    async (input) => {
      try {
        const res = await fetch('/api/views', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        })
        const result = (await res.json()) as { ok: boolean; error?: string; id?: number }
        if (result.ok) await load()
        return result
      } catch (e) {
        console.error('[user-state] could not save view', e)
        return { ok: false, error: 'Could not save that view.' }
      }
    },
    [load],
  )

  const deleteView = useCallback(
    async (id: number) => {
      try {
        const res = await fetch(`/api/views?id=${id}`, { method: 'DELETE' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await load()
      } catch (e) {
        console.error('[user-state] could not delete view', e)
      }
    },
    [load],
  )

  const value = useMemo<UserState>(
    () => ({ ready, failed, watchlist, watched, views, toggle, saveView, deleteView }),
    [ready, failed, watchlist, watched, views, toggle, saveView, deleteView],
  )

  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useUserState(): UserState {
  return useContext(Context)
}
