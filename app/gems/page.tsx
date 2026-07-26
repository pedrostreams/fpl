import { FixtureNote } from '@/components/fixture-note'
import { WatchButton } from '@/components/watch-button'
import { POSITION_VAR, fmt, fmtInt, fmtPct, fmtPrice, statusColour } from '@/lib/format'
import { getHiddenGems, getSeasonContext, getWatchlistCodes } from '@/lib/queries'
import type { TargetRow } from '@/lib/queries'

export const revalidate = 300

/** A percentile rendered as a bar, so a composite score can show its own workings. */
function Bar({ value, label, hint }: { value: number | null; label: string; hint?: string }) {
  const p = value ?? 0
  return (
    <div
      className="flex items-center gap-2"
      title={hint ?? `${label}: ${Math.round(p * 100)}th percentile`}
    >
      <span
        className="w-[68px] shrink-0 text-[10px] uppercase tracking-wider"
        style={{ color: 'var(--faint)' }}
      >
        {label}
      </span>
      <span
        className="h-1.5 flex-1 overflow-hidden rounded-full"
        style={{ background: 'var(--surface-2)' }}
      >
        <span
          className="block h-full rounded-full"
          style={{ width: `${p * 100}%`, background: 'var(--accent)' }}
        />
      </span>
      <span className="num w-8 text-right text-[11px]" style={{ color: 'var(--muted)' }}>
        {value === null ? '—' : Math.round(p * 100)}
      </span>
    </div>
  )
}

/**
 * Grouped by position rather than ranked flat, because nobody buys "the best player" — they
 * buy a replacement for their third defender. The top 24 of the old flat list was 10 MID and
 * 2 GKP, which is a fair ranking and a useless shopping list.
 */
const GROUPS: { key: string; title: string; blurb: string }[] = [
  { key: 'GKP', title: 'Goalkeepers', blurb: 'Ranked on goals conceded, saves and clean-sheet odds' },
  { key: 'DEF', title: 'Defenders', blurb: 'Conceded and defensive contribution, then the clean-sheet fixture' },
  { key: 'MID', title: 'Midfielders', blurb: 'Goal involvement, then how leaky the opponent is' },
  { key: 'FWD', title: 'Forwards', blurb: 'Goal involvement, then how leaky the opponent is' },
]

function GemCard({ g, i, watched }: { g: TargetRow; i: number; watched: boolean }) {
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border p-4"
      style={{ background: 'var(--surface)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="num text-[11px] font-semibold" style={{ color: 'var(--faint)' }}>
            {String(i + 1).padStart(2, '0')}
          </span>
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: statusColour(g.status, null) }}
            title={g.news || undefined}
          />
          <span className="text-[14px] font-semibold">{g.webName}</span>
          <span className="text-[11px] font-semibold" style={{ color: POSITION_VAR[g.position] }}>
            {g.position}
          </span>
          <span className="text-[11px]" style={{ color: 'var(--faint)' }}>
            {g.teamShort}
          </span>
          {g.penaltiesOrder === 1 && (
            <span
              className="rounded px-1 text-[9px] font-bold"
              style={{
                background: 'color-mix(in oklab, var(--accent) 22%, transparent)',
                color: 'var(--accent)',
              }}
              title="First-choice penalty taker"
            >
              P1
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className="num rounded-md px-2 py-0.5 text-[12px] font-bold"
            style={{
              background: 'color-mix(in oklab, var(--accent) 20%, transparent)',
              color: 'var(--accent)',
            }}
            title="Mean of the five percentiles below"
          >
            {fmt(g.score, 3)}
          </span>
          <WatchButton playerCode={g.playerCode} watched={watched} />
        </div>
      </div>

      <div className="text-[11px]">
        <FixtureNote row={g} />
      </div>

      <div
        className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]"
        style={{ color: 'var(--muted)' }}
      >
        <span>
          <span style={{ color: 'var(--text)' }}>{fmtPrice(g.price)}</span> price
        </span>
        <span>
          <span style={{ color: 'var(--text)' }}>{fmtPct(g.selectedByPercent)}</span> owned
        </span>
        {/* Share of the season, not the raw minutes total. 540 minutes reads as a real
            sample; 15.8% of a season reads as a backup keeper. The first draft of this page
            ranked one at 01 and nothing on screen would have told you. */}
        <span title={`${fmtInt(g.minutes)} of a possible ${fmtInt((g.minutes ?? 0) / Math.max(g.minutesShare ?? 1, 0.001))} minutes`}>
          <span style={{ color: 'var(--text)' }}>{fmtPct((g.minutesShare ?? 0) * 100, 0)}</span>{' '}
          of the season
        </span>
        <span>
          <span style={{ color: 'var(--text)' }}>{fmtInt(g.totalPoints)}</span> pts
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <Bar value={g.outputPercentile} label="Output" />
        <Bar value={g.minutesRank} label="Minutes" hint="Share of the team's available minutes, ranked — volume, which a per-90 rate cannot see" />
        <Bar value={g.differentialPercentile} label="Unowned" />
        <Bar value={g.valuePercentile} label="Value" />
        <Bar
          value={g.fixtureRank}
          label="Fixture"
          hint={
            g.fixtureCount === 0
              ? 'Blank gameweek — no fixture, so this axis contributes zero'
              : `${g.fixtureBasis === 'clean sheet' ? 'Expected clean sheets' : 'Expected goals for'}` +
                ` this gameweek, ranked against the other 19 clubs`
          }
        />
      </div>

      <div className="num flex flex-wrap gap-3 border-t pt-2 text-[11px]" style={{ color: 'var(--faint)' }}>
        <span title="Expected goal involvement per 90">xGI {fmt(g.xgiPer90, 3)}</span>
        <span title="Defensive contribution per 90">DC {fmt(g.defconPer90, 1)}</span>
        <span title="Expected goals conceded per 90">xGC {fmt(g.xgcPer90, 2)}</span>
        <span title="Bonus points system score per 90 — the input FPL awards bonus from">
          BPS {fmt(g.bpsPer90, 1)}
        </span>
        <span title="Points per million">{fmt(g.pointsPerMillion, 1)} pts/£m</span>
      </div>
    </div>
  )
}

export default async function GemsPage() {
  const [gems, ctx, watchedCodes] = await Promise.all([
    getHiddenGems(120),
    getSeasonContext(),
    getWatchlistCodes(),
  ])
  const watched = new Set(watchedCodes)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Hidden gems</h1>
        <p className="mt-1 max-w-3xl text-[13px]" style={{ color: 'var(--muted)' }}>
          Output, minutes, ownership scarcity, points per million and the fixture, weighted
          equally. Under 10% owned, fit, and with at least a quarter of {ctx.statsSeason}{' '}
          played. Output is measured by position — expected goals conceded for keepers,
          conceded and defensive contribution for defenders, goal involvement for midfielders
          and forwards — and so is the fixture: a keeper is ranked on the clean sheet, a
          forward on the goals.
        </p>
        <p className="mt-2 max-w-3xl text-[12px]" style={{ color: 'var(--faint)' }}>
          Minutes are a separate axis from output because a per-90 rate cannot see how often
          the 90 happened. Without it a backup keeper on 540 minutes ranked first. The fixture
          axis is ranked across the 20 clubs rather than across players, so a large squad
          cannot drag the distribution around — which does mean clubs cluster, since every
          player at one club shares a fixture.
        </p>
      </div>

      {GROUPS.map((group) => {
        const rows = gems.filter((g) => g.position === group.key)
        if (rows.length === 0) return null
        return (
          <section key={group.key} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 className="text-[13px] font-semibold uppercase tracking-wider">
                {group.title}
              </h2>
              <span className="num text-[11px]" style={{ color: 'var(--faint)' }}>
                {rows.length}
              </span>
              <span className="text-[11px]" style={{ color: 'var(--faint)' }}>
                {group.blurb}
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {rows.slice(0, 9).map((g, i) => (
                <GemCard key={g.playerCode} g={g} i={i} watched={watched.has(g.playerCode)} />
              ))}
            </div>
          </section>
        )
      })}

      {gems.length === 0 && (
        <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
          No player qualifies yet — the underlying view needs a season with minutes played.
        </p>
      )}
    </div>
  )
}
