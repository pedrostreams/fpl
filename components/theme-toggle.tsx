'use client'

import { useEffect, useState } from 'react'
import { THEME_CHOICES, THEME_KEY, type ThemeChoice } from '@/lib/theme'

/**
 * The theme control. Three segments, because the CSS has three states and collapsing them would
 * throw one away: forcing a binary light/dark would make "follow the OS" unreachable the moment
 * the user touched the control once.
 *
 * WHY THE ACTIVE SEGMENT IS STYLED IN CSS AND NOT FROM STATE. The server cannot know what is in
 * `localStorage`, so a state-driven highlight has only bad options: seed it from storage and
 * hydration mismatches, or seed it with a default and the "Auto" pill lights up for a frame
 * before jumping — the same flash `lib/theme.ts` goes to some trouble to avoid on the page
 * itself, reintroduced in the widget that exists to prevent it. Instead `globals.css` selects
 * the active segment off `<html data-theme>`, which the pre-paint script has already stamped.
 * Same trick as the heatmap: the theme swaps CSS variables, nothing re-renders.
 *
 * `choice` below therefore drives **only** what CSS cannot express — `aria-pressed`, and the
 * resolved value in the Auto tooltip. It is seeded with the value the server rendered so the
 * first client render is byte-identical, then corrected in an effect.
 *
 * No icon. DESIGN.md §8 has no icon set, and the sun/moon pair is the one place a codebase
 * usually acquires one; three words are unambiguous and need no legend.
 */

const LABEL: Record<ThemeChoice, string> = {
  system: 'Auto',
  light: 'Light',
  dark: 'Dark',
}

/** What each segment does, in the tooltip contract's title → value → note order. */
const NOTE: Record<ThemeChoice, string> = {
  system: 'Follows the operating system, and changes with it.',
  light: 'Always light, whatever the system is set to.',
  dark: 'Always dark. The default — a percentile heatmap reads better on a dark surface.',
}

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>('system')
  /** null until mounted: on the server there is no OS preference to report. */
  const [systemIs, setSystemIs] = useState<'light' | 'dark' | null>(null)

  useEffect(() => {
    const stored = document.documentElement.dataset.theme
    setChoice(stored === 'light' || stored === 'dark' ? stored : 'system')

    // Mirrors the media query in globals.css exactly — `light` or not-light, so a browser
    // reporting no-preference resolves to dark in both places rather than disagreeing.
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const read = () => setSystemIs(mq.matches ? 'light' : 'dark')
    read()
    // Kept live so the Auto tooltip cannot claim "currently dark" after the OS went light.
    mq.addEventListener('change', read)
    return () => mq.removeEventListener('change', read)
  }, [])

  function pick(next: ThemeChoice) {
    // Attribute first: this is what actually repaints, and it must not wait on React.
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      // Private mode. The choice holds for this page and is forgotten on reload, which beats
      // refusing to switch at all.
    }
    setChoice(next)
  }

  return (
    <div className="theme-switch" role="group" aria-label="Colour theme">
      {THEME_CHOICES.map((c) => (
        <button
          key={c}
          type="button"
          className="theme-opt"
          data-theme-opt={c}
          aria-pressed={choice === c}
          data-tip={LABEL[c]}
          // Only Auto has something the label doesn't already say.
          data-tip-value={c === 'system' && systemIs ? LABEL[systemIs] : undefined}
          data-tip-note={NOTE[c]}
          onClick={() => pick(c)}
        >
          {LABEL[c]}
        </button>
      ))}
    </div>
  )
}
