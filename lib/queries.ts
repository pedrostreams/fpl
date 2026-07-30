import { COLUMNS, COLUMNS_BY_KEY, PRESETS } from './columns'
import { num, pool, query } from './db'

/**
 * Every read goes through a view defined in supabase/migrations. Nothing here computes a
 * metric — if a number needs deriving, it belongs in SQL where it can be tested with
 * `python -m sync.cli verify` rather than only by looking at a screen.
 *
 * (One documented exception: percentiles used purely to shade a cell are computed in
 * lib/rank.ts. See the header there for where the line is drawn and why.)
 */

// ---------------------------------------------------------------------------------------
// The wide row: every column, every player, one payload
// ---------------------------------------------------------------------------------------

/** Columnar, not row objects. Keys are written once instead of 558 times — 114 KB → 68 KB. */
export type WideTable = {
  cols: string[]
  rows: unknown[][]
  /** Column key → index, so the client can address a cell without a per-row object. */
  index: Record<string, number>
}

/**
 * Catalogue keys that `player_wide` does not have.
 *
 * A mistyped key would otherwise be invisible: the column simply never appears, the preset
 * silently renders one column short, and nothing errors. Checked once per process against the
 * real result-set metadata rather than against a hardcoded list, so it stays true as the view
 * changes.
 */
function auditCatalogue(available: Set<string>): string[] {
  const missing: string[] = []
  for (const c of COLUMNS) if (!available.has(c.key)) missing.push(`column ${c.key}`)
  for (const p of PRESETS) {
    for (const k of p.columns) {
      if (!available.has(k)) missing.push(`preset ${p.key} → ${k}`)
    }
  }
  return missing
}

let catalogueAudited = false

export async function getPlayerWide(): Promise<WideTable> {
  const result = await pool.query('select * from player_wide')
  const cols = result.fields.map((f) => f.name)

  if (!catalogueAudited) {
    catalogueAudited = true
    const missing = auditCatalogue(new Set(cols))
    if (missing.length) {
      // Loud, and only once. A dropped column is a wrong screen, not a crash, so it has to
      // announce itself somewhere a human will look.
      console.error(
        `[columns] ${missing.length} catalogue entries have no matching column in ` +
          `player_wide:\n  ${missing.join('\n  ')}`,
      )
    }
  }

  // `numeric` arrives as a string from node-postgres. Coercing here, once, means the client
  // never has to know which columns were numeric in Postgres — and sorting never compares
  // "9" against "10" as text.
  const numericCols = new Set(
    result.fields
      .filter((f) => NUMERIC_OIDS.has(f.dataTypeID))
      .map((f) => f.name),
  )
  const coerce = cols.map((c) => numericCols.has(c))

  const rows = result.rows.map((r: Record<string, unknown>) =>
    cols.map((c, i) => (coerce[i] ? num(r[c]) : (r[c] ?? null))),
  )

  return { cols, rows, index: Object.fromEntries(cols.map((c, i) => [c, i])) }
}

// int2, int4, int8, float4, float8, numeric. int8 and numeric are the ones that arrive as
// strings; the rest are listed so the set is a complete answer to "is this a number".
const NUMERIC_OIDS = new Set([21, 23, 20, 700, 701, 1700])

export type SavedView = {
  id: number
  name: string
  columns: string[]
  filters: Record<string, unknown>
  sortKey: string | null
  sortDesc: boolean
}

export async function getSavedViews(): Promise<SavedView[]> {
  const rows = await query<Record<string, unknown>>(
    `select id, name, columns, filters, sort_key, sort_desc
     from saved_views order by lower(name)`,
  )
  return rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    columns: (r.columns as string[]) ?? [],
    filters: (r.filters as Record<string, unknown>) ?? {},
    sortKey: (r.sort_key as string) ?? null,
    sortDesc: Boolean(r.sort_desc),
  }))
}

// ---------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------

export type SearchEntry = {
  kind: 'player' | 'team'
  code: number
  label: string
  sublabel: string | null
  position: string | null
  teamShort: string | null
  /** The club to draw a crest for. On a club row this equals `code`. */
  teamCode: number | null
  haystack: string
  weight: number
}

/**
 * Players and clubs in one list, shipped to the header once.
 *
 * 578 rows, so matching happens in the browser and search is instant everywhere with no
 * round-trip per keystroke. The haystack is lower-cased in SQL rather than per keystroke here.
 */
export async function getSearchIndex(): Promise<SearchEntry[]> {
  const rows = await query<Record<string, unknown>>(
    `select kind, code, label, sublabel, position, team_short, team_code, haystack, weight
     from search_index`,
  )
  return rows.map((r) => ({
    kind: r.kind as 'player' | 'team',
    code: Number(r.code),
    label: String(r.label ?? ''),
    sublabel: (r.sublabel as string) ?? null,
    position: (r.position as string) ?? null,
    teamShort: (r.team_short as string) ?? null,
    teamCode: r.team_code === null || r.team_code === undefined ? null : Number(r.team_code),
    haystack: String(r.haystack ?? ''),
    weight: Number(r.weight ?? 0),
  }))
}

// ---------------------------------------------------------------------------------------
// Player profile
// ---------------------------------------------------------------------------------------

/** One player's `player_wide` row, keyed by code. Null when the code is unknown. */
export async function getPlayerRow(code: number): Promise<Record<string, unknown> | null> {
  const rows = await query<Record<string, unknown>>(
    'select * from player_wide where player_code = $1',
    [code],
  )
  if (!rows.length) return null
  // Coerce every numeric-looking string once, the same reason getPlayerWide does.
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rows[0])) {
    out[k] = typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : v
  }
  return out
}

export type MetricPercentile = {
  metric: string
  value: number | null
  percentile: number | null
  rank: number | null
  poolSize: number | null
  /** False when the pool is too small or the metric does not vary — do not put it in a sentence. */
  quotable: boolean
  higherIsBetter: boolean
}

let directionsAudited = false

/**
 * Where a player sits among others in his position, for every metric worth ranking.
 *
 * The point, in Peder's words: "xGI/90 does not tell me damn shit without context to other
 * midfielders." 0.398 is unreadable; "88th percentile for shots but 35th for xA" is a scouting
 * report.
 */
export async function getPlayerPercentiles(code: number): Promise<Map<string, MetricPercentile>> {
  const rows = await query<Record<string, unknown>>(
    `select metric, value, percentile, position_rank, pool_size, is_quotable, higher_is_better
     from player_metric_percentile where player_code = $1`,
    [code],
  )

  // `higher_is_better` is declared twice — in the view and as `direction` in lib/columns.ts —
  // and a disagreement is the worst kind of bug here: the cell shades green while the sentence
  // beside it reads "worse than 90% of midfielders". Neither is obviously wrong on its own.
  if (!directionsAudited && rows.length) {
    directionsAudited = true
    const clashes: string[] = []
    for (const r of rows) {
      const col = COLUMNS_BY_KEY.get(String(r.metric))
      if (!col || col.direction === 'none') continue
      const sqlSaysHigher = Boolean(r.higher_is_better)
      if (sqlSaysHigher !== (col.direction === 'higher')) {
        clashes.push(
          `${r.metric}: catalogue says ${col.direction}-is-better, ` +
            `player_metric_percentile says ${sqlSaysHigher ? 'higher' : 'lower'}`,
        )
      }
    }
    if (clashes.length) {
      console.error(`[percentiles] direction mismatch:\n  ${clashes.join('\n  ')}`)
    }
  }

  return new Map(
    rows.map((r) => [
      String(r.metric),
      {
        metric: String(r.metric),
        value: num(r.value),
        percentile: num(r.percentile),
        rank: num(r.position_rank),
        poolSize: num(r.pool_size),
        quotable: Boolean(r.is_quotable),
        higherIsBetter: Boolean(r.higher_is_better),
      },
    ]),
  )
}

export type Shot = {
  x: number
  y: number
  xg: number | null
  isGoal: boolean
  bodyPart: string | null
  situation: string | null
  result: string | null
  zone: string | null
  distanceM: number | null
  minute: number | null
}

export async function getPlayerShots(code: number): Promise<Shot[]> {
  const rows = await query<Record<string, unknown>>(
    `select location_x, location_y, xg, is_goal, body_part, situation, result, zone,
            distance_m, minute
     from player_shots where player_code = $1 order by kickoff, minute`,
    [code],
  )
  return rows.map((r) => ({
    x: num(r.location_x) ?? 0,
    y: num(r.location_y) ?? 0.5,
    xg: num(r.xg),
    isGoal: Boolean(r.is_goal),
    bodyPart: (r.body_part as string) ?? null,
    situation: (r.situation as string) ?? null,
    result: (r.result as string) ?? null,
    zone: (r.zone as string) ?? null,
    distanceM: num(r.distance_m),
    minute: num(r.minute),
  }))
}

export type CareerSeason = {
  season: string
  minutes: number | null
  totalPoints: number | null
  goals: number | null
  assists: number | null
  cleanSheets: number | null
  bonus: number | null
  expectedGoals: number | null
  expectedAssists: number | null
  pointsPer90: number | null
  isCurrentSeason: boolean
}

export async function getPlayerCareer(code: number): Promise<CareerSeason[]> {
  const rows = await query<Record<string, unknown>>(
    `select season, minutes, total_points, goals_scored, assists, clean_sheets, bonus,
            expected_goals, expected_assists, points_per_90, is_current_season
     from player_career where player_code = $1 order by season desc`,
    [code],
  )
  return rows.map((r) => ({
    season: String(r.season ?? ''),
    minutes: num(r.minutes),
    totalPoints: num(r.total_points),
    goals: num(r.goals_scored),
    assists: num(r.assists),
    cleanSheets: num(r.clean_sheets),
    bonus: num(r.bonus),
    expectedGoals: num(r.expected_goals),
    expectedAssists: num(r.expected_assists),
    pointsPer90: num(r.points_per_90),
    isCurrentSeason: Boolean(r.is_current_season),
  }))
}

export type UpcomingFixture = {
  gameweek: number | null
  kickoff: string | null
  isHome: boolean
  opponentShort: string | null
  opponentName: string | null
  difficulty: number | null
  positionDifficulty: number | null
  pWin: number | null
  expectedGoalsFor: number | null
  pCleanSheet: number | null
}

export async function getPlayerFixtures(code: number, limit = 6): Promise<UpcomingFixture[]> {
  const rows = await query<Record<string, unknown>>(
    `select gameweek, kickoff_time, is_home, opponent_short, opponent_name, difficulty,
            position_difficulty, p_win, expected_goals_for, p_clean_sheet
     from player_fixtures where player_code = $1 order by gameweek limit $2`,
    [code, limit],
  )
  return rows.map((r) => ({
    gameweek: num(r.gameweek),
    kickoff: r.kickoff_time ? new Date(r.kickoff_time as string).toISOString() : null,
    isHome: Boolean(r.is_home),
    opponentShort: (r.opponent_short as string) ?? null,
    opponentName: (r.opponent_name as string) ?? null,
    difficulty: num(r.difficulty),
    positionDifficulty: num(r.position_difficulty),
    pWin: num(r.p_win),
    expectedGoalsFor: num(r.expected_goals_for),
    pCleanSheet: num(r.p_clean_sheet),
  }))
}

// ---------------------------------------------------------------------------------------
// Club page
// ---------------------------------------------------------------------------------------

export async function getTeamProfile(code: number): Promise<Record<string, unknown> | null> {
  const rows = await query<Record<string, unknown>>(
    'select * from team_profile where team_code = $1',
    [code],
  )
  if (!rows.length) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rows[0])) {
    out[k] = typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : v
  }
  return out
}

/** All 20 clubs shaped for the scatter. Promoted sides come back with nulls, not zeros. */
export async function getTeamScatterPoints(): Promise<
  {
    teamCode: number
    shortName: string
    name: string
    xgPerMatch: number | null
    xgaPerMatch: number | null
    ppda: number | null
    deepCompletions: number | null
    cornerXg: number | null
    points: number | null
    cleanSheetPct: number | null
  }[]
> {
  const rows = await query<Record<string, unknown>>(
    `select team_code, short_name, name, xg_per_match, xga_per_match, ppda,
            deep_completions, corner_xg, last_points, clean_sheet_pct
     from team_profile order by short_name`,
  )
  return rows.map((r) => ({
    teamCode: Number(r.team_code),
    shortName: String(r.short_name ?? ''),
    name: String(r.name ?? ''),
    xgPerMatch: num(r.xg_per_match),
    xgaPerMatch: num(r.xga_per_match),
    ppda: num(r.ppda),
    deepCompletions: num(r.deep_completions),
    cornerXg: num(r.corner_xg),
    points: num(r.last_points),
    cleanSheetPct: num(r.clean_sheet_pct),
  }))
}

export type FormMatch = {
  kickoff: string | null
  isHome: boolean
  opponentShort: string | null
  goals: number | null
  opponentGoals: number | null
  xg: number | null
  opponentXg: number | null
  ppda: number | null
  points: number | null
  expectedPoints: number | null
  pointsOverExpected: number | null
  result: string | null
}

export async function getTeamForm(code: number, limit = 38): Promise<FormMatch[]> {
  const rows = await query<Record<string, unknown>>(
    `select kickoff, is_home, opponent_short, goals, opponent_goals, xg, opponent_xg,
            ppda, points, expected_points, points_over_expected, result
     from team_form where team_code = $1 order by kickoff desc limit $2`,
    [code, limit],
  )
  return rows.map((r) => ({
    kickoff: r.kickoff ? new Date(r.kickoff as string).toISOString() : null,
    isHome: Boolean(r.is_home),
    opponentShort: (r.opponent_short as string) ?? null,
    goals: num(r.goals),
    opponentGoals: num(r.opponent_goals),
    xg: num(r.xg),
    opponentXg: num(r.opponent_xg),
    ppda: num(r.ppda),
    points: num(r.points),
    expectedPoints: num(r.expected_points),
    pointsOverExpected: num(r.points_over_expected),
    result: (r.result as string) ?? null,
  }))
}

// ---------------------------------------------------------------------------------------
// Playing style — migrations 0021 and 0022
// ---------------------------------------------------------------------------------------

/**
 * One measured style axis for one club.
 *
 * `displayValue` and `reliabilityWord` arrive pre-rendered from SQL on purpose. The number of
 * decimals is a property of the metric, and the reliability wording is a function of a
 * measurement — putting either in a component would make it a literal that no check can see.
 * `reliabilityTier` exists so the component can style the three cases without containing any
 * of the three strings.
 *
 * `rank` is null whenever the metric's reliability does not support an ordering, so a caller
 * cannot render a rank the data will not carry. `separated` is the other gate and answers a
 * different question: whether THIS club stands clear of the league by its own error bar.
 */
export type StyleMetric = {
  metric: string
  label: string
  shortLabel: string
  unit: string
  blurb: string | null
  group: string
  groupOrder: number
  sortOrder: number
  direction: string
  /**
   * What the rank is a rank *at*, when "best" is not the answer.
   *
   * Null for every metric with a better end, where "3rd of 17" is unambiguous. Set for PPDA,
   * which orders meaningfully (rank 1 is the most aggressive press) without one end being
   * better — so "2nd of 17" would beg the question.
   */
  rankNoun: string | null
  /** The same, counted from the other end — "least aggressive" for PPDA. */
  rankNounLow: string | null
  value: number | null
  displayValue: string | null
  leagueMean: number | null
  displayLeagueMean: string | null
  stdError: number | null
  rank: number | null
  pool: number | null
  percentile: number | null
  reliability: number | null
  reliabilityWord: string | null
  /**
   * What to print beside the number on one club's page.
   *
   * Differs from `reliabilityWord` only where the two gates disagree: a metric too noisy to
   * order the league can still have a club standing clear of it, and printing the metric-level
   * word alone read as a retraction of the headline right above it.
   */
  standingWord: string | null
  reliabilityTier: number | null
  rankEarned: boolean
  separationZ: number | null
  separated: boolean
  matches: number | null
}

export type StyleGroup = {
  group: string
  title: string
  note: string
  metrics: StyleMetric[]
}

export type StyleRead = {
  summary: string | null
  positionHint: string | null
  claims: number | null
}

export type TeamTrend = {
  metric: string
  label: string
  unit: string
  windowN: number | null
  windowsHeld: number | null
  windowMean: number | null
  seasonMean: number | null
  deltaPct: number | null
  z: number | null
  directionWord: string | null
  basis: string | null
  oppositionGap: number | null
  season: string | null
  phrase: string | null
}

export type EloDrift = {
  elo: number | null
  eloAsOf: string | null
  drift30: number | null
  drift90: number | null
  goalEffect30Pct: number | null
  goalEffect90Pct: number | null
  notable30: boolean
  notable90: boolean
  directionWord: string | null
}

export type TeamStyle = {
  groups: StyleGroup[]
  read: StyleRead | null
  trends: TeamTrend[]
  drift: EloDrift | null
  deadBall: Record<string, number | null> | null
}

/**
 * Everything the style section renders, for one club.
 *
 * Grouped here rather than in the page because the group order is a measured fact — creation
 * leads because it is the firmest property in the data — and `style_group` is where that
 * order is defined.
 */
export async function getTeamStyle(code: number): Promise<TeamStyle> {
  const [metrics, groups, read, trends, drift, deadBall] = await Promise.all([
    query<Record<string, unknown>>(
      `select m.* from team_style_metric m
       where m.team_code = $1 and m.season = (select stats_season from season_context)
       order by m.group_order, m.sort_order`,
      [code],
    ),
    query<Record<string, unknown>>('select * from style_group order by group_order'),
    query<Record<string, unknown>>(
      `select summary, position_hint, claims from team_style_read
       where team_code = $1 and season = (select stats_season from season_context)`,
      [code],
    ),
    // Ordered so that a genuinely current claim outranks one about a finished season, then by
    // how loudly it reads. The page shows at most two.
    query<Record<string, unknown>>(
      `select metric, label, unit, window_n, windows_held, window_mean, season_mean,
              delta_pct, z, direction_word, basis, opposition_gap, season, phrase
       from team_trend where team_code = $1
       order by (basis = 'in_season') desc, abs(z) desc`,
      [code],
    ),
    query<Record<string, unknown>>(
      `select elo, elo_as_of, drift_30, drift_90, goal_effect_30_pct, goal_effect_90_pct,
              notable_30, notable_90, direction_word
       from team_elo_drift where team_code = $1`,
      [code],
    ),
    query<Record<string, unknown>>(
      `select * from team_dead_ball
       where team_code = $1 and season = (select stats_season from season_context)`,
      [code],
    ),
  ])

  const shaped: StyleMetric[] = metrics.map((r) => ({
    metric: String(r.metric),
    label: String(r.label ?? ''),
    shortLabel: String(r.short_label ?? ''),
    unit: String(r.unit ?? ''),
    blurb: (r.blurb as string) ?? null,
    group: String(r.metric_group ?? ''),
    groupOrder: Number(r.group_order ?? 0),
    sortOrder: Number(r.sort_order ?? 0),
    direction: String(r.direction ?? 'none'),
    rankNoun: (r.rank_noun as string) ?? null,
    rankNounLow: (r.rank_noun_low as string) ?? null,
    value: num(r.value),
    displayValue: (r.display_value as string) ?? null,
    leagueMean: num(r.league_mean),
    displayLeagueMean: (r.display_league_mean as string) ?? null,
    stdError: num(r.std_error),
    rank: num(r.metric_rank),
    pool: num(r.pool),
    percentile: num(r.percentile),
    reliability: num(r.reliability),
    reliabilityWord: (r.reliability_word as string) ?? null,
    standingWord: (r.standing_word as string) ?? null,
    reliabilityTier: num(r.reliability_tier),
    rankEarned: Boolean(r.rank_earned),
    separationZ: num(r.separation_z),
    separated: Boolean(r.separated),
    matches: num(r.matches),
  }))

  return {
    groups: groups
      .map((g) => ({
        group: String(g.metric_group),
        title: String(g.title ?? ''),
        note: String(g.note ?? ''),
        metrics: shaped.filter((m) => m.group === String(g.metric_group)),
      }))
      // A group with no metrics is a group that was registered and never populated. Dropping
      // it is right; rendering an empty titled box is not.
      .filter((g) => g.metrics.length > 0),
    read: read.length
      ? {
          summary: (read[0].summary as string) ?? null,
          positionHint: (read[0].position_hint as string) ?? null,
          claims: num(read[0].claims),
        }
      : null,
    trends: trends.map((r) => ({
      metric: String(r.metric),
      label: String(r.label ?? ''),
      unit: String(r.unit ?? ''),
      windowN: num(r.window_n),
      windowsHeld: num(r.windows_held),
      windowMean: num(r.window_mean),
      seasonMean: num(r.season_mean),
      deltaPct: num(r.delta_pct),
      z: num(r.z),
      directionWord: (r.direction_word as string) ?? null,
      basis: (r.basis as string) ?? null,
      oppositionGap: num(r.opposition_gap),
      season: (r.season as string) ?? null,
      phrase: (r.phrase as string) ?? null,
    })),
    drift: drift.length
      ? {
          elo: num(drift[0].elo),
          eloAsOf: drift[0].elo_as_of ? String(drift[0].elo_as_of) : null,
          drift30: num(drift[0].drift_30),
          drift90: num(drift[0].drift_90),
          goalEffect30Pct: num(drift[0].goal_effect_30_pct),
          goalEffect90Pct: num(drift[0].goal_effect_90_pct),
          notable30: Boolean(drift[0].notable_30),
          notable90: Boolean(drift[0].notable_90),
          directionWord: (drift[0].direction_word as string) ?? null,
        }
      : null,
    deadBall: deadBall.length
      ? Object.fromEntries(
          Object.entries(deadBall[0])
            .filter(([k]) => k !== 'season' && k !== 'team_code')
            .map(([k, v]) => [k, num(v)]),
        )
      : null,
  }
}

/** The squad, as `player_wide` rows so the club page can reuse the table's formatters. */
export async function getTeamSquad(code: number): Promise<Record<string, unknown>[]> {
  const rows = await query<Record<string, unknown>>(
    'select * from player_wide where team_code = $1 order by element_type, total_points desc nulls last',
    [code],
  )
  return rows.map((r) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) {
      out[k] = typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : v
    }
    return out
  })
}

export type SeasonContext = {
  currentSeason: string
  statsSeason: string | null
  seasonStarted: boolean
}

export async function getSeasonContext(): Promise<SeasonContext> {
  const rows = await query<Record<string, unknown>>(
    'select current_season, stats_season, season_started from season_context',
  )
  const r = rows[0] ?? {}
  return {
    currentSeason: String(r.current_season ?? ''),
    statsSeason: r.stats_season ? String(r.stats_season) : null,
    seasonStarted: Boolean(r.season_started),
  }
}

export type FormMetric = {
  metric: string
  label: string
  shortLabel: string
  decimals: number
  /** A rate (a mean of 0s and 1s) rather than a count — must render as a percentage. */
  asPercent: boolean
  /** The last six league appearances. */
  window: number | null
  season: number | null
  delta: number | null
  stdError: number | null
  /** Gate 1 — may the position be ordered on a six-match figure of this metric at all. */
  rankEarned: boolean
  rank: number | null
  pool: number | null
  percentile: number | null
  /** Gate 2 — has THIS player's own figure moved, whatever gate 1 says. */
  separated: boolean
  z: number | null
  word: string
  reliability6: number | null
  reliabilitySeason: number | null
}

export type PlayerForm = {
  appearances: number
  /** Absent for the 263 players without six league appearances — new signings and promoted clubs. */
  metrics: FormMetric[]
  basis: string | null
}

export async function getPlayerForm(code: number): Promise<PlayerForm> {
  const rows = await query<Record<string, unknown>>(
    `select metric, label, short_label, decimals, as_percent, window_mean, season_mean, delta, std_error,
            rank_earned, metric_rank, pool, percentile, separated, z, form_word,
            reliability_6, reliability_season, appearances, basis
       from player_form_metric
      where player_code = $1
      order by separated desc, sort_order`,
    [code],
  )
  return {
    appearances: Number(rows[0]?.appearances ?? 0),
    basis: rows[0]?.basis ? String(rows[0].basis) : null,
    metrics: rows.map((r) => ({
      metric: String(r.metric ?? ''),
      label: String(r.label ?? ''),
      shortLabel: String(r.short_label ?? ''),
      decimals: Number(r.decimals ?? 1),
      asPercent: Boolean(r.as_percent),
      window: num(r.window_mean),
      season: num(r.season_mean),
      delta: num(r.delta),
      stdError: num(r.std_error),
      rankEarned: Boolean(r.rank_earned),
      rank: r.metric_rank === null ? null : Number(r.metric_rank),
      pool: r.pool === null ? null : Number(r.pool),
      percentile: num(r.percentile),
      separated: Boolean(r.separated),
      z: num(r.z),
      word: String(r.form_word ?? ''),
      reliability6: num(r.reliability_6),
      reliabilitySeason: num(r.reliability_season),
    })),
  }
}

export type SellCandidate = {
  playerCode: number
  webName: string
  position: string
  teamCode: number | null
  teamShort: string | null
  price: number | null
  selectedByPercent: number | null
  status: string | null
  news: string | null
  /** Reason codes, never a blended score — the reason is the product. */
  reasons: string[]
  reasonCount: number
  /** The reasons as prose, built from the same array so the two cannot drift. */
  sellWord: string
  /** Legitimate and surfaced rather than suppressed: cheap and in form, but his place is going. */
  alsoATarget: boolean
  recentMinutes: number | null
  seasonMinutes: number | null
}

export async function getSellCandidates(limit = 8): Promise<SellCandidate[]> {
  const rows = await query<Record<string, unknown>>(
    `select player_code, web_name, position, team_code, team_short, price,
            selected_by_percent, status, news, sell_reasons, reason_count, sell_word,
            also_a_target, recent_minutes, season_minutes
       from sell_candidates
      order by reason_count desc, selected_by_percent desc nulls last
      limit $1`,
    [limit],
  )
  return rows.map((r) => ({
    playerCode: Number(r.player_code),
    webName: String(r.web_name ?? ''),
    position: String(r.position ?? ''),
    teamCode: r.team_code === null ? null : Number(r.team_code),
    teamShort: (r.team_short as string) ?? null,
    price: num(r.price),
    selectedByPercent: num(r.selected_by_percent),
    status: (r.status as string) ?? null,
    news: (r.news as string) ?? null,
    reasons: (r.sell_reasons as string[]) ?? [],
    reasonCount: Number(r.reason_count ?? 0),
    sellWord: String(r.sell_word ?? ''),
    alsoATarget: Boolean(r.also_a_target),
    recentMinutes: num(r.recent_minutes),
    seasonMinutes: num(r.season_minutes),
  }))
}

export type GameweekShape = {
  event: number
  blanking: number
  doubling: number
  provisional: number
  clubFixtures: number
  shapeWord: string
  blankingClubs: string | null
  doublingClubs: string | null
}

export async function getGameweekShape(from: number, count = 6): Promise<GameweekShape[]> {
  const rows = await query<Record<string, unknown>>(
    `select event, blanking, doubling, provisional, club_fixtures, shape_word,
            blanking_clubs, doubling_clubs
       from gameweek_shape_summary
      where event between $1 and $1 + $2 - 1
      order by event`,
    [from, count],
  )
  return rows.map((r) => ({
    event: Number(r.event),
    blanking: Number(r.blanking ?? 0),
    doubling: Number(r.doubling ?? 0),
    provisional: Number(r.provisional ?? 0),
    clubFixtures: Number(r.club_fixtures ?? 0),
    shapeWord: String(r.shape_word ?? ''),
    blankingClubs: (r.blanking_clubs as string) ?? null,
    doublingClubs: (r.doubling_clubs as string) ?? null,
  }))
}

export type PriceBandValue = {
  position: string
  priceBand: string
  players: number
  avgPoints: number | null
  /** Mean points per £m of start-of-season price. */
  ppm: number | null
  /**
   * Median points per £m, and the more honest of the two. The mean £4.0-4.5m keeper looks like
   * 5.84 while the median is 0.13 — that bucket is bench filler with a few real starters in it,
   * and only the median says so.
   */
  medianPpm: number | null
  bestPpm: number | null
  /** Share of the bucket's points that came from bonus, which the 2026/27 BPS changes rewrite. */
  bonusSharePct: number | null
  playersOverTenMatches: number
}

export async function getPositionPriceValue(): Promise<PriceBandValue[]> {
  const rows = await query<Record<string, unknown>>(`
    select position, price_band, players, avg_points, points_per_million,
           median_points_per_million, best_points_per_million, bonus_share_pct,
           players_over_10_matches
    from position_price_value
    order by element_type, band_order
  `)
  return rows.map((r) => ({
    position: String(r.position ?? ''),
    priceBand: String(r.price_band ?? ''),
    players: Number(r.players ?? 0),
    avgPoints: num(r.avg_points),
    ppm: num(r.points_per_million),
    medianPpm: num(r.median_points_per_million),
    bestPpm: num(r.best_points_per_million),
    bonusSharePct: num(r.bonus_share_pct),
    playersOverTenMatches: Number(r.players_over_10_matches ?? 0),
  }))
}

export type TargetRow = {
  playerCode: number
  webName: string
  position: string
  elementType: number
  teamShort: string | null
  teamCode: number | null
  price: number | null
  selectedByPercent: number | null
  minutes: number | null
  totalPoints: number | null
  xgiPer90: number | null
  defconPer90: number | null
  xgcPer90: number | null
  bpsPer90: number | null
  pointsPerMillion: number | null
  outputPercentile: number | null
  differentialPercentile: number | null
  valuePercentile: number | null
  isAvailable: boolean
  status: string | null
  news: string | null
  penaltiesOrder: number | null
  chanceOfPlaying: number | null
  minutesShare: number | null
  /** 0 means a blank gameweek, and the fixture columns below are all null. */
  fixtureCount: number
  /** `ARS` home, `ars` away, comma-separated over a double. */
  opponents: string | null
  fixtureDifficulty: number | null
  fixtureXgFor: number | null
  fixtureCleanSheets: number | null
  /** Which half of the fixture this player's position actually cares about. */
  fixtureBasis: string | null
  fixtureRank: number | null
  /** The opponent's league rank in the dimension this player exploits. 1 = best, so high is good. */
  opponentRank: number | null
  opponentPerMatch: number | null
  /** Not 20 — promoted clubs have no top-flight record, so the denominator is counted. */
  rankedClubs: number | null
  minutesRank: number | null
  isDifferential: boolean
  score: number | null
}

const TARGET_COLUMNS = `player_code, web_name, position, element_type, team_short, team_code, price,
        selected_by_percent, minutes, total_points, xgi_per_90, defcon_per_90, xgc_per_90,
        bps_per_90, points_per_million, output_percentile, differential_percentile,
        value_percentile, is_available, status, news, penalties_order, chance_of_playing,
        minutes_share, fixture_count, opponents, fixture_difficulty, fixture_xg_for,
        fixture_clean_sheets, fixture_basis, fixture_rank, opponent_rank, opponent_per_match,
        ranked_clubs, minutes_rank`

function toTarget(r: Record<string, unknown>): TargetRow {
  return {
    playerCode: Number(r.player_code),
    webName: String(r.web_name ?? ''),
    position: String(r.position ?? ''),
    elementType: Number(r.element_type),
    teamShort: (r.team_short as string) ?? null,
    teamCode: r.team_code === null || r.team_code === undefined ? null : Number(r.team_code),
    price: num(r.price),
    selectedByPercent: num(r.selected_by_percent),
    minutes: num(r.minutes),
    totalPoints: num(r.total_points),
    xgiPer90: num(r.xgi_per_90),
    defconPer90: num(r.defcon_per_90),
    xgcPer90: num(r.xgc_per_90),
    bpsPer90: num(r.bps_per_90),
    pointsPerMillion: num(r.points_per_million),
    outputPercentile: num(r.output_percentile),
    differentialPercentile: num(r.differential_percentile),
    valuePercentile: num(r.value_percentile),
    isAvailable: Boolean(r.is_available),
    status: (r.status as string) ?? null,
    news: (r.news as string) ?? null,
    penaltiesOrder: num(r.penalties_order),
    chanceOfPlaying: num(r.chance_of_playing),
    minutesShare: num(r.minutes_share),
    fixtureCount: Number(r.fixture_count ?? 0),
    opponents: (r.opponents as string) ?? null,
    fixtureDifficulty: num(r.fixture_difficulty),
    fixtureXgFor: num(r.fixture_xg_for),
    fixtureCleanSheets: num(r.fixture_clean_sheets),
    fixtureBasis: (r.fixture_basis as string) ?? null,
    fixtureRank: num(r.fixture_rank),
    opponentRank: num(r.opponent_rank),
    opponentPerMatch: num(r.opponent_per_match),
    rankedClubs: num(r.ranked_clubs),
    minutesRank: num(r.minutes_rank),
    isDifferential: Boolean(r.is_differential),
    score: num(r.score),
  }
}

/** Under 10% owned. The filter is the page's whole premise, so it stays a filter here. */
export async function getHiddenGems(limit = 60): Promise<TargetRow[]> {
  const rows = await query<Record<string, unknown>>(
    `select ${TARGET_COLUMNS}, true as is_differential, gem_score as score
     from hidden_gems limit $1`,
    [limit],
  )
  return rows.map(toTarget)
}

/**
 * No ownership gate. The dashboard asks who to buy, and excluding Haaland, Saka and Raya from
 * that answer because other people also own them was never defensible — it was one filter
 * doing two jobs. Ownership is shown, and flags a differential, but does not order the list.
 */
export async function getTargetPlayers(limit = 60): Promise<TargetRow[]> {
  const rows = await query<Record<string, unknown>>(
    `select ${TARGET_COLUMNS}, is_differential, target_score as score
     from target_players limit $1`,
    [limit],
  )
  return rows.map(toTarget)
}

export type TeamRow = {
  teamCode: number
  name: string
  shortName: string | null
  /** False for promoted clubs: no prior Premier League season to profile. */
  hasStyleData: boolean
  matches: number | null
  ppda: number | null
  pressRank: number | null
  pressPercentile: number | null
  deepCompletions: number | null
  deepCompletionsConceded: number | null
  xgPerMatch: number | null
  xgaPerMatch: number | null
  xgDifference: number | null
  defenceRank: number | null
  attackingRank: number | null
  defencePercentile: number | null
  xgPercentile: number | null
  cleanSheets: number | null
  cleanSheetPct: number | null
  goals: number | null
  goalsConceded: number | null
  points: number | null
  elo: number | null
}

export async function getTeams(): Promise<TeamRow[]> {
  // Left join from `teams`, not from `team_style`: promoted clubs have no prior-season row
  // and must still appear, flagged, rather than silently vanishing from the league table.
  const rows = await query<Record<string, unknown>>(`
    select
      t.code, t.name, t.short_name,
      s.matches, s.ppda, s.press_intensity_rank, s.press_percentile,
      s.deep_completions, s.deep_completions_conceded,
      s.xg_per_match, s.xga_per_match, s.xg_difference,
      s.defensive_rank, s.attacking_rank, s.defence_percentile, s.xg_percentile,
      s.clean_sheets, s.clean_sheet_pct, s.goals, s.goals_conceded, s.points,
      coalesce(s.current_elo, elo.elo) as elo
    from teams t
    join team_seasons ts
      on ts.team_code = t.code
     and ts.season = (select current_season from season_context)
    left join team_style s
      on s.team_code = t.code
     and s.season = (select stats_season from season_context)
    -- elo_now (migration 0007) rather than a lateral over club_elo: "current Elo" was
    -- defined in two places once the fixture ticker needed it, and two definitions of the
    -- same number is how they drift apart.
    left join elo_now elo on elo.team_code = t.code
    order by s.xg_difference desc nulls last, t.name
  `)
  return rows.map((r) => ({
    teamCode: Number(r.code),
    name: String(r.name ?? ''),
    shortName: (r.short_name as string) ?? null,
    hasStyleData: r.matches !== null && r.matches !== undefined,
    matches: num(r.matches),
    ppda: num(r.ppda),
    pressRank: num(r.press_intensity_rank),
    pressPercentile: num(r.press_percentile),
    deepCompletions: num(r.deep_completions),
    deepCompletionsConceded: num(r.deep_completions_conceded),
    xgPerMatch: num(r.xg_per_match),
    xgaPerMatch: num(r.xga_per_match),
    xgDifference: num(r.xg_difference),
    defenceRank: num(r.defensive_rank),
    attackingRank: num(r.attacking_rank),
    defencePercentile: num(r.defence_percentile),
    xgPercentile: num(r.xg_percentile),
    cleanSheets: num(r.clean_sheets),
    cleanSheetPct: num(r.clean_sheet_pct),
    goals: num(r.goals),
    goalsConceded: num(r.goals_conceded),
    points: num(r.points),
    elo: num(r.elo),
  }))
}

export type TickerFixture = {
  gameweek: number
  opponentShort: string
  opponentName: string
  isHome: boolean
  kickoff: string | null
  /** 0 = easiest, 1 = hardest. Three lenses, because an easy fixture for a striker and an
   *  easy one for a centre-back are not the same fixture. */
  difficulty: number | null
  attackDifficulty: number | null
  defenceDifficulty: number | null
  pWin: number | null
  expectedGoalsFor: number | null
  expectedGoalsAgainst: number | null
  pCleanSheet: number | null
  /** FPL's own integer FDR, kept so the page can show what it adds. */
  fplDifficulty: number | null
}

export type TickerTeam = {
  teamCode: number
  name: string
  shortName: string
  elo: number | null
  /** Indexed by gameweek. Length 0 is a blank, length 2 a double. */
  byGameweek: Record<number, TickerFixture[]>
  run: {
    /** Fixtures left inside the window. Not the same for every club mid-gameweek, which is
     *  why every metric below comes as both a rate and a total. */
    fixtures: number
    avgDifficulty: number | null
    avgAttackDifficulty: number | null
    avgDefenceDifficulty: number | null
    // Per fixture — comparable between clubs whatever the window size.
    pWinPerFixture: number | null
    xgForPerFixture: number | null
    pCleanSheetPerFixture: number | null
    // Summed over the window — what a manager accumulates, and where a double gameweek
    // shows up as a gain. Only comparable between clubs with the same `fixtures`.
    expectedGoalsFor: number | null
    expectedGoalsAgainst: number | null
    expectedCleanSheets: number | null
    expectedWins: number | null
  }
}

export type Ticker = {
  gameweeks: number[]
  teams: TickerTeam[]
}

/**
 * The next six gameweeks per team, from `fixture_difficulty` (migration 0007).
 *
 * The horizon is fixed at six to match the `fixture_run` view's aggregate — a UI control
 * for it would leave the summary column describing a different span from the cells beside
 * it, and re-deriving the aggregate in TypeScript would put a metric outside SQL where
 * `verify` can't check it.
 */
export async function getFixtureTicker(): Promise<Ticker> {
  const rows = await query<Record<string, unknown>>(`
    with horizon as (
      select distinct gameweek from fixture_difficulty
      where not coalesce(finished, false) and gameweek is not null
      order by gameweek limit 6
    )
    select
      fd.gameweek, fd.is_home, fd.kickoff_time,
      fd.difficulty, fd.attack_difficulty, fd.defence_difficulty,
      fd.p_win, fd.expected_goals_for, fd.expected_goals_against, fd.p_clean_sheet,
      fd.fpl_difficulty,
      t.code as team_code, t.name as team_name, t.short_name as team_short,
      o.short_name as opponent_short, o.name as opponent_name,
      e.elo,
      fr.fixtures, fr.avg_difficulty, fr.avg_attack_difficulty, fr.avg_defence_difficulty,
      fr.p_win_per_fixture, fr.xg_for_per_fixture, fr.p_clean_sheet_per_fixture,
      fr.expected_goals_for as run_xg_for, fr.expected_goals_against as run_xg_against,
      fr.expected_clean_sheets, fr.expected_wins
    from fixture_difficulty fd
    join horizon h on h.gameweek = fd.gameweek
    join teams t on t.code = fd.team_code
    join teams o on o.code = fd.opponent_code
    left join elo_now e on e.team_code = fd.team_code
    left join fixture_run fr on fr.team_code = fd.team_code
    where not coalesce(fd.finished, false)
    order by fr.avg_difficulty nulls last, t.name, fd.gameweek, fd.kickoff_time
  `)

  const gameweeks = [...new Set(rows.map((r) => Number(r.gameweek)))].sort(
    (a, b) => a - b,
  )
  const byTeam = new Map<number, TickerTeam>()

  for (const r of rows) {
    const code = Number(r.team_code)
    let team = byTeam.get(code)
    if (!team) {
      team = {
        teamCode: code,
        name: String(r.team_name ?? ''),
        shortName: String(r.team_short ?? ''),
        elo: num(r.elo),
        // Every gameweek in the horizon gets a key, so a blank is an empty array rather
        // than a missing property the renderer has to guess about.
        byGameweek: Object.fromEntries(
          gameweeks.map((gw) => [gw, [] as TickerFixture[]]),
        ),
        run: {
          fixtures: Number(r.fixtures ?? 0),
          avgDifficulty: num(r.avg_difficulty),
          avgAttackDifficulty: num(r.avg_attack_difficulty),
          avgDefenceDifficulty: num(r.avg_defence_difficulty),
          pWinPerFixture: num(r.p_win_per_fixture),
          xgForPerFixture: num(r.xg_for_per_fixture),
          pCleanSheetPerFixture: num(r.p_clean_sheet_per_fixture),
          expectedGoalsFor: num(r.run_xg_for),
          expectedGoalsAgainst: num(r.run_xg_against),
          expectedCleanSheets: num(r.expected_clean_sheets),
          expectedWins: num(r.expected_wins),
        },
      }
      byTeam.set(code, team)
    }
    const gw = Number(r.gameweek)
    team.byGameweek[gw]?.push({
      gameweek: gw,
      opponentShort: String(r.opponent_short ?? ''),
      opponentName: String(r.opponent_name ?? ''),
      isHome: Boolean(r.is_home),
      kickoff: r.kickoff_time ? new Date(r.kickoff_time as string).toISOString() : null,
      difficulty: num(r.difficulty),
      attackDifficulty: num(r.attack_difficulty),
      defenceDifficulty: num(r.defence_difficulty),
      pWin: num(r.p_win),
      expectedGoalsFor: num(r.expected_goals_for),
      expectedGoalsAgainst: num(r.expected_goals_against),
      pCleanSheet: num(r.p_clean_sheet),
      fplDifficulty: num(r.fpl_difficulty),
    })
  }

  return { gameweeks, teams: [...byTeam.values()] }
}

export type SnapshotCoverage = {
  rows: number
  players: number
  /** Distinct capture instants that wrote at least one row. */
  instants: number
  firstChange: string | null
  lastChange: string | null
  changeSpanHours: number | null
  minutesSinceLastChange: number | null
  /** When the job last RAN, which is the health signal — see the note in migration 0009. */
  lastRun: string | null
  minutesSinceLastRun: number | null
  covers24h: boolean
  covers7d: boolean
}

export async function getSnapshotCoverage(): Promise<SnapshotCoverage> {
  const rows = await query<Record<string, unknown>>('select * from snapshot_coverage')
  const r = rows[0] ?? {}
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null)
  return {
    rows: Number(r.rows ?? 0),
    players: Number(r.players ?? 0),
    instants: Number(r.instants ?? 0),
    firstChange: iso(r.first_change),
    lastChange: iso(r.last_change),
    changeSpanHours: num(r.change_span_hours),
    minutesSinceLastChange: num(r.minutes_since_last_change),
    lastRun: iso(r.last_run),
    minutesSinceLastRun: num(r.minutes_since_last_run),
    covers24h: Boolean(r.covers_24h),
    covers7d: Boolean(r.covers_7d),
  }
}

export type MovementRow = {
  playerCode: number
  webName: string
  position: string | null
  teamShort: string | null
  teamCode: number | null
  price: number | null
  selectedByPercent: number | null
  status: string | null
  news: string | null
  chanceOfPlaying: number | null
  totalPoints: number | null
  form: number | null
  /** FPL's own price predictor, new for 2026/27. An input signal, not a rival. */
  priceChangePercent: number | null
  costChangeEvent: number | null
  costChangeStart: number | null
  transfersInEvent: number | null
  transfersOutEvent: number | null
  netTransfersEvent: number | null
  /** False until the series reaches back 24h. Deltas are then null, never 0. */
  has24hHistory: boolean
  priceDelta24h: number | null
  ownershipDelta24h: number | null
  netTransfers24h: number | null
  has7dHistory: boolean
  priceDelta7d: number | null
  ownershipDelta7d: number | null
  netTransfers7d: number | null
}

export async function getMovement(): Promise<MovementRow[]> {
  const rows = await query<Record<string, unknown>>(`
    select player_code, web_name, position, team_short, team_code, price, selected_by_percent,
           status, news, chance_of_playing_next_round, total_points, form,
           price_change_percent, cost_change_event, cost_change_start,
           transfers_in_event, transfers_out_event, net_transfers_event,
           has_24h_history, price_delta_24h, ownership_delta_24h, net_transfers_24h,
           has_7d_history, price_delta_7d, ownership_delta_7d, net_transfers_7d
    from player_movement
    order by selected_by_percent desc nulls last
  `)
  return rows.map((r) => ({
    playerCode: Number(r.player_code),
    webName: String(r.web_name ?? ''),
    position: (r.position as string) ?? null,
    teamShort: (r.team_short as string) ?? null,
    teamCode: r.team_code === null || r.team_code === undefined ? null : Number(r.team_code),
    price: num(r.price),
    selectedByPercent: num(r.selected_by_percent),
    status: (r.status as string) ?? null,
    news: (r.news as string) ?? null,
    chanceOfPlaying: num(r.chance_of_playing_next_round),
    totalPoints: num(r.total_points),
    form: num(r.form),
    priceChangePercent: num(r.price_change_percent),
    costChangeEvent: num(r.cost_change_event),
    costChangeStart: num(r.cost_change_start),
    transfersInEvent: num(r.transfers_in_event),
    transfersOutEvent: num(r.transfers_out_event),
    netTransfersEvent: num(r.net_transfers_event),
    has24hHistory: Boolean(r.has_24h_history),
    priceDelta24h: num(r.price_delta_24h),
    ownershipDelta24h: num(r.ownership_delta_24h),
    netTransfers24h: num(r.net_transfers_24h),
    has7dHistory: Boolean(r.has_7d_history),
    priceDelta7d: num(r.price_delta_7d),
    ownershipDelta7d: num(r.ownership_delta_7d),
    netTransfers7d: num(r.net_transfers_7d),
  }))
}

// --------------------------------------------------------------------------- //
// The dashboard
// --------------------------------------------------------------------------- //

/** Just the codes, for the scout table's hearts. A Set keeps the row render O(1). */
export async function getWatchlistCodes(): Promise<number[]> {
  const rows = await query<{ player_code: number }>(
    'select player_code from watchlist order by added_at desc',
  )
  return rows.map((r) => Number(r.player_code))
}

export type WatchRow = {
  playerCode: number
  webName: string
  position: string
  teamShort: string | null
  teamCode: number | null
  price: number | null
  selectedByPercent: number | null
  status: string | null
  news: string | null
  isAvailable: boolean
  totalPoints: number | null
  xgiPer90: number | null
  pointsPerMillion: number | null
  outputPercentile: number | null
  isColdStart: boolean
  note: string | null
  netTransfersEvent: number | null
  ownershipDelta24h: number | null
  has24hHistory: boolean
  /** Next fixture, so "bring them in this week?" is answerable without leaving the page. */
  opponentShort: string | null
  isHome: boolean | null
  nextDifficulty: number | null
  nextPCleanSheet: number | null
}

export async function getWatchlist(): Promise<WatchRow[]> {
  const rows = await query<Record<string, unknown>>(`
    select player_code, web_name, position, team_short, team_code, price, selected_by_percent,
           status, news, is_available, total_points, xgi_per_90, points_per_million,
           output_percentile, is_cold_start, note,
           net_transfers_event, ownership_delta_24h, has_24h_history,
           opponent_short, is_home, next_difficulty, next_p_clean_sheet
    from watchlist_detail
    order by added_at desc
  `)
  return rows.map((r) => ({
    playerCode: Number(r.player_code),
    webName: String(r.web_name ?? ''),
    position: String(r.position ?? ''),
    teamShort: (r.team_short as string) ?? null,
    teamCode: r.team_code === null || r.team_code === undefined ? null : Number(r.team_code),
    price: num(r.price),
    selectedByPercent: num(r.selected_by_percent),
    status: (r.status as string) ?? null,
    news: (r.news as string) ?? null,
    isAvailable: Boolean(r.is_available),
    totalPoints: num(r.total_points),
    xgiPer90: num(r.xgi_per_90),
    pointsPerMillion: num(r.points_per_million),
    outputPercentile: num(r.output_percentile),
    isColdStart: Boolean(r.is_cold_start),
    note: (r.note as string) ?? null,
    netTransfersEvent: num(r.net_transfers_event),
    ownershipDelta24h: num(r.ownership_delta_24h),
    has24hHistory: Boolean(r.has_24h_history),
    opponentShort: (r.opponent_short as string) ?? null,
    isHome: r.is_home === null || r.is_home === undefined ? null : Boolean(r.is_home),
    nextDifficulty: num(r.next_difficulty),
    nextPCleanSheet: num(r.next_p_clean_sheet),
  }))
}

export type CaptainPick = {
  playerCode: number
  webName: string
  position: string
  teamShort: string | null
  teamCode: number | null
  price: number | null
  selectedByPercent: number | null
  opponentShort: string | null
  opponentName: string | null
  isHome: boolean
  gameweek: number | null
  xgiPer90: number | null
  penaltiesOrder: number | null
  /** Share of the team's available minutes. The fix for a "Safe" axis that ranked a player
   *  on 17% of a season identically to one on 86%. */
  minutesShare: number | null
  startRate: number | null
  chanceOfPlaying: number | null
  minutes: number | null
  /** Poisson from the fixture model's lambda — what a captain actually depends on. */
  pTeamScores: number | null
  pTeamScores2Plus: number | null
  bigChancesPer90: number | null
  shotsInBoxPer90: number | null
  nonPenaltyXgPer90: number | null
  hasShotData: boolean
  /** Two axes, not one: a safe armband and an explosive one are different questions. */
  floorScore: number | null
  ceilingScore: number | null
  combinedScore: number | null
  /** The component percentile ranks, so the ranking can be argued with. */
  ranks: {
    minutes: number | null
    teamScores: number | null
    involvement: number | null
    bigChances: number | null
    shotsInBox: number | null
    teamScores2: number | null
    npXg: number | null
  }
}

export async function getCaptainPicks(limit = 10): Promise<CaptainPick[]> {
  const rows = await query<Record<string, unknown>>(
    `select player_code, web_name, position, team_short, team_code, price, selected_by_percent,
            opponent_short, opponent_name, is_home, gameweek, xgi_per_90,
            minutes, minutes_share, start_rate, chance_of_playing,
            penalties_order, p_team_scores, p_team_scores_2plus,
            big_chances_per_90, shots_in_box_per_90, non_penalty_xg_per_90, has_shot_data,
            floor_score, ceiling_score, combined_score,
            rank_minutes, rank_team_scores, rank_involvement, rank_big_chances,
            rank_shots_in_box, rank_team_scores_2, rank_np_xg
     from captain_picks limit $1`,
    [limit],
  )
  return rows.map((r) => ({
    playerCode: Number(r.player_code),
    webName: String(r.web_name ?? ''),
    position: String(r.position ?? ''),
    teamShort: (r.team_short as string) ?? null,
    teamCode: r.team_code === null || r.team_code === undefined ? null : Number(r.team_code),
    price: num(r.price),
    selectedByPercent: num(r.selected_by_percent),
    opponentShort: (r.opponent_short as string) ?? null,
    opponentName: (r.opponent_name as string) ?? null,
    isHome: Boolean(r.is_home),
    gameweek: num(r.gameweek),
    xgiPer90: num(r.xgi_per_90),
    penaltiesOrder: num(r.penalties_order),
    minutesShare: num(r.minutes_share),
    startRate: num(r.start_rate),
    chanceOfPlaying: num(r.chance_of_playing),
    minutes: num(r.minutes),
    pTeamScores: num(r.p_team_scores),
    pTeamScores2Plus: num(r.p_team_scores_2plus),
    bigChancesPer90: num(r.big_chances_per_90),
    shotsInBoxPer90: num(r.shots_in_box_per_90),
    nonPenaltyXgPer90: num(r.non_penalty_xg_per_90),
    hasShotData: Boolean(r.has_shot_data),
    floorScore: num(r.floor_score),
    ceilingScore: num(r.ceiling_score),
    combinedScore: num(r.combined_score),
    ranks: {
      minutes: num(r.rank_minutes),
      teamScores: num(r.rank_team_scores),
      involvement: num(r.rank_involvement),
      bigChances: num(r.rank_big_chances),
      shotsInBox: num(r.rank_shots_in_box),
      teamScores2: num(r.rank_team_scores_2),
      npXg: num(r.rank_np_xg),
    },
  }))
}

export type Manager = {
  entryId: number
  name: string | null
  playerName: string | null
  favouriteTeam: string | null
  startedEvent: number | null
  currentEvent: number | null
  overallPoints: number | null
  overallRank: number | null
  seasons: { seasonName: string; totalPoints: number | null; rank: number | null }[]
}

export async function getManager(): Promise<Manager | null> {
  const rows = await query<Record<string, unknown>>(`
    select m.entry_id, m.name, m.player_name, m.started_event, m.current_event,
           m.overall_points, m.overall_rank, t.name as favourite_team
    from managers m
    left join teams t on t.code = m.favourite_team
    order by m.entry_id limit 1
  `)
  if (!rows.length) return null
  const m = rows[0]
  const seasons = await query<Record<string, unknown>>(
    `select season_name, total_points, rank from manager_seasons
     where entry_id = $1 order by season_name desc`,
    [Number(m.entry_id)],
  )
  return {
    entryId: Number(m.entry_id),
    name: (m.name as string) ?? null,
    playerName: (m.player_name as string) ?? null,
    favouriteTeam: (m.favourite_team as string) ?? null,
    startedEvent: num(m.started_event),
    currentEvent: num(m.current_event),
    overallPoints: num(m.overall_points),
    overallRank: num(m.overall_rank),
    seasons: seasons.map((s) => ({
      seasonName: String(s.season_name),
      totalPoints: num(s.total_points),
      rank: num(s.rank),
    })),
  }
}

export type NextMatch = {
  gameweek: number | null
  kickoff: string | null
  homeShort: string
  awayShort: string
  homeName: string
  awayName: string
  pHome: number | null
  pDraw: number | null
  pAway: number | null
  expectedGoals: number | null
}

/** One row per match, not per team — `fixture_difficulty` holds both sides, so take the home. */
export async function getNextMatches(limit = 10): Promise<NextMatch[]> {
  const rows = await query<Record<string, unknown>>(
    `select fd.gameweek, fd.kickoff_time,
            h.short_name as home_short, h.name as home_name,
            a.short_name as away_short, a.name as away_name,
            fd.p_win as p_home, fd.p_draw, fd.p_lose as p_away,
            (fd.expected_goals_for + fd.expected_goals_against) as expected_goals
     from fixture_difficulty fd
     join teams h on h.code = fd.team_code
     join teams a on a.code = fd.opponent_code
     where fd.is_home
       and fd.gameweek = (select gameweek from next_gameweek)
       and not coalesce(fd.finished, false)
     order by fd.kickoff_time, h.name
     limit $1`,
    [limit],
  )
  return rows.map((r) => ({
    gameweek: num(r.gameweek),
    kickoff: r.kickoff_time ? new Date(r.kickoff_time as string).toISOString() : null,
    homeShort: String(r.home_short ?? ''),
    awayShort: String(r.away_short ?? ''),
    homeName: String(r.home_name ?? ''),
    awayName: String(r.away_name ?? ''),
    pHome: num(r.p_home),
    pDraw: num(r.p_draw),
    pAway: num(r.p_away),
    expectedGoals: num(r.expected_goals),
  }))
}

export type TeamTarget = {
  teamCode: number
  name: string
  shortName: string
  fixtures: number
  firstGameweek: number | null
  lastGameweek: number | null
  homeFixtures: number | null
  avgDifficulty: number | null
  avgAttackDifficulty: number | null
  avgDefenceDifficulty: number | null
  pWinPerFixture: number | null
  xgForPerFixture: number | null
  pCleanSheetPerFixture: number | null
  elo: number | null
  /** The run itself, so the dashboard can show who they actually play. */
  opponents: { opponentShort: string; isHome: boolean; difficulty: number | null }[]
}

/**
 * Best runs over the ticker's six-gameweek horizon.
 *
 * Ordered by the per-fixture rate, never the total — mid-gameweek the windows differ in size
 * and the totals reward simply having more fixtures left. Same reasoning as migration 0008.
 */
export async function getTeamTargets(
  lens: 'overall' | 'attack' | 'defence' = 'overall',
  limit = 6,
): Promise<TeamTarget[]> {
  const column = {
    overall: 'fr.avg_difficulty',
    attack: 'fr.avg_attack_difficulty',
    defence: 'fr.avg_defence_difficulty',
  }[lens]

  const rows = await query<Record<string, unknown>>(
    `select t.code, t.name, t.short_name, fr.fixtures, fr.first_gameweek, fr.last_gameweek,
            fr.home_fixtures, fr.avg_difficulty, fr.avg_attack_difficulty,
            fr.avg_defence_difficulty, fr.p_win_per_fixture, fr.xg_for_per_fixture,
            fr.p_clean_sheet_per_fixture, e.elo,
            (select json_agg(json_build_object(
                      'opponentShort', o.short_name,
                      'isHome', fd.is_home,
                      'difficulty', fd.difficulty) order by fd.gameweek, fd.kickoff_time)
               from fixture_difficulty fd
               join teams o on o.code = fd.opponent_code
              where fd.team_code = t.code
                and fd.gameweek between fr.first_gameweek and fr.last_gameweek
                and not coalesce(fd.finished, false)) as opponents
     from fixture_run fr
     join teams t on t.code = fr.team_code
     left join elo_now e on e.team_code = t.code
     order by ${column} asc nulls last
     limit $1`,
    [limit],
  )
  return rows.map((r) => ({
    teamCode: Number(r.code),
    name: String(r.name ?? ''),
    shortName: String(r.short_name ?? ''),
    fixtures: Number(r.fixtures ?? 0),
    firstGameweek: num(r.first_gameweek),
    lastGameweek: num(r.last_gameweek),
    homeFixtures: num(r.home_fixtures),
    avgDifficulty: num(r.avg_difficulty),
    avgAttackDifficulty: num(r.avg_attack_difficulty),
    avgDefenceDifficulty: num(r.avg_defence_difficulty),
    pWinPerFixture: num(r.p_win_per_fixture),
    xgForPerFixture: num(r.xg_for_per_fixture),
    pCleanSheetPerFixture: num(r.p_clean_sheet_per_fixture),
    elo: num(r.elo),
    opponents: ((r.opponents as unknown[]) ?? []).map((o) => {
      const x = o as Record<string, unknown>
      return {
        opponentShort: String(x.opponentShort ?? ''),
        isHome: Boolean(x.isHome),
        difficulty: num(x.difficulty),
      }
    }),
  }))
}

export type FormPlayer = {
  playerCode: number
  webName: string
  position: string
  teamShort: string | null
  teamCode: number | null
  price: number | null
  selectedByPercent: number | null
  totalPoints: number | null
  pointsPer90: number | null
  xgiPer90: number | null
  goalsMinusXg: number | null
  outputPercentile: number | null
  formValue: number | null
  /** Shown beside the rate: a per-90 without its sample size is not checkable. */
  minutes: number | null
  /** 'form' once FPL's 30-day average is live, 'last_season_rate' before that. */
  basis: string
}

export async function getFormPlayers(limit = 8): Promise<FormPlayer[]> {
  const rows = await query<Record<string, unknown>>(
    `select player_code, web_name, position, team_short, team_code, price, selected_by_percent,
            total_points, points_per_90, xgi_per_90, goals_minus_xg, output_percentile,
            minutes, form_value, basis
     from form_players limit $1`,
    [limit],
  )
  return rows.map((r) => ({
    playerCode: Number(r.player_code),
    webName: String(r.web_name ?? ''),
    position: String(r.position ?? ''),
    teamShort: (r.team_short as string) ?? null,
    teamCode: r.team_code === null || r.team_code === undefined ? null : Number(r.team_code),
    price: num(r.price),
    selectedByPercent: num(r.selected_by_percent),
    totalPoints: num(r.total_points),
    pointsPer90: num(r.points_per_90),
    xgiPer90: num(r.xgi_per_90),
    goalsMinusXg: num(r.goals_minus_xg),
    outputPercentile: num(r.output_percentile),
    formValue: num(r.form_value),
    minutes: num(r.minutes),
    basis: String(r.basis ?? ''),
  }))
}

export type SyncHealth = {
  job: string
  lastOk: string | null
  lastAttempt: string | null
  ageSeconds: number | null
  errors24h: number | null
}

export async function getSyncHealth(): Promise<SyncHealth[]> {
  const rows = await query<Record<string, unknown>>(`
    select job, last_ok, last_attempt, extract(epoch from age)::int as age_seconds, errors_24h
    from sync_freshness order by job
  `)
  return rows.map((r) => ({
    job: String(r.job),
    lastOk: r.last_ok ? new Date(r.last_ok as string).toISOString() : null,
    lastAttempt: r.last_attempt ? new Date(r.last_attempt as string).toISOString() : null,
    ageSeconds: num(r.age_seconds),
    errors24h: num(r.errors_24h),
  }))
}

export type DispatchHealth = {
  workflow: string
  dispatches24h: number | null
  ok24h: number | null
  failed24h: number | null
  pending: number | null
  minutesSinceLast: number | null
  lastError: string | null
}

/**
 * The thing to read when captures go quiet.
 *
 * `sync_runs` alone cannot tell "the token is dead" from "the job is unscheduled" from "GitHub is
 * fine and nothing moved" — all three look like an absence of rows. This separates them, which is
 * why migration 0019 built it when the hourly clock moved into pg_cron.
 */
export async function getDispatchHealth(): Promise<DispatchHealth[]> {
  const rows = await query<Record<string, unknown>>(`
    select workflow, dispatches_24h, ok_24h, failed_24h, pending,
           minutes_since_last, last_error
    from workflow_dispatch_health order by workflow
  `)
  return rows.map((r) => ({
    workflow: String(r.workflow),
    dispatches24h: num(r.dispatches_24h),
    ok24h: num(r.ok_24h),
    failed24h: num(r.failed_24h),
    pending: num(r.pending),
    minutesSinceLast: num(r.minutes_since_last),
    lastError: r.last_error ? String(r.last_error) : null,
  }))
}

// ---------------------------------------------------------------------------------------
// My team (W1) and the mini-league (W4)
// ---------------------------------------------------------------------------------------
// Both are empty until the GW1 deadline and both say so on screen rather than rendering a
// zero. FPL publishes no squad before 2026-08-21 17:30 UTC — see migration 0034.

export type SquadPlayer = {
  playerCode: number
  webName: string
  position: string
  teamCode: number
  teamShort: string
  pickPosition: number
  multiplier: number
  isCaptain: boolean
  isVice: boolean
  inXi: boolean
  price: number | null
  selectedByPercent: number | null
  totalPoints: number | null
  xgiPer90: number | null
  defconPer90: number | null
  minutesShare: number | null
  status: string | null
  news: string | null
  chanceOfPlaying: number | null
  fixtureCount: number
  opponents: string | null
  pCleanSheet: number | null
  pTeamScores: number | null
  riskWord: string | null
  riskReasons: string[]
}

export type Squad = {
  event: number | null
  players: SquadPlayer[]
}

export async function getMySquad(): Promise<Squad> {
  const rows = await query<Record<string, unknown>>(`
    select * from my_squad order by pick_position
  `)
  return {
    event: rows.length ? num(rows[0].event) : null,
    players: rows.map((r) => ({
      playerCode: Number(r.player_code),
      webName: String(r.web_name),
      position: String(r.position),
      teamCode: Number(r.team_code),
      teamShort: String(r.team_short ?? ''),
      pickPosition: Number(r.pick_position),
      multiplier: Number(r.multiplier),
      isCaptain: Boolean(r.is_captain),
      isVice: Boolean(r.is_vice),
      inXi: Boolean(r.in_xi),
      price: num(r.price),
      selectedByPercent: num(r.selected_by_percent),
      totalPoints: num(r.total_points),
      xgiPer90: num(r.xgi_per_90),
      defconPer90: num(r.defcon_per_90),
      minutesShare: num(r.minutes_share),
      status: (r.status as string) ?? null,
      news: (r.news as string) ?? null,
      chanceOfPlaying: num(r.chance_of_playing),
      fixtureCount: Number(r.fixture_count ?? 0),
      opponents: (r.opponents as string) ?? null,
      pCleanSheet: num(r.p_clean_sheet),
      pTeamScores: num(r.p_team_scores),
      riskWord: (r.risk_word as string) ?? null,
      riskReasons: (r.risk_reasons as string[]) ?? [],
    })),
  }
}

export type LeagueMember = {
  entryId: number
  entryName: string | null
  playerName: string | null
  rank: number | null
  lastRank: number | null
  total: number | null
  eventTotal: number | null
  source: string
}

export type League = {
  leagueId: number
  name: string | null
  adminEntry: number | null
  startEvent: number | null
  members: LeagueMember[]
} | null

export async function getLeague(): Promise<League> {
  const rows = await query<Record<string, unknown>>(
    `select league_id, name, admin_entry, start_event from leagues order by league_id limit 1`,
  )
  if (!rows.length) return null
  const l = rows[0]
  const members = await query<Record<string, unknown>>(
    // Standings order once it exists; before that, join order, which is the only order there is.
    `select entry_id, entry_name, player_name, rank, last_rank, total, event_total, source
     from league_entries where league_id = $1
     order by rank nulls last, joined_at nulls last, entry_id`,
    [Number(l.league_id)],
  )
  return {
    leagueId: Number(l.league_id),
    name: (l.name as string) ?? null,
    adminEntry: num(l.admin_entry),
    startEvent: num(l.start_event),
    members: members.map((m) => ({
      entryId: Number(m.entry_id),
      entryName: (m.entry_name as string) ?? null,
      playerName: (m.player_name as string) ?? null,
      rank: num(m.rank),
      lastRank: num(m.last_rank),
      total: num(m.total),
      eventTotal: num(m.event_total),
      source: String(m.source),
    })),
  }
}

export type OwnershipRow = {
  playerCode: number
  webName: string
  position: string
  teamCode: number
  teamShort: string
  price: number | null
  owners: number
  rivals: number
  starters: number
  captains: number
  ownedPct: number | null
  effectiveOwnership: number | null
  selectedByPercent: number | null
  eoMinusGlobal: number | null
  opponents: string | null
}

export async function getLeagueOwnership(limit = 40): Promise<OwnershipRow[]> {
  const rows = await query<Record<string, unknown>>(
    `select * from league_ownership order by effective_ownership desc, owners desc limit $1`,
    [limit],
  )
  return rows.map((r) => ({
    playerCode: Number(r.player_code),
    webName: String(r.web_name),
    position: String(r.position),
    teamCode: Number(r.team_code),
    teamShort: String(r.team_short ?? ''),
    price: num(r.price),
    owners: Number(r.owners),
    rivals: Number(r.rivals),
    starters: Number(r.starters),
    captains: Number(r.captains),
    ownedPct: num(r.owned_pct),
    effectiveOwnership: num(r.effective_ownership),
    selectedByPercent: num(r.selected_by_percent),
    eoMinusGlobal: num(r.eo_minus_global),
    opponents: (r.opponents as string) ?? null,
  }))
}

// ---------------------------------------------------------------------------------------
// What changed (W2)
// ---------------------------------------------------------------------------------------

export type ChangeEvent = {
  kind: 'price' | 'availability' | 'set_piece' | 'market'
  at: string
  playerCode: number | null
  teamCode: number | null
  webName: string | null
  position: string | null
  teamShort: string | null
  delta: number | null
  before: string | null
  after: string | null
  note: string | null
  isWatched: boolean
  isMine: boolean
}

/**
 * Newest first, capped. The cap is a render budget, not an editorial judgement — the view ranks
 * nothing and filters nothing, because a feed that decides what matters is a feed that hides the
 * thing you were looking for.
 */
export async function getChangeFeed(limit = 120): Promise<ChangeEvent[]> {
  const rows = await query<Record<string, unknown>>(
    `select kind, at, player_code, team_code, web_name, position, team_short,
            delta, before, after, note, is_watched, is_mine
     from change_feed_detail order by at desc limit $1`,
    [limit],
  )
  return rows.map((r) => ({
    kind: r.kind as ChangeEvent['kind'],
    at: new Date(r.at as string).toISOString(),
    playerCode: num(r.player_code),
    teamCode: num(r.team_code),
    webName: (r.web_name as string) ?? null,
    position: (r.position as string) ?? null,
    teamShort: (r.team_short as string) ?? null,
    delta: num(r.delta),
    before: (r.before as string) ?? null,
    after: (r.after as string) ?? null,
    note: (r.note as string) ?? null,
    isWatched: Boolean(r.is_watched),
    isMine: Boolean(r.is_mine),
  }))
}
