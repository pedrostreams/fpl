# Data sources — research findings

**Research date: 2026-07-26.** Every "verified" claim below was tested against the live
endpoint on that date, not taken from documentation. Probe scripts that produced this
evidence live in [scripts/probe/](../scripts/probe/) — re-run them before trusting any
row, because the free-football-data landscape moved twice in the last 12 months.

**Context:** FPL 2026/27 **GW1 deadline is 2026-08-21 17:30 UTC** (verified from
`bootstrap-static.events`). That is the hard deadline for this project.

---

## 0. The headline findings

Five things drive every decision in this document:

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

   Capturing started 2026-07-26 17:53 UTC, hourly, and `sync-snapshot` was confirmed firing
   from `schedule` the same evening. `player_movement` and `snapshot_coverage` (migration 0009)
   are the read side. Two traps that insert-on-change sets for anything reading it are
   documented in `CLAUDE.md`: a missing row means *unchanged*, not *missing*, and an empty
   capture leaves no trace at all — so freshness must come from `sync_runs`, never from
   `max(captured_at)`.

4. **FPL now ships an official price predictor** (`price_change_percent`, new for
   2026/27). It is currently `0` for all 558 players because the season hasn't started.
   Treat it as a free *input signal* to our own model, not as a competitor — we will
   have the raw net-transfer curve it is derived from, which it does not expose.

5. **No free source gives odds for a fixture more than about a week out.**
   football-data.co.uk publishes only matches already played. So forward-looking fixture
   difficulty comes from ClubElo, with its constants **fitted against** last season's
   de-vigged market rather than chosen by hand (§3.3, §3.4, migration 0007). The pattern
   generalises: where a market exists in arrears, use it to calibrate a model that can run
   ahead of it, and record the fit quality so the model stays falsifiable.

---

## 1. Verification summary

| Source | Cost | Key needed | Verified 2026-07-26 | Verdict |
|---|---|---|---|---|
| **Official FPL API** | Free | No | ✅ 558 players × 105 fields, 380 fixtures, 38 events | **Tier 1 — core** |
| **Understat** (via `soccerdata`) | Free | No | ✅ 537 players, **380/380** team-matches, 9 524 shots | **Tier 2 — enrichment** |
| **Sofascore** (direct API + `curl_cffi`) | Free | No | ✅ 537 players × 116 stats. ⚠️ may 403 from datacenter IPs | **Tier 2 — enrichment** |
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
| `leagues-classic/{id}/standings/` | Mini-league: `league` meta, `standings`, **`new_entries`** | Daily; after each GW |
| `entry/{id}/` | Team name, manager, favourite club, `current_event`, bank, squad value | Daily |
| `entry/{id}/history/` | `past` seasons, `current` per-GW record, `chips` played | Daily |
| `entry/{id}/transfers/` | Every transfer ever made, newest first | Daily |
| `entry/{id}/event/{n}/picks/` | A manager's actual XI, captain, chip | After each deadline |

#### 2.2 The manager and league endpoints — probed 2026-07-30

Added for W1/W4 of [`feat/weekly-decisions.md`](feat/weekly-decisions.md). **No authentication is
involved in any of them.** Probed against entry 1617827 and league 422500:

| Endpoint | Preseason state | Note |
|---|---|---|
| `entry/{id}/` | 200 | `last_deadline_bank`/`value` are null — no deadline has passed |
| `entry/{id}/history/` | 200, `current: []`, `chips: []` | `past` has 10 seasons |
| `entry/{id}/transfers/` | **200 with `[]`** | Not a 404, so it needs no gate |
| `entry/{id}/event/1/picks/` | **404** | The squad does not exist until 2026-08-21 17:30 UTC |
| `leagues-classic/422500/standings/` | 200 | See the trap below |

**The trap, and it would ship as "the league is empty".** Before the season starts, members are
published under **`new_entries`**, not under `standings` — measured on league 422500 ("Hakuna
Mateta", `league_type = 'x'`, created 2026-07-30 by Peder): `standings.results` was `[]` while
`new_entries.results` held every member. A sync reading only `standings` finds nobody and the
page built on it reports an empty league that is not empty. `sync/jobs/league.py` reads both and
unions on `entry`, with `standings` winning once it fills.

**Both lists paginate independently.** `standings.has_next` is driven by `page_standings` and
`new_entries.has_next` by `page_new_entries`, in the same payload. Walking only the first will
miss members as the friend group grows — it went from 2 to 3 within an hour of first being read.

`entry/{id}/transfers/` is worth naming separately: it is what makes the recommendation log
(migration 0037) able to score *Peder's* decisions and not only the app's, without asking him to
record anything by hand.

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

### 2.1 Findings from the first real sync (2026-07-26)

Three constraints that only became visible once the data was actually in Postgres. All
three shape what the product can and cannot claim.

**`history_past` is authoritative for completed seasons; `bootstrap` is not.** For
2025/26 the two sources disagree for exactly 5 of 454 players, and `history_past` is
higher every time:

| Player | bootstrap minutes | history_past minutes | bootstrap xG | history_past xG |
|---|---|---|---|---|
| Anthony | 0 | 2717 | 0.00 | 5.11 |
| Tchaouna | 0 | 1259 | 0.00 | 1.27 |
| Disasi | 0 | 1254 | 0.00 | 1.10 |
| Wilson | 0 | 1234 | 0.00 | 7.60 |
| Gomes | 2207 | 2829 | 1.15 | 1.29 |

These are loan and transfer cases: the `elements` payload reflects the player's record at
their *current* club, while `history_past` holds the full season. **Read completed seasons
from `source = 'history_past'` and reserve `source = 'bootstrap'` for the live season.**
Keeping `source` in the primary key of `player_season_totals` is what makes the
disagreement visible instead of one silently overwriting the other.

**Expected stats begin in 2022/23.** `history_past` reaches back to 2006/07 (21 seasons,
2 568 rows), but xG/xA/xGI/xGC are zero for every season through 2021/22 and only appear
from 2022/23 onward:

| Season | players with xG | players total |
|---|---|---|
| ≤ 2021/22 | **0** | 4–168 |
| 2022/23 | 178 | 233 |
| 2023/24 | 206 | 277 |
| 2024/25 | 274 | 347 |
| 2025/26 | 342 | 454 |

So any xG-based backtest has **four completed seasons**, not twenty. Pre-2022/23 history
is usable for points, minutes and price trajectories only. Worth knowing before designing
a price model that wants expected-stat features.

**104 of 558 players (19%) have no 2025/26 record at all**, all with zero minutes — new
signings, promoted-club players, and academy prospects. A scouting tool that ranks on
last-season xGI per 90 is blind to a fifth of the pool, which is exactly where hidden gems
hide. `player_scout.is_cold_start` flags them and gives them null percentiles rather than
ranking them last on no evidence; `hidden_gems` excludes them outright, and the UI must
surface them separately instead of pretending they scored badly.

**`defensive_contribution` uses a position-dependent formula.** Verified against 2025/26:
it counts clearances + blocks + interceptions + tackles for **defenders** (97 of 99 exact),
and additionally counts **recoveries** for midfielders (125 of 128) and forwards (25 of 25).
Goalkeepers earn none — `element_types.defcon_threshold` is null for them.

So **never recompute it from its components with one formula**: summing
CBI + tackles + recoveries for everyone overstates every defender by their entire recovery
count. The thresholds for 2 points are 10 qualifying actions for defenders and 12 for
midfielders and forwards, stored in `element_types.defcon_threshold`.

**Set-piece taker order was in the API all along and initially went uningested.** 64 penalty
takers, 60 direct free-kick takers and 71 corner takers are named first-party. Now stored on
`player_seasons`; it is one of the clearest free edges in the whole feed.

### 3.1 Understat — the team-style and shot-location engine

Via `soccerdata` 1.9.0. Methods verified present: `read_leagues`, `read_seasons`,
`read_schedule`, `read_team_match_stats`, `read_player_season_stats`,
`read_player_match_stats`, `read_shot_events`. (Note: there is **no**
`read_team_season_stats` in 1.9.0 — aggregate `read_team_match_stats` yourself.)

| Method | Verified shape (PL 2025/26) | Why it matters |
|---|---|---|
| `read_team_match_stats()` | **380 rows** × 29 cols | **`home_ppda` / `away_ppda`** and **`home_deep_completions` / `away_deep_completions`**, plus per-match `xg`, `np_xg`, `np_xg_difference`, `expected_points`. This is the direct answer to "which teams play defensive football" — PPDA is passes-allowed-per-defensive-action, so **low PPDA = aggressive high press**, high PPDA = sit deep. Nothing in the FPL API comes close. |
| `read_shot_events()` | **9 524 rows** × 21 cols | Per-shot `xg`, `location_x`, `location_y`, `minute`, `body_part`, `situation` (Open Play / set piece / penalty), `result`, `assist_player`. Enables shot maps, box-entry quality, penalty-independent xG, and header-vs-foot threat splits. |
| `read_player_season_stats()` | 537 rows × 23 cols | `xa`, `xg_chain`, `xg_buildup`, `np_goals`, `np_xg`, `key_passes` — creator metrics the FPL API doesn't expose. |
| `read_schedule()` | 380 rows × 20 cols | Match-level xG plus `understat.com/match/{id}` URLs and `has_data` flags. |

**Coverage is complete — beware `soccerdata`'s cache.** An earlier probe reported 346 of
380 team-matches and 528 players, and that was recorded here as a possible Understat gap.
It wasn't: a CI run with a cold cache returned the full **380** on the same day, and
clearing `~/soccerdata/data/Understat` locally reproduced 380 immediately. `soccerdata`
caches aggressively and will happily serve a partial mid-season snapshot forever. **Clear
the cache before concluding anything about coverage**, and don't trust a short row count.
The probe now prints a warning instead of silently accepting it.

**`soccerdata` also silently drops three shot enum values, and we repair them.** It converts
Understat's CamelCase to spaced words with an incomplete mapping. Proven 2026-07-26 by counting
its own raw cache against what landed in Postgres, for the same 380 matches:

| Field | Upstream | Stored before the fix |
|---|---|---|
| `situation` | OpenPlay 6951 · FromCorner 1674 · SetPiece 559 · DirectFreekick 248 · **Penalty 92** | …and **NULL 92** |
| `shotType` | RightFoot 4743 · LeftFoot 2957 · **Head 1778** · **OtherBodyPart 46** | …and **NULL 1824** |

Every count matches exactly, so it drops precisely `Penalty`, `Head` and `OtherBodyPart` —
**1 870 of 9 524 shots, 19.6%**, with a corrupted attribute. Not our bug: the ingest passes the
value straight through, and `_clean('Penalty')` returns `'Penalty'`.

It matters because unlabelled penalties contaminate **non-penalty xG**, the figure that actually
predicts future scoring — a striker on four penalties looks like a better open-play finisher
than he is. Penalty xG is 70.0 of 1 183.9 total, 5.9%. Unlabelled headers make set-piece threat
unanalysable, and a tall defender who scores from corners is exactly the cheap differential this
project exists to find.

`sync/sources/understat_raw.py` repairs both from the untouched JSON `soccerdata` already cached
during the same fetch, keyed by `shot_id`. Exact rather than inferred: the penalty label could
be guessed from the coordinate — all 92 sit at exactly (0.885, 0.500) with mean xG 0.761 — but
`Head` and `OtherBodyPart` cannot be separated once both are NaN. It only ever fills a gap and
never overwrites, so it becomes a no-op if `soccerdata` fixes its mapping. `verify` fails if any
`situation` or `body_part` goes NULL again.

**The repaired enum values are space-separated, and the table comment lies.**
`understat_shots.situation` holds `'Open Play'`, `'From Corner'`, `'Set Piece'`,
`'Direct Freekick'`, `'Penalty'`; `result` holds `'Own Goal'`. The comment on the column in
migration 0002 still shows the pre-repair CamelCase (`SetPiece`), which is how a set-piece query
came back all zeros while looking perfectly correct. Query the real values, or `group by situation`
first.

#### Derived from it: how reliable is a club's season figure?

`team_style_metric` and `team_style_reliability`
([0021_team_style.sql](../../supabase/migrations/0021_team_style.sql)) turn these per-match series
into season figures **with their own error bars**, because the answer to "is this a property of the
club or is it noise" turned out to differ per metric and to decide what the club page may show.

Reliability of a k-match club mean, from a variance decomposition over all 646 club-matches
(2026-07-29 — recomputed by the views, so treat these as a dated record, not constants):

| Metric | rel(38) | rel(6) |
|---|---|---|
| Deep completions created | 0.85 | 0.48 |
| Shots taken | 0.79 | 0.37 |
| PPDA | 0.78 | 0.36 |
| Expected goals for | 0.78 | 0.36 |
| Shots conceded | 0.75 | 0.32 |
| Deep completions conceded | 0.74 | 0.31 |
| Dead-ball share of npxG | 0.49 | — |
| **Expected goals conceded** | **0.49** | 0.13 |

Two consequences worth knowing before building on these numbers:

- **`rel(6)` is 0.13–0.48.** A six-match club mean is about a third signal. Any feature phrased as
  "their recent form" is mostly noise, which is what shrank the trend layer to the ±50% class.
- **Expected goals conceded barely separates clubs even over a full season.** `/teams` shades xGA
  and the Defenders and Goalkeepers views rank on xGC, and both are weaker than they look. It also
  vindicates building `fixture_difficulty` on Elo rather than on xGA.

`scripts/probe/prove_style_claims.py` re-derives all of it independently and needs `DATABASE_URL`.

Understat is described across 2026 sources as one of the last free xG sources standing.
Treat it as valuable but single-point-of-failure: cache raw responses on disk so a
future outage doesn't erase history we already fetched.

### 3.2 Sofascore — the deep per-player stat pack

Via our own client, [`sync/sources/sofascore.py`](../sync/sources/sofascore.py).
**Verified 537 players × 116 stats, PL 25/26**, and season ids available for both 25/26
(76986) and 26/27 (96668).

**Do not use `ScraperFC` here, and don't copy the SDG approach.**
`Sporting_Director_Game/scripts/fetch-sofascore.py` monkey-patches
`ScraperFC.sofascore.botasaurus_browser_get_json`, which works locally but **fails on
GitHub Actions**: `import ScraperFC` pulls in `botasaurus_requests`, which downloads a TLS
binary from GitHub releases at import time, and that download 403s on runners. The import
dies before Sofascore is contacted at all, so patching the getter can't help — the patch
depends on the import that failed. Observed in CI 2026-07-26.

The direct client drops `ScraperFC`, `botasaurus` and `hrequests` entirely. All we needed
from the library was the endpoint shape and the stat-name list, both reproduced in our
module. What actually matters is the TLS fingerprint: Sofascore returns 403 to plain
`requests` and `cloudscraper`, and 200 to `curl_cffi` with `impersonate="chrome120"`.

Endpoint (paginated, 100 per page):
```
GET api.sofascore.com/api/v1/unique-tournament/17/season/{season_id}/statistics
    ?limit=100&offset={n}&accumulation=total&fields={stats}&filters=position.in.G~D~M~F
```
`fields` is not cosmetic — Sofascore returns only the fields you ask for, so a name
missing from `STAT_NAMES` becomes a silently absent column.

**Confirmed: Sofascore does NOT serve GitHub Actions runners.** Tested in CI 2026-07-26
after the import failure was removed — the API returns 403 to runner IPs while serving a
home connection fine. Datacenter ranges are filtered. This is settled, not a transient
error, so **Sofascore cannot be part of the Actions-hosted sync.** The client raises
`SofascoreBlocked` and the probe reports `BLOCKED` rather than `FAIL` so CI stays green and
honest about it.

Consequence for the plan: Sofascore is demoted to **optional, locally-run enrichment**. Its
genuinely unique contributions for FPL are narrow — `rating`, `goalsPrevented`,
`bigChancesCreated`/`bigChancesMissed`, `possessionWonAttThird`, and the keeper pack —
because the FPL API already supplies xG/xA/xGC and the DEFCON components, and Understat
supplies xA/xGChain/xGBuildup/PPDA/shots. **FPL-Core-Insights (§4) covers most of the gap
at better granularity** (per-match rather than per-season) and is reachable from Actions,
being GitHub-hosted. Prefer it; run Sofascore from a residential connection only if a
specific metric proves necessary.

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

**Promoted to the primary fixture-difficulty input (2026-07-26).** It is the only source
here that is *forward-looking* — see §3.4 for why the odds cannot be — and it covers all 20
clubs including the promoted three, because Elo carries over from the Championship. That
makes it the one metric on the teams page with no promoted-club blind spot.
`elo_now` (migration 0008) exposes each club's current rating: `distinct on (team_code)`
ordered by `valid_from desc`, **bounded to `valid_from <= current_date`**. ClubElo splits the
current rating across forward-dated rows — Arsenal on 2026-07-26 had rows starting 2026-05-31,
08-22 and 08-31, all at 2063.8 — and without the bound the view reads the furthest-future one.
Harmless while those rows agree, which was verified for all 20 clubs, and silently wrong the
day ClubElo forward-publishes a projection.

Derived from it, in migration 0008: `fixture_run` gives every metric as **both a per-fixture
rate and a total over the window**. Mid-gameweek the two disagree, because a gameweek spans
Friday to Monday and clubs that have already played hold fewer remaining fixtures. Simulation
showed the entire top six reordering between the two — a club dropping from 3rd to 6th purely
for having one fewer fixture left. Rates are the comparable quantity; totals are what a
manager accumulates and are the only place a double gameweek shows as a gain.

### 3.4 football-data.co.uk — bookmaker odds

`https://www.football-data.co.uk/mmz4281/{season}/E0.csv`, e.g. `2627` for 2026/27.
**Verified: 25/26 returned 380 rows × 132 columns** including `B365H/D/A`,
`AvgH/D/A`, `MaxH/D/A`, over/under 2.5 lines, Asian handicaps, and closing prices.
**26/27 currently 404s** — the file appears once matches are played.

Why this matters more than it looks: de-vigged 1X2 and O/U 2.5 odds convert into
implied win and clean-sheet probabilities that are strictly better fixture-difficulty
inputs than FPL's integer 1–5 FDR. Free, no key, weekly refresh. Paid odds APIs are
unnecessary — and their free tiers (100 req/hour) would be a downgrade in coverage.

**But it is retrospective, and that changed the design (2026-07-26).** `E0.csv` only
contains matches already played: all 380 rows for 2025-26 carry a final score, none is in
the future. There is no bookmaker price here for a fixture six weeks out, so odds **cannot**
drive a forward-looking fixture ticker. What they can do is *calibrate* one — the Elo model
in migration 0007 takes its home-advantage, draw-curve and scoring constants from a fit
against the 272 matches where we hold both these de-vigged probabilities and each side's Elo
on the day. See `scripts/probe/calibrate_elo_fixtures.py`. So the market still sets the
numbers; it just does so a season in arrears.

~~A live-odds source for upcoming fixtures would be a genuine upgrade and remains unsolved on
free terms.~~ **Solved 2026-07-29 — see §3.5.** The claim was wrong in the way a limit assumed
from the tool at hand usually is: it generalised from the one odds source in the repo to "free
forward-looking odds do not exist". Norsk Tipping serves them without a key.

---

### 3.5 Norsk Tipping (Oddsen) — the only source that prices an *unplayed* fixture

`https://api.norsk-tipping.no/OddsenGameInfo/v1/api`, **no API key**. The only header that
matters is `Accept: application/json;charset=utf-8`. Carried over from `../vm26`, which reads
the same endpoint for the World Cup.

```
GET /events/FBL/{fromYYYYMMDD}0000/{toYYYYMMDD}2359   -> events, each with its mainMarket
GET /markets/{eventId}                                -> every market currently OPEN
```

**Premier League is tournament `35887`.** The Community Shield is `37442` and is deliberately
excluded — not an FPL fixture, and it would resolve to two Premier League clubs.

Two paths matter and the rest 403. `events/{eventId}` and `livedata/{eventId}` return 204 for a
non-live match. vm26 reads only `mainMarket` off the event list; `markets/{eventId}` is the one
carrying team totals and clean sheets.

**Measured 2026-07-29:**

| What | Result |
|---|---|
| GW1 fixtures priced | **9 of 10.** Fulham v Chelsea, the Monday game, is not posted at all |
| Markets per event | **1 (HUB)**. The deep set opens ~15h before kickoff |
| Lead time | Arsenal v Coventry's HUB opened `betStart = 2026-06-21` — two months ahead |
| Club names | English (`Brighton and Hove Albion`, `Nottingham Forest`). The existing `TeamResolver` resolves **all 20 with no new aliases** — verified, not assumed |
| History | **None.** Any window ending before today returns 204 |
| Horizon | Roughly one gameweek. GW2 is not posted |

**Three gotchas, each of which cost a debugging cycle or would have.**

1. **The window accepts whole days only, and 204 is overloaded.** The path *looks* like
   `YYYYMMDDHHmm`, but only `0000` for `from` and `2359` for `to` return data. `202607290001`
   and `202607291200` both answer **204** for a window holding 135 events, as does a `to` of
   `2300`. So 204 means both "nothing in range" and "your range was malformed", and passing
   `datetime.now()` straight through returned 0 events from a window with 9 Premier League
   fixtures. `sync/sources/norsk_tipping.py` takes `date`, not `datetime`, so the mistake is
   structurally unavailable rather than merely documented.
2. **Market depth is per competition, not per lead time, and the PL's is unmeasured.**
   Conference and Champions League qualifiers 4–30h out carried **8** markets with no team
   totals, while Brasil Serie A at 12–15h carried **46** and Argentine Primera **22**. No PL
   fixture falls inside the deep window before 21 August, so whether the PL gets the 46-market
   set **cannot be established today**. A priori it should — the PL is Norsk Tipping's largest
   football product — but that is an expectation. [FIX_WHEN_LIVE.md](FIX_WHEN_LIVE.md) §1 holds
   the 19–20 August probe that settles it, and it decides how much of this section survives.
3. **Incomplete coverage of a priced gameweek is the expected state.** One of ten GW1 fixtures
   is simply absent. Unmatched events are logged to `unmatched_names` and **never fatal** —
   vm26's rule, and the right one: odds are decision support, not scoring.

**What the deep set is worth, if it appears.** Three of its markets are numbers this repo
currently models rather than prices:

- `{Team} Totalt 0.5` over → **P(team scores 1+)**, allaboutfpl's `% 1+ Goal`
- `{Team} Totalt 1.5` over → **P(team scores 2+)**, their `% 2+ Goals`
- `{Team} holder nullen` → **P(clean sheet)**, which `fixture_difficulty` supplies as
  `exp(−λ_against)` from a two-parameter Elo model. A market price with the centre-back's
  suspension already in it is a different quality of number, and clean sheets decide every
  goalkeeper and defender — half the squad.
- `Korrekt resultat` gives the full scoreline distribution, from which the rest is exact.

**This complements `fixture_difficulty` and does not replace it.** The horizon is one gameweek,
so: **this gameweek → market** (team news priced in), **next 2–6 gameweeks → Elo** (the only
thing that reaches that far, and the only team metric covering promoted clubs). Label which is
which on screen.

**It also unblocks a checklist item rather than adding one.** Validating the Elo model was
deferred to "once `2627/E0.csv` exists (~GW10)" because football-data publishes only played
matches. Norsk Tipping prices *unplayed* ones, so `p_win` can be tracked against a live market
from GW1 — ten fixtures a week, continuously. A one-off calibration becomes a monitored one.

Lands in `market_odds` (migration 0023), **append-on-change** keyed
`(source, external_event_id, fetched_at)` so price drift is preserved rather than upserted away.
Ingest derives nothing — the λ-inversion from de-vigged 1X2 + O/U + BTTS is modelling and
belongs in the derived-views layer, the same rule `sync/jobs/odds.py` states for clean sheets.
`scripts/probe/prove_market_parse.py` asserts the parser against the deep-market names without a
network, so if August brings unfamiliar names we know the parser is not the problem.

We store **derived probabilities**, never betting links or prices as an invitation to bet. This
is a football-analysis tool for a friend group and stays one.

---

## 4. Tier 3 — Cross-check and backfill

### olbauday/FPL-Core-Insights — read the caveats before using it

Three things about this source turned out to be materially different from first impressions,
all found on 2026-07-26 while building the derived views. Two of them would have silently
corrupted every per-90 in the app. A fourth arrived with the new season and is below them.

**1. The `By Gameweek/GW{n}/` folders are not Premier League only.** They include Champions
League, Europa League and cup fixtures played in the same window. Of 519 distinct 2025/26
matches: **379 `prem`, 64 Champions League, 37 EFL Cup, 26 Europa League**, and 1 863
player-gameweek pairs have more than one match row. Unfiltered, Declan Rice showed **4 246
minutes against FPL's 3 093** — a 37% overstatement that would have deflated every rate
computed from it.

The competition is encoded in `match_id`
(`25-26-champions-league-arsenal-vs-athletic-club`), so `core_insights_player_match.tournament`
now carries it. **Filter to `tournament = 'prem'` for anything FPL scores.** With that filter
minutes reconcile against FPL for 93 of 98 defenders and 116 of 128 midfielders.

Labelled, the non-league rows become an asset rather than a defect: minutes in other
competitions are precisely the rotation-and-fatigue signal FPL's own data cannot provide.
That's what `player_congestion` exposes.

**2. Its `defensive_contributions` is wrong for defenders and goalkeepers.** With the
`prem` filter applied it matches FPL exactly for midfielders (113 of 128) and forwards (23
of 25), but not defenders (6 of 98, averaging +21.5) or goalkeepers (+84). It appears to
apply the midfielder formula to everyone, so defenders gain their recovery count, which FPL
excludes.

Reconstructing FPL's figure from this source's components does not work either — tested
`clearances + blocks + interceptions + tackles` (3 of 98 exact), with headed clearances
added (1 of 98), and with tackles-won substituted (0 of 98). The underlying counting
definitions differ.

**Use FPL's `defensive_contribution` and nothing else.** Consequence for the product: true
per-match DEFCON *hit rate* ("how often does this player clear the threshold") is not
computable until GW1, when `player_gw_stats` supplies FPL's own per-match figure. Until then
the scout shows DEFCON per 90, which is an honest proxy and labelled as one.

**3. The physical data is ~1% populated, not a headline feature.** `distance_covered` and
`top_speed` were recorded here as an advantage no other free source offers. Measured: for
2025/26 only **144 of 12 242 rows** carry a non-zero distance and 281 a non-zero top speed,
absent entirely from GW1–12 and scattered between GW6 and GW36.

The zeros are also not zeros — a player on the pitch for 90 minutes did not run 0 km — so
averaging them dragged every figure to `0.00`, which is how the gap was noticed at all.
`player_congestion` now applies `nullif(..., 0)` and publishes
`matches_with_physical` so the thin sample is visible. Worth re-checking in-season; if
coverage improves this becomes genuinely useful.

**4. The 2026-27 payload changed shape, and it broke four screens.** Found 2026-08-24, three
days after the GW1 deadline wrote the first 2026-27 rows. Three changes, in order of how much
they cost:

- **Every counter is now a float string.** `"clearances": "1.0"` where 2025-26 wrote `"1"`.
  That is not a widening — `(stats->>'clearances')::int` raises
  `invalid input syntax for type integer: "1.0"`, and because `player_match_metric` (0027) is
  the base of `player_form_metric` → `rotation_risk` → `my_squad` and `sell_candidates`, one
  bad cast took out `/me` and half of `/gw` with an error that named none of them. Migration
  0027 now casts everything out of `stats` to `numeric`. **Never `::int` on a `stats` key.**
- **Keys are sparse.** 2025-26 wrote all 53 keys on all 12 242 rows. 2026-27 writes a key only
  where it has a value: of 313 rows, `clearances` appears on 245, `total_shots` on 111,
  `accurate_crosses` on 104. A missing key is `null`, not zero, and `where value is not null`
  in `player_match_metric` already drops those rows rather than counting them as zero.
- **Four keys are gone: `tackles`, `big_chances_missed`, `defensive_contributions`,
  and the physical set** (`running_distance`, `sprinting_distance`, `number_of_sprints`,
  plus `corners`, `offsides`, `successful_dribbles`, `tackles_won_percent`). Only
  `tackles_won` remains of the tackle pair. Consequence: `cbit` and `defcon_hit` sum to
  `null` for every 2026-27 row and produce **no rows at all** in `player_match_metric`, and
  `big_chances` likewise. Nothing errors and nothing is wrong — the metric is simply absent,
  which is the failure mode this file exists to make visible. It costs nothing before GW6
  because the window needs six appearances, so there is runway to decide whether
  `tackles_won` is an acceptable substitute for `tackles` in CBIT (it is a subset, so it
  understates) or whether the DEFCON hit rate should come from FPL's own per-match figure
  instead — which §2 above already argues is the only trustworthy source for it.

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
| Which players are performing *right now* | **`player_form_metric`** — last six league appearances against his own season, gated on measured `rel(6)` within position | FPL `form`, xGI per 90; Sofascore `rating` |
| **Has he actually changed, or is that noise?** | **His own match-to-match standard error** (`separated`), not a league comparison | `player_form_reliability` publishes the decomposition per position per metric |
| Which players are hidden gems | FPL API (`selected_by_percent` × xGI/90 × `now_cost`) | Understat `xa`/`xg_buildup`, Sofascore `bigChancesCreated` |
| **Who rises/falls in price in the next 24h** | **Our own `player_snapshots` time series** (net-transfer velocity) | FPL `price_change_percent`, `transfers_in/out_event` |
| Which teams are performing | Understat team xG/xGA rolling | ClubElo, odds-implied strength |
| **Which teams play defensive football** | **Understat `ppda` + `deep_completions`** | xGA per match, O/U 2.5 odds |
| **Whose defenders and target men are worth owning** | **Understat `situation` → dead-ball share of npxG** (`team_style_metric`) | corner/set-piece/free-kick xG in `team_dead_ball` |
| **How much to trust any of the above** | **`team_style_reliability`** — the variance decomposition, recomputed, never a stored constant | `prove_style_claims.py` re-derives it in Python |
| **Which price bracket actually returns** | **`position_price_value`** — points per £m of *start* cost, by position × band, recomputed per read | `history_past` only, so departed players are absent and every level is an upper bound |
| **What do I change this week** | **`sell_candidates`** — reason codes, never a score; a blank run is deliberately *not* one | `target_players` for the buy half, and the conflict between them is shown rather than resolved |
| **Is he exposed to being rotated** | **`rotation_risk`** + `squad_competition` — same club, same position, comparable minutes | `tournament` per match for recent midweek load; no press-conference text, ever |
| **Blanks and doubles** | **`gameweek_shape`** — confirmed, flat, or **provisional** where cup rounds are undrawn | Reports a flat season today; the value is being ready when the first round is drawn |
| Fixture difficulty (better than FDR) | **ClubElo**, via the fitted model in migration 0007 | football-data.co.uk odds as the *calibration target*, FPL `difficulty` for comparison |
| **This gameweek's fixture, with team news in it** | **Norsk Tipping `market_odds`** — a price for an *unplayed* match, which no other source here gives | Elo beyond the ~1-gameweek horizon; `basis` says which is which |
| **Is the Elo model still right?** | **Norsk Tipping `p_home` vs `fixture_difficulty.p_win`** on unplayed fixtures, weekly from GW1 | football-data's played-match fit (a season in arrears) |
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
