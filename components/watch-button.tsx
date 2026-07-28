'use client'

import { useOptimistic, useTransition } from 'react'
import { toggleWatchlist } from '@/lib/actions'

/**
 * The heart. Optimistic, because a save that waits on a round trip to Supabase feels broken
 * even when it works — and the only failure mode is a code that doesn't exist, which the UI
 * cannot produce.
 *
 * `useOptimistic` rather than local `useState`: the server action revalidates the page, so the
 * authoritative value arrives as a new prop. Plain state would then fight that prop and the
 * heart could end up disagreeing with the database after a fast double-click.
 */
export function WatchButton({
  playerCode,
  watched,
  size = 15,
}: {
  playerCode: number
  watched: boolean
  size?: number
}) {
  const [optimistic, setOptimistic] = useOptimistic(watched)
  const [pending, startTransition] = useTransition()

  return (
    <button
      type="button"
      aria-pressed={optimistic}
      aria-label={optimistic ? 'Remove from watchlist' : 'Save to watchlist'}
      data-tip={optimistic ? 'On your watchlist — click to remove' : 'Save to your watchlist'}
      onClick={(e) => {
        // The row itself may be clickable for sorting; a heart click is not a row click.
        e.stopPropagation()
        startTransition(async () => {
          setOptimistic(!optimistic)
          await toggleWatchlist(playerCode)
        })
      }}
      className="inline-flex shrink-0 items-center justify-center rounded transition-opacity"
      style={{ opacity: pending ? 0.5 : 1, cursor: 'pointer', lineHeight: 0 }}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <path
          d="M12 20.5 4.2 12.9a4.9 4.9 0 0 1 0-6.9 4.7 4.7 0 0 1 6.7 0l1.1 1.1 1.1-1.1a4.7 4.7 0 0 1 6.7 0 4.9 4.9 0 0 1 0 6.9Z"
          fill={optimistic ? 'var(--danger)' : 'none'}
          stroke={optimistic ? 'var(--danger)' : 'var(--faint)'}
          strokeWidth={1.8}
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}
