'use client'

import { useEffect, useRef, useState } from 'react'
import { findTrigger, resolveTip } from '@/lib/tooltip'
import type { Tip } from '@/lib/tooltip'

/**
 * One tooltip for the whole app.
 *
 * Mounted once in the root layout and driven by delegated events, so a trigger costs one data
 * attribute and no client boundary — see `lib/tooltip.ts` for why that shape was necessary.
 *
 * WHAT THIS FIXES BEYOND LOOKS. The native `title` attribute does not appear on keyboard focus
 * in any browser, so every explanation in this app was mouse-only: the `P1` badge, the "no
 * shots" chip, the reason a cell is hatched rather than shaded. Tab to any of them and there
 * was nothing. This host listens for `focusin` as well as `pointerover` and shows the same
 * content either way, which is the rule the dataviz reference states outright.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. Touch. `title` never worked there either, and inventing a
 * long-press gesture inside a horizontally scrolling table is how you break scrolling. Safe to
 * skip only because of the rule below.
 *
 * TOOLTIPS ENHANCE, THEY NEVER GATE. Every number a tooltip shows is already on screen or in
 * the table. Nothing here is the only route to a value, which is what makes both the touch gap
 * and a failed resolve survivable.
 */

/** Long enough that sweeping the pointer across a table stays quiet. */
const SHOW_DELAY = 110
const GAP = 8
const TIP_ID = 'app-tooltip'

type Anchor = { top: number; bottom: number; centre: number }
type Placed = { tip: Tip; anchor: Anchor }

export function TooltipHost() {
  const [placed, setPlaced] = useState<Placed | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const timer = useRef<number | null>(null)
  /** The element carrying aria-describedby, so it is cleaned up even after the pointer moves on. */
  const described = useRef<HTMLElement | null>(null)
  /** Whether a tooltip is on screen right now — read by the show path, not for rendering. */
  const open = useRef(false)

  useEffect(() => {
    function clearTimer() {
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
        timer.current = null
      }
    }

    function hide() {
      clearTimer()
      if (described.current) {
        described.current.removeAttribute('aria-describedby')
        described.current = null
      }
      open.current = false
      setPlaced(null)
    }

    function show(el: HTMLElement) {
      const tip = resolveTip(el)
      // Nothing to say. Leave whatever is showing alone rather than blanking the screen — a
      // resolver returning null is a normal outcome for an identity cell.
      if (!tip) return
      const r = el.getBoundingClientRect()
      // Anchored to the element, not the pointer: a tooltip that chases the cursor shimmers
      // while you read it, and the anchor is the thing being explained.
      setPlaced({ tip, anchor: { top: r.top, bottom: r.bottom, centre: r.left + r.width / 2 } })
      if (described.current && described.current !== el) {
        described.current.removeAttribute('aria-describedby')
      }
      el.setAttribute('aria-describedby', TIP_ID)
      described.current = el
      open.current = true
    }

    function onPointerOver(e: PointerEvent) {
      // Touch gets nothing rather than a gesture that fights the scroll container.
      if (e.pointerType === 'touch') return
      const el = findTrigger(e.target)
      if (!el || el === described.current) return
      clearTimer()
      // Already reading one? Move straight to the next. The delay exists to stay quiet while
      // the pointer is merely crossing the table, and that argument is spent once it stopped.
      if (open.current) show(el)
      else timer.current = window.setTimeout(() => show(el), SHOW_DELAY)
    }

    function onPointerOut(e: PointerEvent) {
      if (e.pointerType === 'touch') return
      const el = findTrigger(e.target)
      if (!el) return
      // Ignore movement inside the same trigger.
      const to = e.relatedTarget
      if (to instanceof Node && el.contains(to)) return
      // Moving to another trigger: let the over handler swap the content instead of a
      // hide-then-show, which would flicker.
      if (to instanceof Element && to.closest('[data-tip], [data-tip-c]')) {
        clearTimer()
        return
      }
      hide()
    }

    function onFocusIn(e: FocusEvent) {
      const el = findTrigger(e.target)
      if (!el) return
      clearTimer()
      // No delay on focus: a keyboard user asked for this element explicitly.
      show(el)
    }

    function onKeyDown(e: KeyboardEvent) {
      // Escape dismisses without moving the pointer — the way out of a tooltip that is
      // covering the thing you wanted to read.
      if (e.key === 'Escape') hide()
    }

    // Capture, so a trigger inside a component that stops propagation still reaches us.
    document.addEventListener('pointerover', onPointerOver, true)
    document.addEventListener('pointerout', onPointerOut, true)
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('focusout', hide, true)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', hide, true)
    // A tooltip anchored to a rect is wrong the moment anything scrolls. Hiding is honest and
    // cheap; repositioning every scroll frame is neither.
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)

    return () => {
      clearTimer()
      document.removeEventListener('pointerover', onPointerOver, true)
      document.removeEventListener('pointerout', onPointerOut, true)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', hide, true)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', hide, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [])

  // Flip and clamp after measuring, rather than estimating: a tooltip running off the right
  // edge of a wide table is the common case here, not the corner one.
  useEffect(() => {
    const el = box.current
    if (!el || !placed) return
    const r = el.getBoundingClientRect()
    const { top, bottom, centre } = placed.anchor
    const x = Math.max(GAP, Math.min(centre - r.width / 2, window.innerWidth - r.width - GAP))
    const below = top - r.height - GAP < 0
    el.style.left = `${x}px`
    el.style.top = `${below ? bottom + GAP : top - r.height - GAP}px`
    el.style.visibility = 'visible'
  }, [placed])

  if (!placed) return null
  const { tip } = placed

  return (
    <div
      ref={box}
      id={TIP_ID}
      role="tooltip"
      className="tip"
      // Hidden until measured, so it never flashes at an unplaced position first.
      style={{ visibility: 'hidden' }}
    >
      <div className="tip-title">{tip.title}</div>

      {tip.value && <div className="tip-value num">{tip.value}</div>}
      {tip.note && <div className="tip-note">{tip.note}</div>}

      {tip.rows && tip.rows.length > 0 && (
        <dl className="tip-rows">
          {tip.rows.map((r) => (
            <div key={r.label} className="tip-row">
              <dt>{r.label}</dt>
              <dd
                className="num"
                style={{
                  color:
                    r.tone === 'good' ? 'var(--ok)'
                      : r.tone === 'bad' ? 'var(--danger)'
                        : r.tone === 'muted' ? 'var(--faint)'
                          : 'var(--text)',
                }}
              >
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {tip.why && <p className="tip-why">{tip.why}</p>}
    </div>
  )
}
