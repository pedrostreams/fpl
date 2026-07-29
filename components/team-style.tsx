import { fmt, fmtSigned, ordinal } from '@/lib/format'
import { tipRows } from '@/lib/tooltip'
import type { StyleMetric, TeamStyle } from '@/lib/queries'

/**
 * How a club plays, measured over a full season, with the strength of each claim stated.
 *
 * Built from migrations 0021 and 0022. The reasoning is in docs/feat/trend-claims.md; the two
 * facts that shaped this screen:
 *
 * 1. **A season figure works where a form window does not.** The reliability of a 6-match club
 *    mean is 0.13-0.48 and of a 38-match mean 0.49-0.85. So the headline numbers here are
 *    whole-season, and the trend layer at the bottom is deliberately small.
 *
 * 2. **Reliability decides what may be shown, not just how confident to sound.** A metric whose
 *    league ordering is barely better than chance shows no rank — expected goals conceded is
 *    the live case, at 0.49. It still shows its value, and a club far enough from the league
 *    mean by its own error bar is still named. Those are two different gates and SQL applies
 *    both; this component only renders what it is given.
 *
 * Nothing is computed here. No reliability threshold, no wording, no decimal count — all of it
 * arrives from the views, which is what lets `style_check` assert on it. `reliabilityTier` is
 * the only reliability input this file touches, and it is used to style, never to decide.
 */

/** Faint for a caveat, normal otherwise. Styling only — the decision was made in SQL. */
const TIER_COLOUR: Record<number, string> = {
  3: 'var(--muted)',
  2: 'var(--muted)',
  1: 'var(--faint)',
}

/**
 * "3rd of 17", or "2nd most aggressive of 17" where the ordering has no better end.
 *
 * Counted from whichever end is nearer, because one end is not enough: Crystal Palace sat
 * deepest in the league and read "17th most aggressive of 17", which is a contortion for
 * "least aggressive". Both nouns come from `style_rank_noun`.
 */
function rankText(m: StyleMetric): string | null {
  if (m.rank === null || m.pool === null) return null
  if (!m.rankNoun) return `${ordinal(m.rank)} of ${m.pool}`
  const fromBottom = m.pool - m.rank + 1
  if (m.rankNounLow && fromBottom < m.rank) {
    return fromBottom === 1
      ? `${m.rankNounLow} of ${m.pool}`
      : `${ordinal(fromBottom)} ${m.rankNounLow} of ${m.pool}`
  }
  return m.rank === 1
    ? `${m.rankNoun} of ${m.pool}`
    : `${ordinal(m.rank)} ${m.rankNoun} of ${m.pool}`
}

/**
 * The workings, on hover.
 *
 * `data-tip` is not optional here: `resolveTip` returns null without it, so an element carrying
 * only `data-tip-rows` renders no tooltip at all — which is how the first version of this
 * component silently had none. The title is what you are pointing at, the value leads, the rows
 * are the derivation, and the blurb goes in the italic `why` slot rather than being squeezed
 * into a two-column row.
 */
function metricTip(m: StyleMetric, statsSeason: string | null): string | undefined {
  const rank = rankText(m) ?? 'not ranked — the league ordering is not reliable enough'
  return tipRows([
    [`${statsSeason ?? 'Season'} average`, `${m.displayValue ?? '—'} ${m.unit}`],
    ['League average', `${m.displayLeagueMean ?? '—'} ${m.unit}`],
    ['Rank', rank],
    ['Matches', String(m.matches ?? '—')],
    // The error bar, in the units the reader is already looking at, then the same distance
    // expressed as "how many error bars from the league" — which is the gate that licenses
    // naming this club at all.
    m.stdError !== null && [`Margin on this club's figure`, `± ${fmt(m.stdError, 3)}`],
    m.separationZ !== null && [
      'Distance from the league',
      `${fmtSigned(m.separationZ, 1)} error bars`,
      m.separated ? 'good' : 'muted',
    ],
    ['How well it holds up', m.reliabilityWord ?? '—', m.reliabilityTier === 1 ? 'bad' : 'muted'],
  ])
}

function MetricRow({
  m,
  statsSeason,
  showUnit,
}: {
  m: StyleMetric
  statsSeason: string | null
  showUnit: boolean
}) {
  const shaded = m.percentile !== null
  return (
    <tr
      className="border-b"
      style={{ borderColor: 'var(--border)' }}
      data-tip={m.label}
      data-tip-value={`${m.displayValue ?? '—'} ${m.unit}`}
      data-tip-rows={metricTip(m, statsSeason)}
      data-tip-why={m.blurb ?? undefined}
    >
      {/*
        Fixed label width so the value columns line up between the groups stacked in one column.
        Each group is its own table, so without it "Box entries against" pushed the CONCEDE heat
        cells 38px right of the CREATE ones directly above them.
      */}
      <td className="w-40 py-1.5 pr-2">
        <span className="font-medium">{m.shortLabel}</span>
      </td>
      {/*
        Shaded only where a percentile exists. A null percentile has two innocent causes —
        PPDA has an order but no better end, and an unreliable metric has no ordering at all —
        and in neither case is the value missing, so `.heat-null` hatching would be a lie.
        Crucially the `heat` class is left off entirely rather than passed --p: 0, which is how
        an absent percentile would otherwise render as the worst in the league.
      */}
      <td className="w-24 py-0 pl-1 pr-1 text-right">
        <div
          className={shaded ? 'heat rounded px-2 py-1' : 'px-2 py-1'}
          style={shaded ? ({ ['--p' as string]: m.percentile } as React.CSSProperties) : undefined}
        >
          <span className="num font-semibold">{m.displayValue ?? '—'}</span>
        </div>
      </td>
      {showUnit && (
        <td className="py-1.5 pl-1 text-[11px]" style={{ color: 'var(--faint)' }}>
          {m.unit}
        </td>
      )}
      <td className="py-1.5 pl-3 text-right text-[11px]" style={{ color: 'var(--muted)' }}>
        {rankText(m) ?? '—'}
      </td>
      <td
        className="py-1.5 pl-3 text-right text-[11px]"
        style={{ color: TIER_COLOUR[m.reliabilityTier ?? 1] }}
      >
        {m.standingWord}
      </td>
    </tr>
  )
}

function Group({
  title,
  note,
  metrics,
  statsSeason,
}: {
  title: string
  note: string
  metrics: StyleMetric[]
  statsSeason: string | null
}) {
  // "per match" eight times down the page is noise. Where a group's metrics all share a unit
  // it moves to the heading and the column disappears; where they do not, the column stays.
  // Derived rather than assumed, so adding a metric with a different unit cannot make the
  // heading lie.
  const units = new Set(metrics.map((m) => m.unit))
  const commonUnit = units.size === 1 ? metrics[0].unit : null
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider">{title}</span>
        {commonUnit && (
          <span className="num text-[11px]" style={{ color: 'var(--muted)' }}>
            {commonUnit}
          </span>
        )}
        <span className="text-[11px]" style={{ color: 'var(--faint)' }}>
          {note}
        </span>
      </div>
      <table className="w-full border-collapse text-[12px]">
        <tbody>
          {metrics.map((m) => (
            <MetricRow
              key={m.metric}
              m={m}
              statsSeason={statsSeason}
              showUnit={commonUnit === null}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The FPL read: one line, and which position it points at. */
function Read({ style }: { style: TeamStyle }) {
  const read = style.read
  if (!read?.summary) {
    // Rule 5 from the feature doc: say nothing rather than something weak. Three of seventeen
    // clubs separate from the league on no axis at all, and that is a finding about them.
    return (
      <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
        No axis where this club stands clear of the league by more than its own margin of error.
        A mid-table style in every direction is a real answer, not a missing one.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[15px] font-medium leading-snug">
        {read.summary.charAt(0).toUpperCase() + read.summary.slice(1)}.
      </p>
      {read.positionHint && (
        <p className="text-[13px]" style={{ color: 'var(--accent)' }}>
          Worth owning: {read.positionHint}
        </p>
      )}
    </div>
  )
}

/**
 * The trend layer, kept small on purpose.
 *
 * A rolling window resolves changes of roughly ±50% and nothing subtler, so only the loudest
 * two are shown and each names its own window. The Elo line is separate because it is the only
 * signal here that is honestly about *now* — everything else describes a completed season.
 */
function Trend({ style, statsSeason }: { style: TeamStyle; statsSeason: string | null }) {
  const trends = style.trends.slice(0, 2)
  const drift = style.drift
  const notable = drift?.notable90 ? drift : null
  if (!trends.length && !notable) {
    return (
      <p className="text-[12px]" style={{ color: 'var(--faint)' }}>
        No change large enough to separate from match-to-match variation.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {trends.map((t) => (
        <div key={t.metric} className="text-[12px]">
          <span className="font-medium">{t.directionWord}</span>
          <span style={{ color: 'var(--muted)' }}>
            {' — '}
            {t.label.toLowerCase()} over the last {t.windowN} of{' '}
            {/* Never "now" about a finished season: the basis picks the tense. */}
            {t.basis === 'in_season' ? 'this season' : t.season}, {fmt(t.windowMean, 2)} against{' '}
            {fmt(t.seasonMean, 2)} for the season
          </span>
          <span
            className="num ml-1 text-[11px]"
            style={{ color: 'var(--faint)' }}
            data-tip={t.label}
            data-tip-value={`${fmtSigned(t.deltaPct, 0)}% over the last ${t.windowN}`}
            data-tip-why="A window this short can only resolve a change of roughly ±50%. The threshold below was calibrated against a permutation test on this club's own season, not assumed."
            data-tip-rows={tipRows([
              ['Window', `last ${t.windowN} matches`],
              ['Window average', `${fmt(t.windowMean, 2)} ${t.unit}`],
              ['Season average', `${fmt(t.seasonMean, 2)} ${t.unit}`],
              ['Change', `${fmtSigned(t.deltaPct, 0)}%`],
              ['Standard deviations from the season', fmtSigned(t.z, 2)],
              // Two of four window lengths is the robustness rule: adjacent windows share most
              // of their matches, so a real change persists and a fluke does not.
              ['Window lengths where it held', `${t.windowsHeld} of 4`],
              t.oppositionGap !== null && [
                'Opposition over the window',
                `${fmtSigned(t.oppositionGap, 0)} Elo against their season average`,
                (t.oppositionGap > 0) === (t.directionWord === 'improving') ? 'good' : 'bad',
              ],
            ])}
          >
            ({fmtSigned(t.deltaPct, 0)}%)
          </span>
          {/*
            Honesty rule 3, on the face of the page rather than only on hover: the opposition
            control is stated in the direction that argues against the claim as readily as for
            it. Crystal Palace's collapse came against opposition 74 Elo stronger, which
            strengthens it.
          */}
          {t.oppositionGap !== null && (
            <span className="ml-1 text-[11px]" style={{ color: 'var(--warn)' }}>
              against opposition {fmtSigned(t.oppositionGap, 0)} Elo{' '}
              {t.oppositionGap > 0 ? 'stronger' : 'weaker'} than usual
            </span>
          )}
        </div>
      ))}
      {notable && (
        <div className="text-[12px]">
          <span className="font-medium">Elo {notable.directionWord}</span>
          <span style={{ color: 'var(--muted)' }}>
            {' — '}
            {fmtSigned(notable.drift90, 0)} over 90 days, worth {fmtSigned(notable.goalEffect90Pct, 1)}
            % on expected goals
          </span>
        </div>
      )}
      <p className="text-[11px]" style={{ color: 'var(--faint)' }}>
        {statsSeason ? `Windows are within ${statsSeason}. ` : ''}A window this short resolves
        changes of roughly ±50% and nothing subtler, so most clubs correctly get nothing here.
      </p>
    </div>
  )
}

export function TeamStyleBody({
  style,
  statsSeason,
}: {
  style: TeamStyle
  statsSeason: string | null
}) {
  // Two explicit columns rather than a flowing grid. A 4-group grid flowed create | dead ball
  // and concede | press, leaving the right column two thirds empty because the two single-metric
  // groups each sat beside a three-metric one. Splitting on metric count balances it and keeps
  // doing so if a metric is added, where a hardcoded order would not.
  const wide = style.groups.filter((g) => g.metrics.length > 1)
  const narrow = style.groups.filter((g) => g.metrics.length <= 1)
  const columns = narrow.length ? [wide, narrow] : [style.groups]
  return (
    <div className="flex flex-col gap-4">
      <Read style={style} />
      <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
        {columns.map((col, i) => (
          <div key={i} className="flex flex-col gap-4">
            {col.map((g) => (
              <Group
                key={g.group}
                title={g.title}
                note={g.note}
                metrics={g.metrics}
                statsSeason={statsSeason}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider">
          Current direction
        </div>
        <Trend style={style} statsSeason={statsSeason} />
      </div>
    </div>
  )
}
