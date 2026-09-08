'use client'

import { PlayerIdentity } from '@/components/player-identity'
import { useUserState } from '@/components/user-state'
import { fmtInt, fmtPct, fmtPrice } from '@/lib/format'

/**
 * "What am I buying next?" — step 5 of the gameweek brief.
 *
 * The dashboard's panel and this one show the same watchlist and deliberately not the same
 * figures: there, the next fixture's ease, because the question is who to look at; here, net
 * transfers, because the question is what a transfer costs you if you wait. Two call sites, two
 * shapes, rather than one component with a mode flag.
 *
 * Client-side for the same reason as the dashboard's: the page is prerendered, and the watchlist
 * is the only thing on it a visitor can change. See components/user-state.tsx.
 */
export function WatchlistBrief({ limit = 5 }: { limit?: number }) {
  const { watchlist, ready, failed } = useUserState()

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
        {failed ? (
          <>Could not read your watchlist just now. Every other step on this page is unaffected.</>
        ) : !ready ? (
          <>Reading your watchlist…</>
        ) : watchlist.length === 0 ? (
          <>
            Nothing saved. Heart a player anywhere in the app and he appears here with his next
            fixture and ownership drift, which is the pair of facts a transfer decision needs.
          </>
        ) : (
          <>
            {watchlist.length} saved.{' '}
            {watchlist.some((w) => (w.netTransfersEvent ?? 0) !== 0)
              ? 'Ownership is moving, so watch the price.'
              : 'Prices are frozen until the first deadline, so nothing is moving yet.'}
          </>
        )}
      </p>
      {watchlist.slice(0, limit).map((w) => (
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
            </>
          }
          right={
            <span className="num text-[12px]" style={{ color: 'var(--muted)' }}>
              {fmtInt(w.netTransfersEvent)}
              <span className="ml-1 text-[10px]" style={{ color: 'var(--faint)' }}>
                net
              </span>
            </span>
          }
        />
      ))}
    </div>
  )
}
