/**
 * The tooltip contract.
 *
 * WHY A DELEGATED HOST AND NOT A COMPONENT PER TRIGGER. `/players` renders 558 rows across up
 * to 15 metric columns, so a `<Tooltip>` wrapper on each cell would be ~8 000 components each
 * holding open/closed state and a positioning effect. That is not a tuning problem, it is the
 * wrong shape. Instead: one host, mounted once in the root layout, listening on `document`.
 * A trigger is any element carrying `data-tip` — which a **server** component can emit, so
 * this costs no client boundary anywhere it is used.
 *
 * TWO WAYS TO SUPPLY CONTENT, and the second is the reason this file exists:
 *
 *   1. `data-tip="…"` (+ optional `data-tip-note`, `data-tip-why`). Static text in attributes.
 *      Right for a badge, a chip, a column header.
 *
 *   2. `data-tip-src="<name>"` on any ancestor. A client component that already holds the data
 *      registers a resolver under that name, and the host calls it with the hovered element.
 *      Right for a table: the cell carries a 14-byte `data-tip-c` instead of a serialised
 *      tooltip, and the content can be as rich as the component's memory allows — the value,
 *      the metric's definition, its rank within the *filtered* set, the pool size, and the
 *      reason the metric exists. None of that has to cross the wire twice.
 *
 * A module-level registry rather than React context because the host is an ancestor of every
 * trigger, and context only flows down. The alternative — lifting the table's data to the
 * layout — would put 558 rows in a server component that has no other use for them.
 *
 * SAFETY. Every field here is rendered as a React child, never as HTML. That is not incidental:
 * `news` comes straight from the FPL API and club and player names come from three different
 * sources, so tooltip content is untrusted by default. There is no `dangerouslySetInnerHTML`
 * in the host and there must never be one.
 */

export type TipTone = 'good' | 'bad' | 'muted'

export type TipRow = {
  label: string
  value: string
  tone?: TipTone
}

export type Tip = {
  /** What this is. Rendered small and secondary — the reader already knows what they pointed at. */
  title: string
  /**
   * The number, rendered large.
   *
   * Values lead and labels follow, which is the legend's hierarchy inverted: a legend answers
   * "which series is this colour", a tooltip answers "what is the number here". The reader
   * already has the series.
   */
  value?: string
  /** One line of context under the value. */
  note?: string
  rows?: TipRow[]
  /** Why the metric exists at all — `Column.why` from the catalogue. Set in italics, last. */
  why?: string
}

type Resolver = (el: HTMLElement) => Tip | null

const RESOLVERS = new Map<string, Resolver>()

/**
 * Register a content source. Returns the unregister function, so a component can call this in
 * an effect and clean up on unmount — two mounted tables would otherwise fight over one name,
 * and in dev React's double-invoked effects make that a real sequence rather than a hypothesis.
 */
export function registerTipSource(name: string, fn: Resolver): () => void {
  RESOLVERS.set(name, fn)
  return () => {
    // Only delete our own registration; a remount may have already replaced it.
    if (RESOLVERS.get(name) === fn) RESOLVERS.delete(name)
  }
}

/** The trigger an event landed on, if any. */
export function findTrigger(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  return target.closest<HTMLElement>('[data-tip], [data-tip-c]')
}

export function resolveTip(el: HTMLElement): Tip | null {
  // A resolver wins over static text: a cell inside a registered table may also carry a plain
  // `data-tip` fallback for the case where the resolver has nothing to say.
  const host = el.closest<HTMLElement>('[data-tip-src]')
  const src = host?.dataset.tipSrc
  if (src) {
    const fn = RESOLVERS.get(src)
    if (fn) {
      const tip = fn(el)
      if (tip) return tip
    }
  }

  const title = el.dataset.tip
  if (!title) return null
  return {
    title,
    value: el.dataset.tipValue || undefined,
    note: el.dataset.tipNote || undefined,
    rows: parseRows(el.dataset.tipRows),
    why: el.dataset.tipWhy || undefined,
  }
}

/**
 * `data-tip-rows='[["Win","72%"],["xG","1.84","good"]]'` — compact tuples, not objects, because
 * this ships in the HTML.
 *
 * WHY THIS EXISTS ALONGSIDE RESOLVERS. It is the only route to a *rich* tooltip from a server
 * component, which cannot register anything. The fixture ticker has 120 cells each with five
 * facts; serialising them costs a few KB of highly repetitive markup and no client code. The
 * players table has ~8 000 cells, where the same trick would be megabytes — hence the resolver.
 * Scale picks the mechanism, and 120 is not 8 000.
 *
 * Parsed defensively: a malformed attribute must lose one tooltip, not break hovering for the
 * whole page. The result is rendered as React children, so it is escaped like everything else.
 */
function parseRows(raw: string | undefined): TipRow[] | undefined {
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return undefined
    const out: TipRow[] = []
    for (const item of parsed) {
      if (!Array.isArray(item) || item.length < 2) continue
      out.push({
        label: String(item[0]),
        value: String(item[1]),
        tone: item[2] === 'good' || item[2] === 'bad' || item[2] === 'muted' ? item[2] : undefined,
      })
    }
    return out.length ? out : undefined
  } catch {
    return undefined
  }
}

/** Build the attribute value. Kept here so callers never hand-write the JSON. */
export function tipRows(
  rows: ([string, string] | [string, string, TipTone] | null | false | undefined)[],
): string | undefined {
  const kept = rows.filter((r): r is [string, string] | [string, string, TipTone] => Boolean(r))
  return kept.length ? JSON.stringify(kept) : undefined
}
