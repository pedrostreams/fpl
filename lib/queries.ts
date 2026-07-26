import { num, query } from './db'

/**
 * Every read goes through a view defined in supabase/migrations. Nothing here computes a
 * metric — if a number needs deriving, it belongs in SQL where it can be tested with
 * `python -m sync.cli verify` rather than only by looking at a screen.
 */

export type ScoutRow = {
  playerCode: number
  webName: string
  position: 'GKP' | 'DEF' | 'MID' | 'FWD'
  elementType: number
  teamShort: string | null
  teamName: string | null
  age: number | null
  price: number | null
  selectedByPercent: number | null
  status: string | null
  news: string | null
  isAvailable: boolean
  chanceOfPlaying: number | null
  minutes: number | null
  starts: number | null
  totalPoints: number | null
  pointsPer90: number | null
  xgPer90: number | null
  xaPer90: number | null
  xgiPer90: number | null
  xgcPer90: number | null
  defconPer90: number | null
  defconThreshold: number | null
  bpsPer90: number | null
  goalsMinusXg: number | null
  assistsMinusXa: number | null
  xgBuildupPer90: number | null
  pointsPerMillion: number | null
  otherMinutes: number | null
  pctMinutesOutsideLeague: number | null
  penaltiesOrder: number | null
  freekicksOrder: number | null
  cornersOrder: number | null
  isColdStart: boolean
  hasReliableSample: boolean
  // Percentiles, 0–1 within position. Null when the sample is too small to rank.
  pct: {
    xgi: number | null
    xg: number | null
    xa: number | null
    defcon: number | null
    xgc: number | null
    points: number | null
    bps: number | null
    value: number | null
    differential: number | null
    output: number | null
  }
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

export async function getScoutRows(): Promise<ScoutRow[]> {
  // Explicit column list rather than `select *`: player_scout exposes ~70 columns and the
  // whole result is serialised to the client so the table can sort and filter without a
  // round-trip. Sending only what is rendered keeps that payload honest.
  const rows = await query<Record<string, unknown>>(`
    select
      player_code, web_name, position, element_type, team_short, team_name, age,
      price, selected_by_percent, status, news, is_available,
      chance_of_playing_next_round,
      minutes, starts, total_points, points_per_90,
      xg_per_90, xa_per_90, xgi_per_90, xgc_per_90,
      defcon_per_90, defcon_threshold, bps_per_90,
      goals_minus_xg, assists_minus_xa, xg_buildup_per_90,
      points_per_million, other_minutes, pct_minutes_outside_league,
      penalties_order, direct_freekicks_order, corners_order,
      is_cold_start, has_reliable_sample,
      xgi_per_90_percentile, xg_per_90_percentile, xa_per_90_percentile,
      defcon_per_90_percentile, xgc_per_90_percentile, points_per_90_percentile,
      bps_per_90_percentile, value_percentile, differential_percentile,
      output_percentile
    from player_scout
    order by total_points desc nulls last, minutes desc nulls last
  `)

  return rows.map((r) => ({
    playerCode: Number(r.player_code),
    webName: String(r.web_name ?? ''),
    position: (r.position ?? 'MID') as ScoutRow['position'],
    elementType: Number(r.element_type),
    teamShort: (r.team_short as string) ?? null,
    teamName: (r.team_name as string) ?? null,
    age: num(r.age),
    price: num(r.price),
    selectedByPercent: num(r.selected_by_percent),
    status: (r.status as string) ?? null,
    news: (r.news as string) ?? null,
    isAvailable: Boolean(r.is_available),
    chanceOfPlaying: num(r.chance_of_playing_next_round),
    minutes: num(r.minutes),
    starts: num(r.starts),
    totalPoints: num(r.total_points),
    pointsPer90: num(r.points_per_90),
    xgPer90: num(r.xg_per_90),
    xaPer90: num(r.xa_per_90),
    xgiPer90: num(r.xgi_per_90),
    xgcPer90: num(r.xgc_per_90),
    defconPer90: num(r.defcon_per_90),
    defconThreshold: num(r.defcon_threshold),
    bpsPer90: num(r.bps_per_90),
    goalsMinusXg: num(r.goals_minus_xg),
    assistsMinusXa: num(r.assists_minus_xa),
    xgBuildupPer90: num(r.xg_buildup_per_90),
    pointsPerMillion: num(r.points_per_million),
    otherMinutes: num(r.other_minutes),
    pctMinutesOutsideLeague: num(r.pct_minutes_outside_league),
    penaltiesOrder: num(r.penalties_order),
    freekicksOrder: num(r.direct_freekicks_order),
    cornersOrder: num(r.corners_order),
    isColdStart: Boolean(r.is_cold_start),
    hasReliableSample: Boolean(r.has_reliable_sample),
    pct: {
      xgi: num(r.xgi_per_90_percentile),
      xg: num(r.xg_per_90_percentile),
      xa: num(r.xa_per_90_percentile),
      defcon: num(r.defcon_per_90_percentile),
      xgc: num(r.xgc_per_90_percentile),
      points: num(r.points_per_90_percentile),
      bps: num(r.bps_per_90_percentile),
      value: num(r.value_percentile),
      differential: num(r.differential_percentile),
      output: num(r.output_percentile),
    },
  }))
}

export type GemRow = {
  playerCode: number
  webName: string
  position: string
  teamShort: string | null
  price: number | null
  selectedByPercent: number | null
  minutes: number | null
  totalPoints: number | null
  xgiPer90: number | null
  defconPer90: number | null
  xgcPer90: number | null
  pointsPerMillion: number | null
  outputPercentile: number | null
  differentialPercentile: number | null
  valuePercentile: number | null
  gemScore: number | null
  isAvailable: boolean
  status: string | null
  news: string | null
  penaltiesOrder: number | null
}

export async function getHiddenGems(limit = 60): Promise<GemRow[]> {
  const rows = await query<Record<string, unknown>>(
    `select player_code, web_name, position, team_short, price, selected_by_percent,
            minutes, total_points, xgi_per_90, defcon_per_90, xgc_per_90,
            points_per_million, output_percentile, differential_percentile,
            value_percentile, gem_score, is_available, status, news, penalties_order
     from hidden_gems limit $1`,
    [limit],
  )
  return rows.map((r) => ({
    playerCode: Number(r.player_code),
    webName: String(r.web_name ?? ''),
    position: String(r.position ?? ''),
    teamShort: (r.team_short as string) ?? null,
    price: num(r.price),
    selectedByPercent: num(r.selected_by_percent),
    minutes: num(r.minutes),
    totalPoints: num(r.total_points),
    xgiPer90: num(r.xgi_per_90),
    defconPer90: num(r.defcon_per_90),
    xgcPer90: num(r.xgc_per_90),
    pointsPerMillion: num(r.points_per_million),
    outputPercentile: num(r.output_percentile),
    differentialPercentile: num(r.differential_percentile),
    valuePercentile: num(r.value_percentile),
    gemScore: num(r.gem_score),
    isAvailable: Boolean(r.is_available),
    status: (r.status as string) ?? null,
    news: (r.news as string) ?? null,
    penaltiesOrder: num(r.penalties_order),
  }))
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
    left join lateral (
      select e.elo from club_elo e where e.team_code = t.code
      order by e.valid_from desc limit 1
    ) elo on true
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

export type SyncHealth = {
  job: string
  lastOk: string | null
  ageSeconds: number | null
}

export async function getSyncHealth(): Promise<SyncHealth[]> {
  const rows = await query<Record<string, unknown>>(`
    select job, last_ok, extract(epoch from age)::int as age_seconds
    from sync_freshness order by job
  `)
  return rows.map((r) => ({
    job: String(r.job),
    lastOk: r.last_ok ? new Date(r.last_ok as string).toISOString() : null,
    ageSeconds: num(r.age_seconds),
  }))
}
