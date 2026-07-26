# Data sources — research findings

**Research date: 2026-07-26.** Every "verified" claim below was tested against the live
endpoint on that date, not taken from documentation. Probe scripts that produced this
evidence live in [scripts/probe/](../scripts/probe/) — re-run them before trusting any
row, because the free-football-data landscape moved twice in the last 12 months.

**Context:** FPL 2026/27 **GW1 deadline is 2026-08-21 17:30 UTC** (verified from
`bootstrap-static.events`). That is the hard deadline for this project.

---

## 0. The headline findings

Four things drive every decision in this document:

1. **The official FPL API is far richer than it used to be and now carries Opta xG/xA
   natively.** 105 fields per player, including `expected_goals`, `expected_assists`,
   `expected_goals_conceded`, the DEFCON counters, set-piece taker orders, and an
   `opta_code`. For FPL purposes this removes most of the need for a paid provider —
   which is why the Sportmonks dependency from `Sporting_Director_Game` is **not**
   carried over here.

2. **FBref is dead for our purposes.** Sports Reference lost its Opta licence in
   January 2026 and deleted the advanced data. This is a *second* loss after the
   StatsBomb feed termination noted in `Sporting_Director_Game/docs/DATA_SOURCES.md`.
   Only basic stats and the historical archive remain. Do not build on FBref.

3. **The FPL API has no history.** It exposes only *current* state — there is no
   endpoint for "what did this player cost last Tuesday" or "what was ownership at the
   GW3 deadline". Price-change prediction, ownership momentum, and form trends are all
   time-series problems over data that **only exists if we capture it ourselves**.
   Snapshotting must start before the season does. This is the single most
   time-critical item in the whole project.

4. **FPL now ships an official price predictor** (`price_change_percent`, new for
   2026/27). It is currently `0` for all 558 players because the season hasn't started.
   Treat it as a free *input signal* to our own model, not as a competitor — we will
   have the raw net-transfer curve it is derived from, which it does not expose.

---

## 1. Verification summary

| Source | Cost | Key needed | Verified 2026-07-26 | Verdict |
|---|---|---|---|---|
| **Official FPL API** | Free | No | ✅ 558 players × 105 fields, 380 fixtures, 38 events | **Tier 1 — core** |
| **Understat** (via `soccerdata`) | Free | No | ✅ 528 players, 346 team-matches, 8 616 shots | **Tier 2 — enrichment** |
| **Sofascore** (via `ScraperFC` + `curl_cffi`) | Free | No | ✅ 537 players × 114 stats | **Tier 2 — enrichment** |
| **ClubElo** | Free | No | ✅ 6 508 rows for Arsenal; Elo 2063.76, rank 1 | **Tier 2 — team strength** |
| **football-data.co.uk** | Free | No | ✅ 25/26: 380 rows × 132 cols (odds). 26/27: 404 (not started) | **Tier 2 — odds** |
| **olbauday/FPL-Core-Insights** | Free | No | ✅ auto-commit 2026-07-26 08:18 UTC; `data/2026-2027/` populated | **Tier 3 — cross-check** |
| **FBref** (via `soccerdata`) | Free | No | ⚠️ basic stats only — advanced deleted Jan 2026 | **Rejected** |
| **Sportmonks** | Paid for PL | Yes | not tested | **Rejected — FPL API supersedes** |
| **football-data.org** | Free tier | Yes | not tested | **Rejected — no odds, 10 req/min** |
| **Transfermarkt** | Free (scrape) | No | not tested | **Out of scope — market value ≠ FPL price** |

Local tooling is already in place: Python 3.14.4, Node 24.15.0, `soccerdata` 1.9.0,
`ScraperFC` 4.5.0, `curl_cffi` 0.15.0, `pandas` 3.0.2.

---

## 2. Tier 1 — Official FPL API

Base: `https://fantasy.premierleague.com/api/`. No key, no auth for public endpoints.
Send a normal browser `User-Agent`. This is the spine of the product.

### Endpoints

| Endpoint | Contents | Sync cadence |
|---|---|---|
| `bootstrap-static/` | `elements` (558 players × 105 fields), `teams` (20), `events` (38), `element_types`, `element_stats`, `chips`, `game_config`, `phases` | Hourly; every 15 min in the price window |
| `fixtures/` | 380 fixtures: `event`, `kickoff_time`, `team_h/a`, scores, `team_h_difficulty`/`team_a_difficulty` (FDR 1–5), `stats` (per-player goals/assists/bonus/bps after FT), `pulse_id` | Hourly |
| `element-summary/{id}/` | `history` (per-GW rows, this season), `history_past` (per-season aggregates incl. `start_cost`/`end_cost`), `fixtures` (next 38 with `difficulty`, `is_home`) | Per player, after each GW |
| `event/{n}/live/` | Per-player `stats` + `explain` (point-by-point breakdown incl. BPS) | Every 2 min during matches |
| `leagues-classic/{id}/standings/` | Mini-league table | After each GW |
| `entry/{id}/event/{n}/picks/` | A manager's actual XI, captain, chip | After each deadline |

### Player fields worth knowing about (all 105 verified present)

- **Pricing/ownership:** `now_cost`, `cost_change_event`, `cost_change_event_fall`,
  `cost_change_start`, `cost_change_start_fall`, `price_change_percent` *(new)*,
  `selected_by_percent`, `transfers_in_event`, `transfers_out_event`, `transfers_in`,
  `transfers_out`.
- **Opta-derived performance:** `expected_goals`, `expected_assists`,
  `expected_goal_involvements`, `expected_goals_conceded`, plus `_per_90` variants of
  each, `starts_per_90`, `clean_sheets_per_90`.
- **DEFCON (defensive contribution):** `clearances_blocks_interceptions`, `recoveries`,
  `tackles`, `defensive_contribution`, `defensive_contribution_per_90`.
- **Availability:** `status` (`a`/`d`/`i`/`s`/`u`), `news`, `news_added`,
  `chance_of_playing_this_round`, `chance_of_playing_next_round`, `can_select`,
  `can_transact`, `removed`, and new-for-26/27 `scout_risks` + `scout_news_link`.
- **Set pieces:** `penalties_order` (64 players set), `direct_freekicks_order` (60),
  `corners_and_indirect_freekicks_order` (71) — plus `_text` variants. **A free,
  first-party set-piece taker map.** No scraping needed.
- **Identity/joins:** `id` (season-scoped), `code` (**stable across seasons** — use
  this as the natural key), `opta_code` (e.g. `p223094`), `team_code`, `birth_date`,
  `region`, `team_join_date`.
- **FPL's own indices:** `form`, `points_per_game`, `value_form`, `value_season`,
  `ict_index` + `influence`/`creativity`/`threat`, and `*_rank` / `*_rank_type` for
  most of them.

### Gotchas — confirmed by probing, these will bite

1. **Preseason bootstrap carries LAST season's totals.** Haaland currently shows
   `minutes: 2953`, `total_points: 239`, `expected_goals: 25.50` — those are 2025/26
   numbers sitting in the 2026/27 payload. Every aggregate stat must be tagged with the
   season it belongs to at ingest, or the first weeks of 2026/27 will be corrupted by
   carry-over. `history` is empty (`count=0`) and `form` is `0.0`, which are the
   reliable "season hasn't started" tells.
2. **Team strength fields are unpopulated in preseason.** `strength_attack_home`,
   `strength_defence_away` etc. are all `0`, `form` is `""`, `played`/`points` are `0`.
   Do not derive fixture difficulty from these until the season is underway — use
   ClubElo and bookmaker odds instead.
3. **`event/{n}/live/` returns `elements: []` before the GW.** Not an error.
4. **`price_change_percent` is `0` for all 558 players right now.** It populates
   in-season.
5. **`scout_risks` is empty for all players right now** (`0` non-empty). Populates
   in-season; shape unknown until then — ingest it as JSONB.
6. **Season-scoped `id` is not stable across seasons; `code` is.** Anything historical
   must key on `code` / `element_code`.
7. **Prices change once nightly**, roughly 01:30–02:30 UK time. Sampling must bracket
   that window to catch both the pre-change net-transfer state and the outcome.

Current availability snapshot (2026-07-26): `a`=512, `i`=24, `d`=18, `s`=3, `u`=1;
46 players carry a `news` string. So injury/suspension data is already usable
first-party — `premierinjuries.com` scraping is **not** required.

---

## 3. Tier 2 — Enrichment

### 3.1 Understat — the team-style and shot-location engine

Via `soccerdata` 1.9.0. Methods verified present: `read_leagues`, `read_seasons`,
`read_schedule`, `read_team_match_stats`, `read_player_season_stats`,
`read_player_match_stats`, `read_shot_events`. (Note: there is **no**
`read_team_season_stats` in 1.9.0 — aggregate `read_team_match_stats` yourself.)

| Method | Verified shape (PL 2025/26) | Why it matters |
|---|---|---|
| `read_team_match_stats()` | 346 rows × 29 cols | **`home_ppda` / `away_ppda`** and **`home_deep_completions` / `away_deep_completions`**, plus per-match `xg`, `np_xg`, `np_xg_difference`, `expected_points`. This is the direct answer to "which teams play defensive football" — PPDA is passes-allowed-per-defensive-action, so **low PPDA = aggressive high press**, high PPDA = sit deep. Nothing in the FPL API comes close. |
| `read_shot_events()` | 8 616 rows × 21 cols | Per-shot `xg`, `location_x`, `location_y`, `minute`, `body_part`, `situation` (Open Play / set piece / penalty), `result`, `assist_player`. Enables shot maps, box-entry quality, penalty-independent xG, and header-vs-foot threat splits. |
| `read_player_season_stats()` | 528 rows × 23 cols | `xa`, `xg_chain`, `xg_buildup`, `np_goals`, `np_xg`, `key_passes` — creator metrics the FPL API doesn't expose. |
| `read_schedule()` | 380 rows × 20 cols | Match-level xG plus `understat.com/match/{id}` URLs and `has_data` flags. |

Caveat: `read_team_match_stats` returned **346 of 380** matches. Cause not yet
established (Understat gaps vs. `soccerdata` cache). Verify coverage per season before
relying on completeness; reconcile against `read_schedule().has_data`.

Understat is described across 2026 sources as one of the last free xG sources standing.
Treat it as valuable but single-point-of-failure: cache raw responses on disk so a
future outage doesn't erase history we already fetched.

### 3.2 Sofascore — the deep per-player stat pack

Via `ScraperFC` 4.5.0. **Verified 537 players × 114 stats, PL 25/26.**

The `curl_cffi` monkey-patch from `Sporting_Director_Game/scripts/fetch-sofascore.py`
**still works** — the patch point is `ScraperFC.sofascore.botasaurus_browser_get_json`,
confirmed present in 4.5.0. Sofascore gates on TLS fingerprint: plain `requests` and
`cloudscraper` get 403, `curl_cffi` with `impersonate="chrome120"` gets 200. This avoids
the botasaurus/Chrome dependency entirely.

Stats not available anywhere else in our free stack: `rating`, `totwAppearances`,
`goalsPrevented`, `bigChancesCreated`, `bigChancesMissed`, `possessionWonAttThird`,
`ballRecovery`, `errorLeadToGoal`/`errorLeadToShot`, `dribbledPast`,
`groundDuelsWonPercentage`, `aerialDuelsWonPercentage`, `touches`, `possessionLost`,
`accurateFinalThirdPasses`, `passToAssist`, `shotsFromInsideTheBox`,
`goalsConcededInsideTheBox`, `savedShotsFromInsideTheBox`, `penaltyConversion`,
`setPieceConversion`, `scoringFrequency`, plus a full keeper pack (`savesCaught`,
`savesParried`, `highClaims`, `punches`, `runsOut`, `crossesNotClaimed`).

It also carries its own `expectedGoals`/`expectedAssists` — useful as a **cross-check**
against the FPL/Opta figures, since disagreement between two xG models is itself a
signal about model noise.

### 3.3 ClubElo — team strength time series

`http://api.clubelo.com/<ClubName>` returns CSV, no key, no rate limit published.
**Verified: 6 508 historical rows for Arsenal**, current Elo `2063.76`, rank 1, with
rows dated forward to `2026-12-31`. Columns: `Rank,Club,Country,Level,Elo,From,To`.

This is the cleanest available substitute for FPL's unpopulated `strength_*` fields, and
unlike FDR it is continuous, opponent-adjusted, and has real history for backtesting.

### 3.4 football-data.co.uk — bookmaker odds

`https://www.football-data.co.uk/mmz4281/{season}/E0.csv`, e.g. `2627` for 2026/27.
**Verified: 25/26 returned 380 rows × 132 columns** including `B365H/D/A`,
`AvgH/D/A`, `MaxH/D/A`, over/under 2.5 lines, Asian handicaps, and closing prices.
**26/27 currently 404s** — the file appears once matches are played.

Why this matters more than it looks: de-vigged 1X2 and O/U 2.5 odds convert into
implied win and clean-sheet probabilities that are strictly better fixture-difficulty
inputs than FPL's integer 1–5 FDR. Free, no key, weekly refresh. Paid odds APIs are
unnecessary — and their free tiers (100 req/hour) would be a downgrade in coverage.

---

## 4. Tier 3 — Cross-check and backfill

### olbauday/FPL-Core-Insights
GitHub CSV dataset, **auto-updated twice daily — verified commit `2026-07-26 08:18 UTC`**,
and `data/2026-2027/` already contains `players.csv`, `teams.csv`, `playerstats.csv`,
`team_history.csv`, `gameweek_summaries.csv`, plus `By Gameweek/` and `By Tournament/`
directories. Fuses FPL API + match stats + ClubElo, **keyed on official FPL player IDs**,
and covers cups and European competitions (relevant for rotation risk).

Use it two ways: as an independent **cross-check** on our own ingest, and as **backfill**
for per-match player stats we'd otherwise scrape. Do **not** make it a hard dependency —
it's one volunteer's repo with no stated licence and no SLA. Mirror what we use.

Related: `vaastav/Fantasy-Premier-League` remains the standard multi-season historical
archive for backtesting a price model against past seasons.

---

## 5. Rejected sources, with reasons

| Source | Why not |
|---|---|
| **FBref / Stathead** | Lost Opta licence January 2026; advanced data deleted on demand. Basic + historical archive only. A second loss after the StatsBomb termination. Actively misleading to build on. |
| **Sportmonks** | Paid for Premier League. The FPL API already supplies Opta xG/xA/xGC. `Sporting_Director_Game/docs/INGEST_GAPS.md` also documents that its squads endpoint silently omits many mapped stat types — a known cost we don't need to pay again. |
| **football-data.org** | Free tier excludes odds, lineups, and squads; 10 req/min. Strictly worse than football-data.co.uk + FPL API. |
| **Paid odds APIs** | Free tiers cap at ~100 req/hour and add a key to rotate. football-data.co.uk covers historical + closing odds for free. |
| **Transfermarkt** | Market value has no bearing on FPL price. Was authoritative for `Sporting_Director_Game`; irrelevant here. |
| **FiveThirtyEight SPI** | Discontinued. `soccerdata` still lists the scraper; the upstream data is gone. |
| **premierinjuries.com** | Redundant — FPL's own `status` / `news` / `chance_of_playing_*` already cover 46 flagged players today. |

---

## 6. Source → feature map

Which source answers each thing you asked for:

| Question you want answered | Primary source | Supporting |
|---|---|---|
| Which players are performing *right now* | FPL API (`form`, xGI per 90, DEFCON per 90) | Sofascore `rating`, Understat `xg_chain` |
| Which players are hidden gems | FPL API (`selected_by_percent` × xGI/90 × `now_cost`) | Understat `xa`/`xg_buildup`, Sofascore `bigChancesCreated` |
| **Who rises/falls in price in the next 24h** | **Our own `player_snapshots` time series** (net-transfer velocity) | FPL `price_change_percent`, `transfers_in/out_event` |
| Which teams are performing | Understat team xG/xGA rolling | ClubElo, odds-implied strength |
| **Which teams play defensive football** | **Understat `ppda` + `deep_completions`** | xGA per match, O/U 2.5 odds |
| Fixture difficulty (better than FDR) | football-data.co.uk de-vigged odds | ClubElo, FPL `difficulty` as fallback |
| Who reliably hits the DEFCON threshold | FPL `defensive_contribution_per_90` + components | Sofascore `tackles`/`interceptions`/`clearances` |
| Set-piece and penalty threat | FPL `penalties_order` / `*_freekicks_order` / corners | Understat `situation` on shot events |
| Rotation and European-fixture risk | FPL `starts_per_90`, `status`, `news` | FPL-Core-Insights cup/Euro coverage |
| **Differentials that beat *your* mini-league** | `leagues-classic/{id}/standings/` + `entry/{id}/event/{n}/picks/` | Our snapshots for league-specific EO |

That last row is the feature Fantasy Football Fix structurally cannot give you: it
computes effective ownership against the global top-10k, not against the 10–20 specific
squads you're actually trying to beat. Worth prioritising.

---

## 7. Update protocol

Carried over from `Sporting_Director_Game` because it worked: **any change to a data
source, stat, or derived metric updates this document in the same commit.** Specifically:

1. Add or amend the row in the relevant table above, including what was verified and when.
2. If a source's authority changes (one overriding another), say so explicitly.
3. If a probe script changes, note the new verified shape — shapes drift silently.
4. Re-run `scripts/probe/` before any claim in section 1 is relied on for new work.

The free football data landscape lost StatsBomb-on-FBref and then Opta-on-FBref inside
about a year. Assume any Tier 2 source can disappear, and keep raw cached payloads so a
disappearance costs us future data but not past data.
