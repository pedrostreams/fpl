'use client'

import { Metric, Panel } from '@/components/dash'
import { PlayerIdentity } from '@/components/player-identity'
import { useUserState } from '@/components/user-state'
import { WatchButton } from '@/components/watch-button'
import { fmt, fmtInt, fmtPct, fmtPrice } from '@/lib/format'

/**
 * The dashboard's watchlist, on the client.
 *
 * This was server-rendered from `getWatchlist()` until the move to Cloudflare, and it is the one
 * panel that could not stay that way: the dashboard is prerendered at deploy time now, and a
 * watchlist baked into HTML built an hour ago would show a player you had since removed. Public
 * football data can be a static file because only the sync changes it; this cannot, because you
 * change it.
 *
 * So it renders three states rather than one, and says which it is in. "Reading" is not the same
 * claim as "nothing saved", and neither is the same as "the read failed" — an empty panel that
 * silently means "the request 500ed" is the failure mode worth spending a sentence to avoid.
 */
export function WatchlistPanel() {
  const { watchlist, ready, failed } = useUserState()

  const lead = failed
    ? 'Could not read your watchlist just now. The rest of this page is unaffected — it is built from the sync, not from you.'
    : !ready
      ? 'Reading your watchlist…'
      : watchlist.length === 0
        ? 'Nothing saved. Heart a player anywhere in the app and they appear here with their next fixture.'
        : `${watchlist.length} saved. Their next fixture and ownership drift, so you can decide without leaving this page.`

  return (
    <Panel title="Your watchlist" href="/players" hrefLabel="Find players" lead={lead}>
      {watchlist.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {watchlist.map((w) => (
            <PlayerIdentity
              key={w.playerCode}
              playerCode={w.playerCode}
              name={w.webName}
              position={w.position}
              teamCode={w.teamCode}
              teamShort={w.teamShort}
              status={w.status}
              news={w.news}
              opponent={{ short: w.opponentShort, isHome: w.isHome }}
              sub={
                <>
                  {fmtPrice(w.price)} · {fmtPct(w.selectedByPercent)} owned
                  {w.nextDifficulty !== null && ` · ${(1 - w.nextDifficulty).toFixed(2)} ease`}
                </>
              }
              right={
                <span className="num text-[12px]" style={{ color: 'var(--muted)' }}>
                  {fmt(w.xgiPer90, 3)}
                  <span className="ml-1 text-[10px]" style={{ color: 'var(--faint)' }}>
                    xGI
                  </span>
                </span>
              }
              action={<WatchButton playerCode={w.playerCode} />}
            />
          ))}
        </div>
      )}
    </Panel>
  )
}

/**
 * The count in the strip at the top of the dashboard.
 *
 * An em dash until the fetch settles, rather than a confident 0 that turns into 7 — the strip is
 * meant to be the four facts you trust before reading anything else.
 */
export function WatchlistMetric() {
  const { watchlist, ready, failed } = useUserState()

  if (failed) return <Metric label="Watchlist" value="—" hint="could not be read" tone="warn" />

  return (
    <Metric
      label="Watchlist"
      value={ready ? fmtInt(watchlist.length) : '—'}
      hint={!ready ? 'reading…' : watchlist.length === 0 ? 'nothing saved yet' : 'players saved'}
    />
  )
}
