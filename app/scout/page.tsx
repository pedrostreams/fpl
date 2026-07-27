import { permanentRedirect } from 'next/navigation'

/**
 * `/scout` is now the Overview preset of `/players`.
 *
 * Kept as a route rather than deleted: it is the URL Peder has been opening for weeks, it is
 * linked from the dashboard, and a redirect costs nothing next to a dead bookmark. The old
 * `components/scout-table.tsx` went with it — everything it did, the composed table does with
 * a column set instead of hardcoded columns.
 */
export default function ScoutPage(): never {
  permanentRedirect('/players?view=overview')
}
