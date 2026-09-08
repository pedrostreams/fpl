'use client'

import { useUserState } from '@/components/user-state'

/**
 * The heart.
 *
 * Takes only a player code: whether he is watched comes from the provider, not from a prop.
 * That is what keeps the hearts in step — the same player can be on screen twice, in the
 * dashboard's watchlist panel and in the captain shortlist below it, and a build-time prop had
 * them disagreeing the moment one was clicked.
 *
 * The optimism lives in the provider too, for the same reason. It was `useOptimistic` here
 * while the write was a server action that revalidated the page and sent the authoritative
 * value back as a new prop; there is no page revalidation any more, because the page is a
 * static file. The provider updates its own overlay on click, POSTs, then re-reads the list.
 *
 * Dimmed until the first read settles, because before it lands "not watched" is a guess rather
 * than a fact, and a hollow heart that fills itself half a second later reads as broken.
 */
export function WatchButton({ playerCode, size = 15 }: { playerCode: number; size?: number }) {
  const { watched, ready, toggle } = useUserState()
  const on = watched.has(playerCode)

  return (
    <button
      type="button"
      aria-pressed={on}
      aria-busy={!ready}
      aria-label={on ? 'Remove from watchlist' : 'Save to watchlist'}
      data-tip={on ? 'On your watchlist — click to remove' : 'Save to your watchlist'}
      onClick={(e) => {
        // The row itself may be clickable for sorting; a heart click is not a row click.
        e.stopPropagation()
        toggle(playerCode)
      }}
      className="inline-flex shrink-0 items-center justify-center rounded transition-opacity"
      style={{ opacity: ready ? 1 : 0.4, cursor: 'pointer', lineHeight: 0 }}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <path
          d="M12 20.5 4.2 12.9a4.9 4.9 0 0 1 0-6.9 4.7 4.7 0 0 1 6.7 0l1.1 1.1 1.1-1.1a4.7 4.7 0 0 1 6.7 0 4.9 4.9 0 0 1 0 6.9Z"
          fill={on ? 'var(--danger)' : 'none'}
          stroke={on ? 'var(--danger)' : 'var(--faint)'}
          strokeWidth={1.8}
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}
