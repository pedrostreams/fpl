import type { Route } from 'next'
import Link from 'next/link'
import { FixtureTicker } from '@/components/fixture-ticker'
import { TeamBadge } from '@/components/team-badge'
import { TeamScatter } from '@/components/team-scatter'
import { fmt, fmtInt, fmtPct } from '@/lib/format'
import {
  getFixtureTicker,
  getSeasonContext,
  getTeamScatterPoints,
  getTeams,
} from '@/lib/queries'

export const revalidate = 300

function Heat({ p, children }: { p: number | null; children: React.ReactNode }) {
  if (p === null) {
    return (
      <span className="heat-null block rounded px-2 py-1 text-right">
        <span className="num" style={{ color: 'var(--faint)' }}>
          {children}
        </span>
      </span>
    )
  }
  return (
    <span
      className="heat block rounded px-2 py-1 text-right"
      style={{ ['--p' as string]: p }}
      title={`${Math.round(p * 100)}th percentile in the league`}
    >
      <span className="num">{children}</span>
    </span>
  )
}

export default async function TeamsPage() {
  const [teams, ctx, ticker, scatter] = await Promise.all([
    getTeams(),
    getSeasonContext(),
    getFixtureTicker(),
    getTeamScatterPoints(),
  ])
  const promoted = teams.filter((t) => !t.hasStyleData)

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Fixture difficulty — GW{ticker.gameweeks[0]}–{ticker.gameweeks.at(-1)}
          </h1>
          <p className="mt-1 max-w-3xl text-[13px]" style={{ color: 'var(--muted)' }}>
            Continuous difficulty from ClubElo ratings, with the model&apos;s constants{' '}
            <strong>fitted against last season&apos;s betting market</strong>{' '}
            rather than chosen by hand — home advantage, the draw curve and the scoring rates all come
            out of 272 matches where we hold both the de-vigged odds and each side&apos;s
            Elo on the day. It reproduces the market&apos;s ordering at a Spearman of
            0.92.
          </p>
          <p className="mt-2 max-w-3xl text-[13px]" style={{ color: 'var(--muted)' }}>
            Why not just use FPL&apos;s own rating: across 760 team-fixtures it uses four
            values, and <strong>45% of the season sits in one bucket</strong>. Inside that
            single bucket this model spans 0.19 to 0.96 — a near-certain win and a
            near-certain defeat, rated identically. No bookmaker prices exist for fixtures
            this far out, so they are not an option here.
          </p>
        </div>

        <FixtureTicker ticker={ticker} />
      </section>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">How the clubs compare</h2>
          <p className="mt-1 max-w-3xl text-[13px]" style={{ color: 'var(--muted)' }}>
            Two measures at a time, one dot per club, {ctx.statsSeason}. Better is always up
            and to the right — an axis where a low number is the good outcome is reversed and
            says so, the same contract the heatmap follows. Click a dot for the club.
          </p>
        </div>
        <TeamScatter teams={scatter} />
      </section>

      <section className="flex flex-col gap-5">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Team profiles</h2>
          <p className="mt-1 max-w-3xl text-[13px]" style={{ color: 'var(--muted)' }}>
            Style and performance from {ctx.statsSeason}. <strong>PPDA</strong> is passes
            allowed per defensive action, so a <em>low</em> number means an aggressive
            high press and a high number means sitting deep — the one metric here that has
            no FPL equivalent at all.
          </p>
        </div>

        {promoted.length > 0 && (
          <div
            className="rounded-xl border px-4 py-3 text-[13px]"
            style={{
              background: 'color-mix(in oklab, var(--warn) 9%, var(--surface))',
              borderColor: 'color-mix(in oklab, var(--warn) 28%, var(--border))',
            }}
          >
            <strong>{promoted.map((t) => t.name).join(', ')}</strong>{' '}
            {promoted.length === 1 ? 'was' : 'were'} promoted, so {ctx.statsSeason} holds
            no Premier League style data for {promoted.length === 1 ? 'it' : 'them'}.
            Shown below with Elo only — the team-level version of the cold-start problem,
            and a real blind spot until the season starts. Note the fixture ticker above{' '}
            <em>does</em> cover {promoted.length === 1 ? 'it' : 'them'}: Elo carries over
            from the Championship, so a promoted club has a rating even with no Premier
            League match to its name.
          </div>
        )}

        <div
          className="scroll-thin overflow-auto rounded-xl border"
          style={{ background: 'var(--surface)' }}
        >
          <table className="w-full border-separate border-spacing-0 text-left">
            <thead>
              <tr>
                {[
                  ['Team', 'left'],
                  ['PPDA', 'right'],
                  ['Press', 'right'],
                  ['xG', 'right'],
                  ['xGA', 'right'],
                  ['xG diff', 'right'],
                  ['Deep', 'right'],
                  ['Deep conc.', 'right'],
                  ['CS', 'right'],
                  ['CS %', 'right'],
                  ['Pts', 'right'],
                  ['Elo', 'right'],
                ].map(([label, align]) => (
                  <th
                    key={label}
                    className={`sticky top-0 z-10 border-b px-2 py-2 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap text-${align}`}
                    style={{
                      background: 'var(--surface-2)',
                      color: 'var(--muted)',
                    }}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {teams.map((t) => (
                <tr key={t.teamCode}>
                  <td className="border-b px-3 py-1.5 whitespace-nowrap">
                    {/* The crest and the club page, so this table is a way in rather than a
                        terminus — LATER.md item 7, and the reason item 3 existed. */}
                    <Link
                      href={`/team/${t.teamCode}` as Route}
                      className="inline-flex items-center gap-2 hover:underline"
                    >
                      <TeamBadge teamCode={t.teamCode} name={t.name} size={18} />
                      <span className="text-[13px] font-medium">{t.name}</span>
                    </Link>
                    {!t.hasStyleData && (
                      <span
                        className="ml-2 rounded px-1 text-[9px] font-semibold uppercase tracking-wide"
                        style={{
                          background: 'var(--surface-2)',
                          color: 'var(--warn)',
                        }}
                      >
                        promoted
                      </span>
                    )}
                  </td>
                  <td className="border-b p-1">
                    <Heat p={t.pressPercentile}>{fmt(t.ppda, 2)}</Heat>
                  </td>
                  <td className="border-b px-2 py-1.5 text-right">
                    <span className="num text-[12px]" style={{ color: 'var(--muted)' }}>
                      {t.pressRank ? `#${t.pressRank}` : '—'}
                    </span>
                  </td>
                  <td className="border-b p-1">
                    <Heat p={t.xgPercentile}>{fmt(t.xgPerMatch, 2)}</Heat>
                  </td>
                  <td className="border-b p-1">
                    <Heat p={t.defencePercentile}>{fmt(t.xgaPerMatch, 2)}</Heat>
                  </td>
                  <td className="border-b px-2 py-1.5 text-right">
                    <span
                      className="num text-[12px]"
                      style={{
                        color:
                          (t.xgDifference ?? 0) > 0
                            ? 'var(--ok)'
                            : (t.xgDifference ?? 0) < 0
                              ? 'var(--danger)'
                              : 'var(--muted)',
                      }}
                    >
                      {t.xgDifference === null
                        ? '—'
                        : `${t.xgDifference > 0 ? '+' : ''}${t.xgDifference.toFixed(2)}`}
                    </span>
                  </td>
                  {[t.deepCompletions, t.deepCompletionsConceded].map((v, i) => (
                    <td key={i} className="border-b px-2 py-1.5 text-right">
                      <span className="num text-[12px]" style={{ color: 'var(--muted)' }}>
                        {fmt(v, 1)}
                      </span>
                    </td>
                  ))}
                  <td className="border-b px-2 py-1.5 text-right">
                    <span className="num text-[12px]">{fmtInt(t.cleanSheets)}</span>
                  </td>
                  <td className="border-b px-2 py-1.5 text-right">
                    <span className="num text-[12px]" style={{ color: 'var(--muted)' }}>
                      {fmtPct(t.cleanSheetPct, 0)}
                    </span>
                  </td>
                  <td className="border-b px-2 py-1.5 text-right">
                    <span className="num text-[12px]">{fmtInt(t.points)}</span>
                  </td>
                  <td className="border-b px-2 py-1.5 text-right">
                    <span className="num text-[12px]" style={{ color: 'var(--muted)' }}>
                      {fmtInt(t.elo)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-[11px]" style={{ color: 'var(--faint)' }}>
          Colour is percentile within the league, and always oriented so a stronger shade
          is better — the PPDA and xGA scales are inverted for that reason.{' '}
          <strong>Deep</strong> is deep completions: passes received within roughly 20
          metres of goal.
        </p>
      </section>
    </div>
  )
}
