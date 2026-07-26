/**
 * The mark, in-app. Identical geometry to `app/icon.svg` — deliberately, so the browser tab and
 * the header read as the same thing — but filled with `var(--accent)` rather than literal hex,
 * which the favicon cannot do because it renders with no page context.
 *
 * A pentagon is the black panel of a classic football, and it survives being shrunk in a way a
 * whole ball does not. Three bars are knocked out of it and the tallest is wider than the other
 * two: the crowd sees three players, the model sees the one worth having.
 *
 * The knockouts are true transparency via `fill-rule="evenodd"`, so whatever is behind shows
 * through. In the header that is the translucent backdrop, which is what makes the mark sit in
 * the bar rather than on it.
 *
 * DESIGN.md §8 says "no icon set", and that still holds — this is a single wordmark, not the
 * start of an icon system. A second glyph would be a decision to make deliberately rather than
 * by precedent.
 */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path
        fill="var(--accent)"
        fillRule="evenodd"
        d="M16 2.6 28.8 11.9 23.9 27 8.1 27 3.2 11.9Z
           M8.9 18.7h3.1v4.7H8.9z
           M13.5 15h3.1v8.4h-3.1z
           M18.1 10.6h5v12.8h-5z"
      />
    </svg>
  )
}
