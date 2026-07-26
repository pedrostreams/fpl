import { fmt, ordinal } from '@/lib/format'
import type { TargetRow } from '@/lib/queries'

/**
 * The opponent, and one checkable claim about them.
 *
 * Written after reading allaboutfpl's scout picks, where every recommendation is justified by
 * a fact about the other team — "Burnley rank 2nd bottom for goals scored", "Burnley have the
 * worst defensive record". A difficulty number is a model output the reader has to trust; a
 * league rank is something they can disagree with. Both are on screen.
 *
 * Which fact appears depends on position, because it is a different question: a keeper wants
 * the opponent's attack to be poor, a forward wants their defence to be. `fixture_basis` in
 * `player_target_base` decides, so the rule lives in SQL and not in two components.
 */
export function FixtureNote({ row, compact = false }: { row: TargetRow; compact?: boolean }) {
  // A blank is not a hard fixture, and must not be coloured like one. It scores zero on the
  // fixture axis — which is truthful — but the screen has to say why.
  if (row.fixtureCount === 0) {
    return (
      <span className="text-[11px] font-medium" style={{ color: 'var(--warn)' }}>
        blank gameweek
      </span>
    )
  }

  const defensive = row.fixtureBasis === 'clean sheet'
  // Verb and direction spelled out. "TOT 6th of 20 for defence" was ambiguous in the one way
  // that matters — whether 6th is a reason to buy or a reason not to — and wrong about the
  // denominator, since only the 17 clubs with a top-flight record are ranked at all.
  const verb = defensive ? 'create' : 'concede'
  const metric = defensive ? 'xG' : 'xGA'
  const direction = defensive ? 'highest' : 'lowest'
  const chance = defensive ? row.fixtureCleanSheets : row.fixtureXgFor

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span
        className="heat rounded px-1.5 py-0.5 text-[10px] font-semibold"
        // Inverted, as everywhere: colour means better, and 0 difficulty is the easiest draw.
        style={{ ['--p' as string]: 1 - (row.fixtureDifficulty ?? 0.5) }}
        title={`Difficulty ${fmt(row.fixtureDifficulty, 2)} · ${
          defensive ? 'expected clean sheets' : 'expected goals for'
        } ${fmt(chance, 2)}`}
      >
        {row.opponents}
        {row.fixtureCount > 1 && ` ×${row.fixtureCount}`}
      </span>
      {!compact &&
        (row.opponentRank === null ? (
          // Promoted clubs have no `team_style` row until they have played a top-flight match.
          // An em dash, per the house rule: the value does not exist, it is not merely unranked.
          <span style={{ color: 'var(--faint)' }}>— promoted, no top-flight record</span>
        ) : (
          <span style={{ color: 'var(--faint)' }}>
            {verb} {fmt(row.opponentPerMatch, 2)} {metric}/match ·{' '}
            <span
              title={
                `Last season, across the ${row.rankedClubs ?? '?'} clubs with a top-flight ` +
                `record. The middle of this table is tightly packed — ranks 4 to 17 span only ` +
                `0.29 xGA per match — so read the rate first and the rank second.`
              }
            >
              {ordinal(row.opponentRank)} {direction} of {row.rankedClubs ?? '—'}
            </span>
          </span>
        ))}
    </span>
  )
}
