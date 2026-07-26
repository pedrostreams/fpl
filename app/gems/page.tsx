import { POSITION_VAR, fmt, fmtInt, fmtPct, fmtPrice, statusColour } from '@/lib/format'
import { getHiddenGems, getSeasonContext } from '@/lib/queries'

export const revalidate = 300

/** A percentile rendered as a bar, so a composite score can show its own workings. */
function Bar({ value, label }: { value: number | null; label: string }) {
  const p = value ?? 0
  return (
    <div className="flex items-center gap-2" title={`${label}: ${Math.round(p * 100)}th percentile`}>
      <span className="w-[68px] shrink-0 text-[10px] uppercase tracking-wider" style={{ color: 'var(--faint)' }}>
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
        {Math.round(p * 100)}
      </span>
    </div>
  )
}

export default async function GemsPage() {
  const [gems, ctx] = await Promise.all([getHiddenGems(48), getSeasonContext()])

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Hidden gems</h1>
        <p className="mt-1 max-w-3xl text-[13px]" style={{ color: 'var(--muted)' }}>
          Output, ownership scarcity and points per million, weighted equally. Under 10%
          owned, with a reliable sample from {ctx.statsSeason}. Output is measured by
          position: expected goals conceded for keepers, conceded and defensive contribution
          for defenders, goal involvement for midfielders and forwards — a centre-back is not
          judged on xGI.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {gems.map((g, i) => (
          <div
            key={g.playerCode}
            className="flex flex-col gap-3 rounded-xl border p-4"
            style={{ background: 'var(--surface)' }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <span
                  className="num text-[11px] font-semibold"
                  style={{ color: 'var(--faint)' }}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: statusColour(g.status, null) }}
                  title={g.news || undefined}
                />
                <span className="text-[14px] font-semibold">{g.webName}</span>
                <span
                  className="text-[11px] font-semibold"
                  style={{ color: POSITION_VAR[g.position] }}
                >
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
              <span
                className="num rounded-md px-2 py-0.5 text-[12px] font-bold"
                style={{
                  background: 'color-mix(in oklab, var(--accent) 20%, transparent)',
                  color: 'var(--accent)',
                }}
                title="Mean of the three percentiles below"
              >
                {fmt(g.gemScore, 3)}
              </span>
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]" style={{ color: 'var(--muted)' }}>
              <span>
                <span style={{ color: 'var(--text)' }}>{fmtPrice(g.price)}</span> price
              </span>
              <span>
                <span style={{ color: 'var(--text)' }}>{fmtPct(g.selectedByPercent)}</span> owned
              </span>
              <span>
                <span style={{ color: 'var(--text)' }}>{fmtInt(g.minutes)}</span> mins
              </span>
              <span>
                <span style={{ color: 'var(--text)' }}>{fmtInt(g.totalPoints)}</span> pts
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <Bar value={g.outputPercentile} label="Output" />
              <Bar value={g.differentialPercentile} label="Unowned" />
              <Bar value={g.valuePercentile} label="Value" />
            </div>

            <div
              className="num flex gap-3 border-t pt-2 text-[11px]"
              style={{ color: 'var(--faint)' }}
            >
              <span title="Expected goal involvement per 90">xGI {fmt(g.xgiPer90, 3)}</span>
              <span title="Defensive contribution per 90">DC {fmt(g.defconPer90, 1)}</span>
              <span title="Expected goals conceded per 90">xGC {fmt(g.xgcPer90, 2)}</span>
              <span title="Points per million">{fmt(g.pointsPerMillion, 1)} pts/£m</span>
            </div>
          </div>
        ))}
      </div>

      {gems.length === 0 && (
        <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
          No players qualify yet — the underlying view needs a season with minutes played.
        </p>
      )}
    </div>
  )
}
