import type { FormMetric, PlayerForm } from '@/lib/queries'
import { fmt, fmtPct } from '@/lib/format'
import { tipRows } from '@/lib/tooltip'

/**
 * Recent form, rendered the way 0021 renders club style: as a measurement with an error bar and
 * two separate gates, not as a fact.
 *
 * The rule that is easy to get wrong, and the reason this component exists rather than a plain
 * table: **reliability governs whether the position can be ORDERED, not whether this player can
 * be described.** Botman hit the DEFCON threshold in all six of his last matches against a 36%
 * season rate — a z of 3.2 — on a metric whose six-match reliability is 0.49 and which therefore
 * carries no rank. Showing only ranked metrics would have silenced the most actionable line on
 * the page. So a moved metric prints its movement with no rank, and a ranked metric prints its
 * rank whether or not the player has moved.
 */

/**
 * A rate has to read as a rate. `defcon_hit` is a mean of zeros and ones, and at zero decimals
 * Botman's genuine 1.00-against-0.36 rendered as "1" against "0" — claiming he went from never
 * hitting the threshold to always, which is a different and wrong statement.
 */
function value(m: FormMetric, v: number | null): string {
  return m.asPercent ? fmtPct(v === null ? null : v * 100, 0) : fmt(v, m.decimals)
}

const POSITION_PLURAL: Record<string, string> = {
  GKP: 'goalkeepers',
  DEF: 'defenders',
  MID: 'midfielders',
  FWD: 'forwards',
}

function arrow(m: FormMetric): string {
  if (!m.separated) return '·'
  return (m.delta ?? 0) > 0 ? '↑' : '↓'
}

function Row({ m }: { m: FormMetric }) {
  const d = m.decimals
  return (
    <tr
      className="border-b last:border-b-0"
      data-tip={m.label}
      data-tip-value={`${value(m, m.window)} over the last six · ${value(m, m.season)} all season`}
      data-tip-rows={tipRows([
        ['Last 6 appearances', value(m, m.window)],
        ['Season', value(m, m.season)],
        ['His own error bar', `± ${fmt(m.stdError, Math.max(d, 2))}`],
        ['Gap in error bars', m.z === null ? '—' : fmt(m.z, 2)],
        [
          'Six-match reliability',
          m.reliability6 === null ? '—' : `${fmt(m.reliability6, 2)} within position`,
        ],
        ['Full-season reliability', m.reliabilitySeason === null ? '—' : fmt(m.reliabilitySeason, 2)],
        m.rank !== null && m.pool !== null
          ? ['Rank in position', `${m.rank} of ${m.pool}`]
          : ['Rank in position', 'not earned — too noisy over six matches'],
      ])}
      data-tip-why={
        m.separated
          ? 'Two or more of his own error bars clear of his season figure, so the change is bigger than his match-to-match noise.'
          : 'Inside his own match-to-match noise, so there is nothing here to read as a change.'
      }
    >
      <td className="w-6 py-1 text-[13px]" style={{ color: m.separated ? undefined : 'var(--faint)' }}>
        {arrow(m)}
      </td>
      <td className="w-44 py-1 pr-2 text-[12px]">{m.label}</td>
      <td className="num w-14 py-1 text-right text-[12px] font-medium">{value(m, m.window)}</td>
      <td className="num w-14 py-1 text-right text-[12px]" style={{ color: 'var(--faint)' }}>
        {value(m, m.season)}
      </td>
      <td className="py-1 pl-3 text-[12px]" style={{ color: 'var(--muted)' }}>
        {m.separated ? m.word : 'in line'}
        {/* The rank only appears where the metric earned one. Absent is absent — never a
            placeholder number, and never a dash implying a bad rank. */}
        {m.rank !== null && m.pool !== null && (
          <span style={{ color: 'var(--faint)' }}>
            {' · '}
            {m.rank} of {m.pool}
          </span>
        )}
      </td>
    </tr>
  )
}

export function PlayerFormSection({ form, position }: { form: PlayerForm; position: string }) {
  if (form.metrics.length === 0) {
    return (
      <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
        No window. This needs twelve league appearances last season to estimate his own
        match-to-match variance, and six of them in the window — 263 of 563 registered players do
        not have that, which is almost entirely new signings and the promoted clubs. Absent rather
        than zero: nothing is known here, which is different from nothing happening.
      </p>
    )
  }

  const moved = form.metrics.filter((m) => m.separated)
  const flat = form.metrics.filter((m) => !m.separated)
  const ranked = form.metrics.filter((m) => m.rankEarned).length

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
        {moved.length === 0 ? (
          <>
            Nothing has moved. All {form.metrics.length} measures sit inside his own match-to-match
            noise over the last six league games, which is the common and unexciting answer.
          </>
        ) : (
          <>
            <strong>
              {moved.length} of {form.metrics.length}
            </strong>{' '}
            measures have moved beyond his own noise:{' '}
            {moved.slice(0, 3).map((m, i) => (
              <span key={m.metric}>
                {i > 0 && ', '}
                {m.label.toLowerCase()} {(m.delta ?? 0) > 0 ? 'up' : 'down'}
              </span>
            ))}
            {moved.length > 3 && `, and ${moved.length - 3} more`}.
          </>
        )}
      </p>

      <table className="w-full">
        <thead>
          <tr className="border-b text-[10px] uppercase tracking-wider" style={{ color: 'var(--faint)' }}>
            <th />
            <th className="pb-1 text-left font-medium">Measure</th>
            <th className="pb-1 text-right font-medium">Last 6</th>
            <th className="pb-1 text-right font-medium">Season</th>
            <th className="pb-1 pl-3 text-left font-medium">Reading</th>
          </tr>
        </thead>
        <tbody>
          {[...moved, ...flat].map((m) => (
            <Row key={m.metric} m={m} />
          ))}
        </tbody>
      </table>

      <p className="text-[11px]" style={{ color: 'var(--faint)' }}>
        Ranked against other {POSITION_PLURAL[position] ?? 'players in his position'}, not
        against the whole league — pooling positions inflates apparent reliability by about half,
        because it borrows the striker-versus-defender contrast. {ranked} of {form.metrics.length}{' '}
        measures are reliable enough over six matches to order the position at all; the rest can
        still show that <em>he</em> has changed, which is the more useful claim.
      </p>
    </div>
  )
}
