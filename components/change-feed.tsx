'use client'

import { useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from '@/lib/queries'
import { PlayerIdentity } from '@/components/player-identity'
import { TeamBadge } from '@/components/team-badge'
import { fmt, fmtSigned } from '@/lib/format'

/**
 * The feed, with a read position.
 *
 * **Why this is a client component and why it writes to `localStorage`.** DESIGN.md §8 says theme
 * is the one thing allowed in local storage, and that it earns the exception by being a property
 * of the reader rather than of the question they are asking. A read position makes the same
 * argument and Peder accepted it on 2026-07-30: where you got to is a fact about you, not about
 * the data. Nothing else here persists — the filter below dies on reload, as filters do.
 *
 * The server still renders every row. The stored timestamp only decides which ones are marked,
 * so the page is complete and correct with JavaScript disabled and the marking is an enhancement
 * rather than the content.
 */

const KEY = 'fpl.changed.lastSeen'

const KIND_LABEL: Record<ChangeEvent['kind'], string> = {
  price: 'Price',
  availability: 'Fitness',
  set_piece: 'Set pieces',
  market: 'Market',
}

type Filter = 'all' | 'mine' | 'watched'

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Oslo',
  })
}

function Line({ e, fresh }: { e: ChangeEvent; fresh: boolean }) {
  const sentence = (() => {
    switch (e.kind) {
      case 'price':
        return `${(e.delta ?? 0) > 0 ? 'Rose' : 'Fell'} to £${e.after}m`
      case 'availability':
        // The status letter is FPL's; the note is the reason, and the reason is what you act on.
        return e.note ?? `${e.before} → ${e.after}`
      case 'set_piece':
        return `Order changed — ${e.note} (${e.before} → ${e.after})`
      case 'market':
        return `Win probability ${e.before} → ${e.after} ${e.note ?? ''}`
    }
  })()

  return (
    <div
      className="flex items-start gap-3 border-b py-2 last:border-b-0"
      style={
        fresh ? { background: 'color-mix(in oklab, var(--accent) 6%, transparent)' } : undefined
      }
    >
      <span
        className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: fresh ? 'var(--accent)' : 'transparent' }}
        aria-label={fresh ? 'new since your last visit' : undefined}
      />
      <span
        className="w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: 'var(--faint)' }}
      >
        {KIND_LABEL[e.kind]}
      </span>
      <div className="min-w-0 flex-1">
        {e.playerCode !== null && e.webName ? (
          <PlayerIdentity
            playerCode={e.playerCode}
            name={e.webName}
            position={e.position ?? ''}
            teamCode={e.teamCode ?? 0}
            teamShort={e.teamShort ?? ''}
            wrap={false}
            sub={<span style={{ color: 'var(--muted)' }}>{sentence}</span>}
          />
        ) : (
          <div className="flex items-center gap-2">
            {e.teamCode !== null && (
              <TeamBadge teamCode={e.teamCode} name={e.teamShort ?? ''} size={16} />
            )}
            <span className="text-[13px] font-medium">{e.teamShort}</span>
            <span className="text-[12px]" style={{ color: 'var(--muted)' }}>
              {sentence}
            </span>
          </div>
        )}
      </div>
      <span className="shrink-0 text-right">
        {e.delta !== null && e.kind !== 'availability' && (
          <span
            className="num mr-3 text-[12px]"
            style={{
              color:
                (e.delta ?? 0) > 0 ? 'var(--ok)' : (e.delta ?? 0) < 0 ? 'var(--warn)' : 'var(--faint)',
            }}
          >
            {e.kind === 'price' ? fmtSigned(e.delta, 1) : fmtSigned((e.delta ?? 0) * 100, 0)}
          </span>
        )}
        <span className="num text-[11px]" style={{ color: 'var(--faint)' }}>
          {when(e.at)}
        </span>
      </span>
    </div>
  )
}

export function ChangeFeed({ events }: { events: ChangeEvent[] }) {
  // Null until the effect runs, so the first server-rendered frame marks nothing rather than
  // marking everything — a page that flashes "all new" on every load is worse than no marking.
  const [lastSeen, setLastSeen] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')

  useEffect(() => {
    setLastSeen(window.localStorage.getItem(KEY))
    // Stamped on mount rather than on unmount: an unmount handler does not run on a closed tab,
    // and a read position that only sometimes saves is worse than one that always does.
    const newest = events[0]?.at
    if (newest) window.localStorage.setItem(KEY, newest)
    // Deliberately once per mount. Re-running on `events` would re-stamp during a revalidation
    // and silently mark everything as read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const shown = useMemo(
    () =>
      events.filter((e) =>
        filter === 'mine' ? e.isMine : filter === 'watched' ? e.isWatched : true,
      ),
    [events, filter],
  )

  const freshCount = lastSeen ? events.filter((e) => e.at > lastSeen).length : 0

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'mine', 'watched'] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className="rounded-full px-3 py-1 text-[12px] font-medium transition-colors"
            style={{
              background: filter === f ? 'var(--surface-2)' : 'transparent',
              color: filter === f ? 'var(--text)' : 'var(--muted)',
            }}
          >
            {f === 'all' ? 'Everything' : f === 'mine' ? 'My squad' : 'Watchlist'}
          </button>
        ))}
        <span className="ml-auto text-[11px]" style={{ color: 'var(--faint)' }}>
          {lastSeen === null
            ? `${events.length} events`
            : freshCount === 0
              ? 'Nothing new since your last visit'
              : `${freshCount} new since your last visit`}
        </span>
      </div>

      {shown.length === 0 ? (
        <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
          {filter === 'mine'
            ? 'Nothing has moved in your squad. Before the GW1 deadline there is no squad to move, so this stays empty until 21 August.'
            : filter === 'watched'
              ? 'Nothing has moved on your watchlist.'
              : 'Nothing has moved yet.'}
        </p>
      ) : (
        <div className="flex flex-col">
          {shown.map((e, i) => (
            <Line
              key={`${e.kind}-${e.at}-${e.playerCode ?? e.teamCode}-${i}`}
              e={e}
              fresh={lastSeen !== null && e.at > lastSeen}
            />
          ))}
        </div>
      )}
      <p className="text-[11px]" style={{ color: 'var(--faint)' }}>
        {fmt(events.length, 0)} events held. Price and ownership come from the hourly capture,
        which writes a row only when something moves — so a quiet stretch here is a fact about the
        market, not about the job. Liveness lives on Status.
      </p>
    </div>
  )
}
