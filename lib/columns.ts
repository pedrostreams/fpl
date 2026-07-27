/**
 * The column catalogue.
 *
 * Every metric the app can put on screen is registered here exactly once, and this is what
 * makes user-composed views possible: the column picker is built from this list, the heatmap
 * reads `direction` from it, and adding a metric later is one entry plus one line of SQL
 * rather than a new page.
 *
 * `direction` is the load-bearing field. DESIGN.md's first rule is that colour always means
 * better and never bigger, and a custom view will happily put expected goals conceded next to
 * expected goals — without a per-column direction, one of them would be shaded backwards and
 * the screen would confidently recommend the worst defence in the league. `'none'` means the
 * column is shown as a plain number with no shading, which is the honest answer whenever
 * "better" is not well defined.
 *
 * Keys must match `player_wide` in migration 0015. `assertCatalogue()` in lib/queries.ts
 * checks that at startup rather than letting a typo silently drop a column.
 */

export type ColumnFormat =
  | 'int'
  | 'num1'
  | 'num2'
  | 'num3'
  | 'price'
  | 'pct'
  | 'pct0'
  | 'signed1'
  | 'signed2'
  | 'text'
  | 'rankOf20'

/** Which way is good. Drives shading; `'none'` means do not shade. */
export type ColumnDirection = 'higher' | 'lower' | 'none'

export type ColumnGroup =
  | 'Identity'
  | 'Availability'
  | 'Price & ownership'
  | 'Returns'
  | 'Rates'
  | 'Chance quality'
  | 'Creation'
  | 'Set pieces'
  | 'Fixture'
  | 'Team'
  | 'Sample'

export type Position = 'GKP' | 'DEF' | 'MID' | 'FWD'

export type Column = {
  /** Must be a column of `player_wide`. */
  key: string
  /** Table header. Kept short; the picker and tooltip use `full`. */
  label: string
  full: string
  group: ColumnGroup
  format: ColumnFormat
  direction: ColumnDirection
  /**
   * Rank within position by default — a centre-back's xGI against other centre-backs, never
   * against forwards. `'all'` is for columns where the whole pool is the right comparison,
   * such as price or a team-level figure.
   */
  scope?: 'position' | 'all'
  /** Positions the metric is meaningful for. Used to warn in the picker, never to hide. */
  only?: Position[]
  /** Sticky columns that every view carries whether or not the user picked them. */
  pinned?: boolean
  why?: string
}

export const COLUMNS: Column[] = [
  // --- Identity -----------------------------------------------------------------------
  { key: 'web_name', label: 'Player', full: 'Player', group: 'Identity', format: 'text', direction: 'none', pinned: true },
  { key: 'position', label: 'Pos', full: 'Position', group: 'Identity', format: 'text', direction: 'none', pinned: true },
  { key: 'team_short', label: 'Team', full: 'Club', group: 'Identity', format: 'text', direction: 'none', pinned: true },
  { key: 'age', label: 'Age', full: 'Age in years', group: 'Identity', format: 'int', direction: 'none' },

  // --- Availability -------------------------------------------------------------------
  { key: 'minutes', label: 'Mins', full: 'Minutes played', group: 'Availability', format: 'int', direction: 'higher' },
  { key: 'starts', label: 'Starts', full: 'Matches started', group: 'Availability', format: 'int', direction: 'higher' },
  {
    key: 'minutes_share', label: 'Min %', full: "Share of the club's available minutes",
    group: 'Availability', format: 'pct0', direction: 'higher',
    why: 'A per-90 rate cannot see how often the 90 happened. Without this, a backup keeper on 540 minutes outranks an ever-present.',
  },
  { key: 'start_rate', label: 'Start %', full: 'Starts per appearance — starter or substitute', group: 'Availability', format: 'pct0', direction: 'higher' },
  { key: 'chance_of_playing', label: 'Fit %', full: 'FPL’s published chance of playing the next round', group: 'Availability', format: 'int', direction: 'higher' },
  {
    key: 'pct_minutes_outside_league', label: 'Euro %', full: 'Share of minutes played outside the league — rotation risk',
    group: 'Availability', format: 'pct', direction: 'lower',
  },
  { key: 'other_minutes', label: 'Other', full: 'Minutes in cup and European competition', group: 'Availability', format: 'int', direction: 'lower' },

  // --- Price & ownership --------------------------------------------------------------
  {
    key: 'price', label: 'Price', full: 'Current price', group: 'Price & ownership', format: 'price',
    direction: 'none', scope: 'all',
    why: 'Cheap is not better. A £4.5 defender is not a better footballer than Haaland, so shading price would say something false.',
  },
  {
    key: 'selected_by_percent', label: 'Owned', full: 'Percentage of managers who own him',
    group: 'Price & ownership', format: 'pct', direction: 'lower', scope: 'all',
    why: 'Inverted deliberately: on a screen for finding differentials, low ownership is the good end.',
  },
  { key: 'points_per_million', label: 'Pts/£m', full: 'Total points per million of price', group: 'Price & ownership', format: 'num1', direction: 'higher' },
  { key: 'xgi_per_million', label: 'xGI/£m', full: 'Expected goal involvement per million of price', group: 'Price & ownership', format: 'num2', direction: 'higher' },
  { key: 'cost_change_start', label: 'Δ£ start', full: 'Price change since the season started', group: 'Price & ownership', format: 'signed1', direction: 'higher', scope: 'all' },
  { key: 'cost_change_event', label: 'Δ£ GW', full: 'Price change this gameweek', group: 'Price & ownership', format: 'signed1', direction: 'higher', scope: 'all' },
  { key: 'price_change_percent', label: 'Δ%', full: 'FPL’s own progress indicator toward the next price change', group: 'Price & ownership', format: 'num1', direction: 'none', scope: 'all' },
  { key: 'net_transfers_event', label: 'Net GW', full: 'Net transfers in this gameweek', group: 'Price & ownership', format: 'int', direction: 'higher', scope: 'all' },
  { key: 'transfers_in_event', label: 'In GW', full: 'Transfers in this gameweek', group: 'Price & ownership', format: 'int', direction: 'higher', scope: 'all' },
  { key: 'transfers_out_event', label: 'Out GW', full: 'Transfers out this gameweek', group: 'Price & ownership', format: 'int', direction: 'lower', scope: 'all' },

  // --- Returns ------------------------------------------------------------------------
  { key: 'total_points', label: 'Pts', full: 'Total FPL points', group: 'Returns', format: 'int', direction: 'higher' },
  { key: 'goals_scored', label: 'G', full: 'Goals scored', group: 'Returns', format: 'int', direction: 'higher' },
  { key: 'assists', label: 'A', full: 'Assists', group: 'Returns', format: 'int', direction: 'higher' },
  { key: 'clean_sheets', label: 'CS', full: 'Clean sheets', group: 'Returns', format: 'int', direction: 'higher', only: ['GKP', 'DEF', 'MID'] },
  { key: 'goals_conceded', label: 'GC', full: 'Goals conceded while on the pitch', group: 'Returns', format: 'int', direction: 'lower', only: ['GKP', 'DEF'] },
  { key: 'saves', label: 'Saves', full: 'Saves made', group: 'Returns', format: 'int', direction: 'higher', only: ['GKP'] },
  { key: 'bonus', label: 'Bonus', full: 'Bonus points awarded', group: 'Returns', format: 'int', direction: 'higher' },
  { key: 'bps', label: 'BPS', full: 'Bonus points system score — the input bonus is awarded from', group: 'Returns', format: 'int', direction: 'higher' },
  { key: 'defensive_contribution', label: 'DC', full: 'Defensive contribution actions', group: 'Returns', format: 'int', direction: 'higher' },
  { key: 'expected_goals', label: 'xG', full: 'Expected goals, season total', group: 'Returns', format: 'num2', direction: 'higher' },
  { key: 'expected_assists', label: 'xA', full: 'Expected assists, season total', group: 'Returns', format: 'num2', direction: 'higher' },
  { key: 'expected_goal_involvements', label: 'xGI', full: 'Expected goal involvements, season total', group: 'Returns', format: 'num2', direction: 'higher' },
  { key: 'expected_goals_conceded', label: 'xGC', full: 'Expected goals conceded, season total', group: 'Returns', format: 'num2', direction: 'lower', only: ['GKP', 'DEF'] },

  // --- Rates --------------------------------------------------------------------------
  { key: 'points_per_90', label: 'Pts/90', full: 'FPL points per 90 minutes', group: 'Rates', format: 'num2', direction: 'higher' },
  { key: 'xg_per_90', label: 'xG/90', full: 'Expected goals per 90 minutes', group: 'Rates', format: 'num3', direction: 'higher' },
  { key: 'xa_per_90', label: 'xA/90', full: 'Expected assists per 90 minutes', group: 'Rates', format: 'num3', direction: 'higher' },
  { key: 'xgi_per_90', label: 'xGI/90', full: 'Expected goal involvement per 90 minutes', group: 'Rates', format: 'num3', direction: 'higher' },
  { key: 'xgc_per_90', label: 'xGC/90', full: 'Expected goals conceded per 90 minutes', group: 'Rates', format: 'num2', direction: 'lower', only: ['GKP', 'DEF'] },
  { key: 'defcon_per_90', label: 'DC/90', full: 'Defensive contribution actions per 90 minutes', group: 'Rates', format: 'num1', direction: 'higher' },
  { key: 'bps_per_90', label: 'BPS/90', full: 'Bonus points system score per 90 minutes', group: 'Rates', format: 'num1', direction: 'higher' },

  // --- Chance quality -----------------------------------------------------------------
  { key: 'shots_per_90', label: 'Sh/90', full: 'Shots per 90 minutes', group: 'Chance quality', format: 'num2', direction: 'higher' },
  { key: 'shots_in_box_per_90', label: 'Box/90', full: 'Shots inside the penalty area per 90 minutes', group: 'Chance quality', format: 'num2', direction: 'higher' },
  { key: 'big_chances_per_90', label: 'Big/90', full: 'Shots worth at least 0.3 xG, per 90 minutes', group: 'Chance quality', format: 'num2', direction: 'higher' },
  {
    key: 'non_penalty_xg_per_90', label: 'npxG/90', full: 'Expected goals excluding penalties, per 90 minutes',
    group: 'Chance quality', format: 'num3', direction: 'higher',
    why: 'Only separable because the Penalty label had to be repaired first — soccerdata drops it for 19.6% of shots.',
  },
  {
    key: 'head_xg_per_90', label: 'Head xG/90', full: 'Expected goals from headers, per 90 minutes',
    group: 'Chance quality', format: 'num3', direction: 'higher',
    why: 'What survives of aerial ability. FBref’s duel data went with the Opta licence in January 2026; Understat still records body part on every shot.',
  },
  { key: 'head_xg', label: 'Head xG', full: 'Expected goals from headers, season total', group: 'Chance quality', format: 'num2', direction: 'higher' },
  { key: 'head_shots', label: 'Headers', full: 'Headed shots', group: 'Chance quality', format: 'int', direction: 'higher' },
  { key: 'head_goals', label: 'Head G', full: 'Goals scored with the head', group: 'Chance quality', format: 'int', direction: 'higher' },
  {
    key: 'goals_minus_xg', label: 'G−xG', full: 'Goals minus expected goals',
    group: 'Chance quality', format: 'signed1', direction: 'none',
    why: 'Not shaded. Overperformance is either a clinical finisher or a run of luck about to regress, and the colour would have to pick one.',
  },
  { key: 'assists_minus_xa', label: 'A−xA', full: 'Assists minus expected assists', group: 'Chance quality', format: 'signed1', direction: 'none' },

  // --- Creation -----------------------------------------------------------------------
  { key: 'understat_xa', label: 'uxA', full: 'Expected assists, Understat’s own model', group: 'Creation', format: 'num2', direction: 'higher' },
  { key: 'xg_chain_per_90', label: 'xGC ch/90', full: 'Expected goals of every possession the player was involved in, per 90', group: 'Creation', format: 'num2', direction: 'higher' },
  {
    key: 'xg_buildup_per_90', label: 'xGB/90', full: 'As xG chain, but excluding his own shots and key passes — pure buildup',
    group: 'Creation', format: 'num2', direction: 'higher',
    why: 'The metric for a deep playmaker who never gets the assist.',
  },
  { key: 'xg_chain', label: 'xG chain', full: 'Expected goals of every possession the player was involved in', group: 'Creation', format: 'num1', direction: 'higher' },
  { key: 'xg_buildup', label: 'xG build', full: 'Buildup expected goals, season total', group: 'Creation', format: 'num1', direction: 'higher' },

  // --- Set pieces ---------------------------------------------------------------------
  { key: 'penalties_order', label: 'Pen', full: 'Penalty taker order — 1 is first choice', group: 'Set pieces', format: 'int', direction: 'lower', scope: 'all' },
  { key: 'direct_freekicks_order', label: 'FK', full: 'Direct free-kick order — 1 is first choice', group: 'Set pieces', format: 'int', direction: 'lower', scope: 'all' },
  { key: 'corners_order', label: 'Cor', full: 'Corner taker order — 1 is first choice', group: 'Set pieces', format: 'int', direction: 'lower', scope: 'all' },

  // --- Fixture ------------------------------------------------------------------------
  { key: 'opponents', label: 'Next', full: 'Next gameweek’s opponent — uppercase home, lowercase away', group: 'Fixture', format: 'text', direction: 'none' },
  { key: 'fixture_difficulty', label: 'FDR', full: 'Fixture difficulty from the Elo model, 0 easiest', group: 'Fixture', format: 'num2', direction: 'lower', scope: 'all' },
  {
    key: 'fixture_rank', label: 'Fix', full: 'This fixture ranked against the other 19 clubs, using the half that matters for the position',
    group: 'Fixture', format: 'num2', direction: 'higher', scope: 'all',
    why: 'Clean sheets for keepers and defenders, goals for midfielders and forwards.',
  },
  { key: 'fixture_xg_for', label: 'xGF', full: 'Expected goals for the club this gameweek', group: 'Fixture', format: 'num2', direction: 'higher', scope: 'all' },
  { key: 'fixture_clean_sheets', label: 'xCS', full: 'Expected clean sheets for the club this gameweek', group: 'Fixture', format: 'num2', direction: 'higher', scope: 'all' },
  {
    key: 'opponent_rank', label: 'Opp rk', full: 'The opponent’s league rank in the dimension this position exploits — 1 is strongest',
    group: 'Fixture', format: 'rankOf20', direction: 'higher', scope: 'all',
    why: 'Null for promoted clubs, which have no top-flight record. Ranks 4 to 17 span only 0.29 xGA per match, so read the rate first.',
  },
  { key: 'fixture_count', label: '#', full: 'Fixtures this gameweek — 0 is a blank, 2 a double', group: 'Fixture', format: 'int', direction: 'higher', scope: 'all' },

  // --- Team ---------------------------------------------------------------------------
  { key: 'team_xg_per_match', label: 'Tm xG', full: 'The club’s expected goals per match', group: 'Team', format: 'num2', direction: 'higher', scope: 'all' },
  { key: 'team_xga_per_match', label: 'Tm xGA', full: 'The club’s expected goals conceded per match', group: 'Team', format: 'num2', direction: 'lower', scope: 'all' },
  { key: 'team_clean_sheet_pct', label: 'Tm CS%', full: 'Share of the club’s matches ending in a clean sheet', group: 'Team', format: 'pct', direction: 'higher', scope: 'all' },
  {
    key: 'team_corner_xg', label: 'Cor xG', full: 'Expected goals the club generates from corners',
    group: 'Team', format: 'num2', direction: 'higher', scope: 'all',
    why: 'The team context a defender is worth judging by: a centre-back at a side worth 17.5 xG from corners is a different proposition from one at a side worth 5.',
  },
  { key: 'team_corner_goals', label: 'Cor G', full: 'Goals the club has scored from corners', group: 'Team', format: 'int', direction: 'higher', scope: 'all' },
  { key: 'team_corner_shots', label: 'Cor sh', full: 'Shots the club generates from corners', group: 'Team', format: 'int', direction: 'higher', scope: 'all' },
  {
    key: 'team_ppda', label: 'PPDA', full: 'Opponent passes allowed per defensive action — low means a high press',
    group: 'Team', format: 'num1', direction: 'none', scope: 'all',
    why: 'Not shaded: pressing hard is a style, not a virtue, and colouring it would claim otherwise.',
  },
  { key: 'team_deep_completions', label: 'Deep', full: 'Passes completed within 20 metres of the opposition goal', group: 'Team', format: 'num1', direction: 'higher', scope: 'all' },
  { key: 'team_attacking_rank', label: 'Tm atk', full: 'The club’s attacking rank — 1 is best', group: 'Team', format: 'rankOf20', direction: 'lower', scope: 'all' },
  { key: 'team_defensive_rank', label: 'Tm def', full: 'The club’s defensive rank — 1 is best', group: 'Team', format: 'rankOf20', direction: 'lower', scope: 'all' },
]

export const COLUMNS_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]))

export const GROUP_ORDER: ColumnGroup[] = [
  'Identity', 'Availability', 'Price & ownership', 'Returns', 'Rates',
  'Chance quality', 'Creation', 'Set pieces', 'Fixture', 'Team', 'Sample',
]

/** Columns every view carries regardless of what the user picked. */
export const PINNED = COLUMNS.filter((c) => c.pinned).map((c) => c.key)

// ---------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------
// Kept separate from views on purpose, and it is Peder's distinction: a view selects columns,
// a filter selects rows. The same filter is useful across every view — "under £6.0 and fit"
// means the same thing whether you are looking at finishers or defenders.

export type Filters = {
  positions?: Position[]
  teams?: string[]
  priceMin?: number
  priceMax?: number
  ownedMax?: number
  ownedMin?: number
  minutesMin?: number
  minutesShareMin?: number
  availableOnly?: boolean
  reliableOnly?: boolean
  watchedOnly?: boolean
  penaltyTakersOnly?: boolean
  search?: string
}

export const EMPTY_FILTERS: Filters = {}

// ---------------------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------------------
// In code rather than in the database. A preset stored as a row can only be improved by a
// migration and drifts away from the catalogue; a preset here is checked by the type system
// against the columns that actually exist, and `assertCatalogue` fails the build if one
// references a column `player_wide` does not have.

export type Preset = {
  key: string
  name: string
  blurb: string
  columns: string[]
  filters?: Filters
  sort?: { key: string; desc: boolean }
}

export const PRESETS: Preset[] = [
  {
    key: 'overview',
    name: 'Overview',
    blurb: 'The all-round scouting table',
    columns: [
      'price', 'selected_by_percent', 'minutes', 'minutes_share', 'total_points',
      'points_per_90', 'xgi_per_90', 'xgc_per_90', 'defcon_per_90', 'bps_per_90',
      'points_per_million', 'opponents', 'fixture_rank',
    ],
    sort: { key: 'total_points', desc: true },
  },
  {
    key: 'finishers',
    name: 'Finishers',
    blurb: 'Shot volume and chance quality, penalties stripped out',
    columns: [
      'price', 'minutes_share', 'goals_scored', 'expected_goals', 'non_penalty_xg_per_90',
      'shots_per_90', 'shots_in_box_per_90', 'big_chances_per_90', 'head_xg_per_90',
      'goals_minus_xg', 'penalties_order', 'opponents', 'fixture_rank', 'opponent_rank',
    ],
    filters: { positions: ['MID', 'FWD'], reliableOnly: true },
    sort: { key: 'non_penalty_xg_per_90', desc: true },
  },
  {
    key: 'playmakers',
    name: 'Playmakers',
    blurb: 'Creation, including the buildup that never shows up as an assist',
    columns: [
      'price', 'minutes_share', 'assists', 'expected_assists', 'xa_per_90', 'understat_xa',
      'xg_chain_per_90', 'xg_buildup_per_90', 'assists_minus_xa',
      'corners_order', 'direct_freekicks_order', 'opponents', 'fixture_rank', 'opponent_rank',
    ],
    filters: { positions: ['MID', 'FWD', 'DEF'], reliableOnly: true },
    sort: { key: 'xa_per_90', desc: true },
  },
  {
    key: 'defenders',
    name: 'Defenders',
    blurb: 'Clean sheets and defensive contribution, plus the attacking threat from set pieces',
    columns: [
      'price', 'minutes_share', 'clean_sheets', 'xgc_per_90', 'defcon_per_90',
      'defensive_contribution', 'bps_per_90', 'head_xg_per_90', 'corners_order',
      'team_corner_xg', 'team_xga_per_match', 'opponents', 'fixture_rank', 'fixture_clean_sheets',
    ],
    filters: { positions: ['DEF'], reliableOnly: true },
    sort: { key: 'defcon_per_90', desc: true },
  },
  {
    key: 'goalkeepers',
    name: 'Goalkeepers',
    blurb: 'Saves, goals conceded and the clean-sheet fixture',
    columns: [
      'price', 'minutes_share', 'saves', 'clean_sheets', 'goals_conceded', 'xgc_per_90',
      'bps_per_90', 'points_per_million', 'team_clean_sheet_pct', 'team_xga_per_match',
      'opponents', 'fixture_rank', 'fixture_clean_sheets', 'opponent_rank',
    ],
    filters: { positions: ['GKP'], reliableOnly: true },
    sort: { key: 'xgc_per_90', desc: false },
  },
  {
    key: 'value',
    name: 'Value',
    blurb: 'Points and output per million',
    columns: [
      'price', 'selected_by_percent', 'total_points', 'points_per_million', 'xgi_per_million',
      'minutes_share', 'points_per_90', 'xgi_per_90', 'defcon_per_90',
      'cost_change_start', 'opponents', 'fixture_rank',
    ],
    sort: { key: 'points_per_million', desc: true },
  },
  {
    key: 'differentials',
    name: 'Differentials',
    blurb: 'Under 10% owned, fit, and a regular — what /gems used to be',
    columns: [
      'price', 'selected_by_percent', 'minutes_share', 'total_points', 'points_per_90',
      'xgi_per_90', 'defcon_per_90', 'xgc_per_90', 'points_per_million',
      'opponents', 'fixture_rank', 'opponent_rank',
    ],
    filters: { ownedMax: 10, availableOnly: true, reliableOnly: true, minutesShareMin: 0.25 },
    sort: { key: 'points_per_90', desc: true },
  },
  {
    key: 'fixtures',
    name: 'Fixtures',
    blurb: 'This gameweek, ranked by how kind the draw is for the position',
    columns: [
      'price', 'minutes_share', 'opponents', 'fixture_count', 'fixture_difficulty',
      'fixture_rank', 'fixture_xg_for', 'fixture_clean_sheets', 'opponent_rank',
      'team_xg_per_match', 'team_xga_per_match', 'xgi_per_90',
    ],
    sort: { key: 'fixture_rank', desc: true },
  },
]

export const PRESETS_BY_KEY = new Map(PRESETS.map((p) => [p.key, p]))
