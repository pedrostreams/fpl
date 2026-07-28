/**
 * The tooltip's rank must agree with the cell's colour.
 *
 *     node scripts/probe/prove_rank_detail.mjs
 *
 * No database, no network — the same contract as the two Python `prove_*` scripts, and here for
 * the same reason they are: this is a logic path whose failure is silent. A cell shaded fully
 * green while its tooltip reads "112th of 148" is not a crash, it is a lie, and nothing on
 * screen would tell you which half was wrong.
 *
 * This codebase has already had two mid-rank bugs reach the screen. `percent_rank` handed a tie
 * group the rank of its first member, which reported every full-time starter on the captain
 * panel as "37th percentile" for minutes while they were tied at the top. `cume_dist` counts
 * rows at or below, which put all 22 goalkeepers tied on 0.000 xG/90 into the 96th percentile
 * for scoring. Both looked plausible. Hence a script rather than care.
 *
 * Node 22+ strips the type annotations from the imported .ts on the fly, so there is no build
 * step and the assertions run against the exact module the browser gets.
 */

import assert from 'node:assert/strict'
import { describeRank, rankColumn } from '../../lib/rank.ts'
import { registerTipSource, resolveTip } from '../../lib/tooltip.ts'

let checks = 0
const fail = []

function check(name, fn) {
  checks++
  try {
    fn()
  } catch (e) {
    fail.push(`${name}: ${e.message}`)
  }
}

/** `xgi_per_90` is higher-is-better and scoped to position; `selected_by_percent` is lower and 'all'. */
const rowsOf = (values, key = 'xgi_per_90', position = 'MID') =>
  values.map((v, i) => ({ player_code: i + 1, position, [key]: v }))

// ---------------------------------------------------------------------------------------
// The invariant: rank and percentile describe the same ordering
// ---------------------------------------------------------------------------------------

check('best value ranks 1st', () => {
  const rows = rowsOf([0.1, 0.5, 0.9, 0.3])
  const d = describeRank(rows, 'xgi_per_90', rows[2])
  assert.equal(d.rank, 1, `expected 1, got ${d.rank}`)
  assert.equal(d.pool, 4)
})

check('worst value ranks last', () => {
  const rows = rowsOf([0.1, 0.5, 0.9, 0.3])
  const d = describeRank(rows, 'xgi_per_90', rows[0])
  assert.equal(d.rank, 4, `expected 4, got ${d.rank}`)
})

check('lower-is-better inverts the ordering, not the arithmetic', () => {
  // Ownership: least-owned is the good end, so 1.0% must rank 1st of 4.
  const rows = [1.0, 40.0, 12.0, 70.0].map((v, i) => ({
    player_code: i + 1, position: 'MID', selected_by_percent: v,
  }))
  const d = describeRank(rows, 'selected_by_percent', rows[0])
  assert.equal(d.rank, 1, `least-owned should rank 1st, got ${d.rank}`)
  const worst = describeRank(rows, 'selected_by_percent', rows[3])
  assert.equal(worst.rank, 4, `most-owned should rank last, got ${worst.rank}`)
})

check('a tie group reports the middle of its own span', () => {
  // Four tied at the bottom of ten. Mid-rank puts them at (0 + 4/2)/10 = 0.2, and the span
  // they occupy is 7th-10th, whose middle is 8.5 -> 8 or 9. Anything outside that span would
  // mean the tooltip claims a position one of them does not hold.
  const rows = rowsOf([0, 0, 0, 0, 1, 2, 3, 4, 5, 6])
  const d = describeRank(rows, 'xgi_per_90', rows[0])
  assert.equal(d.pool, 10)
  assert.ok(d.rank >= 7 && d.rank <= 10, `tie rank ${d.rank} outside its span 7..10`)
  assert.equal(d.percentile, 0.2, `expected 0.2, got ${d.percentile}`)
})

check('all values tied: everyone is mid, nobody is first', () => {
  const rows = rowsOf([2, 2, 2, 2, 2])
  const d = describeRank(rows, 'xgi_per_90', rows[0])
  assert.equal(d.percentile, 0.5)
  assert.equal(d.rank, 3, `middle of 1..5 is 3, got ${d.rank}`)
})

check('rank is consistent with the percentile rankColumn shades by', () => {
  // The actual invariant, over a spread with ties, negatives and duplicates.
  const values = [0, 0, 0.15, 0.4, 0.4, 0.4, 1.2, -0.3, 0.75, 2.1, 0.15, 0.9]
  const rows = rowsOf(values)
  const shaded = rankColumn(rows, 'xgi_per_90')
  for (let i = 0; i < rows.length; i++) {
    const d = describeRank(rows, 'xgi_per_90', rows[i])
    assert.equal(
      d.percentile, shaded[i],
      `row ${i} (${values[i]}): tooltip ${d.percentile} vs shading ${shaded[i]}`,
    )
    // Monotone: a better value must never carry a worse rank.
    for (let j = 0; j < rows.length; j++) {
      const e = describeRank(rows, 'xgi_per_90', rows[j])
      if (values[i] > values[j]) {
        assert.ok(d.rank <= e.rank, `${values[i]} ranks ${d.rank}, worse ${values[j]} ranks ${e.rank}`)
      }
    }
  }
})

check('rank never falls outside 1..pool', () => {
  for (const n of [1, 2, 3, 7, 20, 148, 558]) {
    const rows = rowsOf(Array.from({ length: n }, (_, i) => i * 0.01))
    for (const idx of [0, Math.floor(n / 2), n - 1]) {
      const d = describeRank(rows, 'xgi_per_90', rows[idx])
      assert.ok(d.rank >= 1 && d.rank <= n, `n=${n} idx=${idx} -> rank ${d.rank}`)
    }
  }
})

// ---------------------------------------------------------------------------------------
// Pool composition — the sentence names a set, and it must be the set that was used
// ---------------------------------------------------------------------------------------

check('position-scoped metrics compare within position only', () => {
  const rows = [
    { player_code: 1, position: 'MID', xgi_per_90: 0.4 },
    { player_code: 2, position: 'MID', xgi_per_90: 0.2 },
    { player_code: 3, position: 'FWD', xgi_per_90: 0.9 },
    { player_code: 4, position: 'FWD', xgi_per_90: 0.8 },
    { player_code: 5, position: 'FWD', xgi_per_90: 0.7 },
  ]
  const mid = describeRank(rows, 'xgi_per_90', rows[0])
  assert.equal(mid.pool, 2, `MID pool should be 2, got ${mid.pool}`)
  assert.equal(mid.rank, 1)
  assert.equal(mid.within, 'MID')
  // The forward on 0.7 beats both midfielders on raw value and must still rank last of three.
  const fwd = describeRank(rows, 'xgi_per_90', rows[4])
  assert.equal(fwd.pool, 3)
  assert.equal(fwd.rank, 3)
})

check("scope 'all' pools the whole table and says so", () => {
  const rows = [
    { player_code: 1, position: 'MID', selected_by_percent: 5 },
    { player_code: 2, position: 'FWD', selected_by_percent: 50 },
    { player_code: 3, position: 'DEF', selected_by_percent: 25 },
  ]
  const d = describeRank(rows, 'selected_by_percent', rows[0])
  assert.equal(d.pool, 3, 'ownership is scope:all, so all three positions count')
  assert.equal(d.within, null, 'within must be null so the sentence does not name a position')
})

check('missing and non-numeric values are excluded from the pool, not counted as zero', () => {
  const rows = [
    { player_code: 1, position: 'MID', xgi_per_90: 0.4 },
    { player_code: 2, position: 'MID', xgi_per_90: null },
    { player_code: 3, position: 'MID', xgi_per_90: undefined },
    { player_code: 4, position: 'MID', xgi_per_90: 0.1 },
  ]
  const d = describeRank(rows, 'xgi_per_90', rows[0])
  assert.equal(d.pool, 2, `pool should exclude the two absent values, got ${d.pool}`)
  // And an absent value gets no detail at all, rather than a rank at the bottom. Zero would
  // read as "worst in the league" for a player nobody has measured.
  assert.equal(describeRank(rows, 'xgi_per_90', rows[1]), null)
  assert.equal(describeRank(rows, 'xgi_per_90', rows[2]), null)
})

check("direction 'none' yields no rank at all", () => {
  // Price is deliberately unshaded — cheap is not better — so there is nothing to rank.
  const rows = [
    { player_code: 1, position: 'MID', price: 4.5 },
    { player_code: 2, position: 'MID', price: 14.0 },
  ]
  assert.equal(describeRank(rows, 'price', rows[0]), null)
  assert.equal(describeRank(rows, 'unknown_column', rows[0]), null)
})

check('numeric strings coerce, matching what node-postgres delivers', () => {
  // `numeric` arrives as a string; lib/db.ts coerces, but the ranker must not depend on that
  // having happened — sorting raw strings would put "9" after "10".
  const rows = rowsOf(['0.4', '0.2', '1.1'])
  const d = describeRank(rows, 'xgi_per_90', rows[2])
  assert.equal(d.rank, 1, `"1.1" should rank 1st, got ${d.rank}`)
  assert.equal(d.pool, 3)
})

// ---------------------------------------------------------------------------------------
// Tooltip content resolution
// ---------------------------------------------------------------------------------------
// Which of the two content routes wins, and what happens when the richer one has nothing to
// say. Getting this backwards shows the wrong tooltip rather than none, which is worse.

/**
 * The three DOM methods `lib/tooltip.ts` actually uses. A real DOM is not needed to test
 * precedence, and faking exactly this much keeps the probe dependency-free like its siblings.
 */
function el(dataset, parent = null) {
  const node = {
    dataset,
    parent,
    closest(sel) {
      const attrs = sel.split(',').map((s) => s.trim().replace(/^\[|\]$/g, ''))
      for (let n = node; n; n = n.parent) {
        for (const a of attrs) {
          // `data-tip-src` -> `tipSrc`
          const camel = a.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())
          if (n.dataset[camel] !== undefined) return n
        }
      }
      return null
    },
  }
  return node
}

check('static data-tip becomes a plain tip', () => {
  const t = resolveTip(el({ tip: 'First-choice penalty taker' }))
  assert.equal(t.title, 'First-choice penalty taker')
  assert.equal(t.value, undefined)
})

check('data-tip-note and data-tip-why carry through', () => {
  const t = resolveTip(el({ tip: 'Min %', tipNote: '86% of the season', tipWhy: 'Volume.' }))
  assert.equal(t.note, '86% of the season')
  assert.equal(t.why, 'Volume.')
})

check('no attributes at all yields no tooltip', () => {
  assert.equal(resolveTip(el({})), null)
})

check('a registered resolver beats static text on the same element', () => {
  const off = registerTipSource('t', () => ({ title: 'rich' }))
  const host = el({ tipSrc: 't' })
  const cell = el({ tip: 'plain', tipC: 'xgi_per_90' }, host)
  assert.equal(resolveTip(cell).title, 'rich')
  off()
})

check('a resolver returning null falls back to static text', () => {
  // The real case: an identity cell inside a registered table. The resolver declines, and the
  // cell's own `data-tip` is still the right answer rather than nothing.
  const off = registerTipSource('t', () => null)
  const host = el({ tipSrc: 't' })
  assert.equal(resolveTip(el({ tip: 'plain' }, host)).title, 'plain')
  off()
})

check('unregistering leaves no stale resolver behind', () => {
  // Two mounted tables would otherwise fight over one name, and React's double-invoked effects
  // in dev make that a real sequence rather than a hypothesis.
  const off = registerTipSource('t', () => ({ title: 'gone' }))
  off()
  const host = el({ tipSrc: 't' })
  assert.equal(resolveTip(el({ tip: 'plain' }, host)).title, 'plain')
})

check('a resolver is reached from a nested element, not just a direct child', () => {
  const off = registerTipSource('t', (node) => ({ title: node.dataset.tipC ?? '?' }))
  const table = el({ tipSrc: 't' })
  const row = el({ tipR: '222531' }, table)
  const cell = el({ tipC: 'shots_per_90' }, row)
  assert.equal(resolveTip(cell).title, 'shots_per_90')
  off()
})

// ---------------------------------------------------------------------------------------

console.log(`${checks} checks, ${fail.length} failed`)
if (fail.length) {
  for (const f of fail) console.error(`  FAIL  ${f}`)
  process.exit(1)
}
console.log('rank detail agrees with the shading it describes')
