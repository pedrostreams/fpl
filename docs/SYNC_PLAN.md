# Sync plan

How data gets from the sources in [DATA_SOURCES.md](DATA_SOURCES.md) into Postgres.

**Runtime:** GitHub Actions cron → Python → Supabase Postgres (`psycopg`).
**Everything is idempotent.** Any job can be re-run at any time; a missed cron self-heals
on the next tick.

---

## 1. Design principles

1. **Stable keys, never season-scoped ids.** FPL's `elements[].id` and `teams[].id` are
   reused across seasons. `elements[].code` and `teams[].code` are stable. All foreign
   keys use `code`; the season-scoped `id` lives in a mapping table so we can still parse
   payloads that reference it.
2. **Tag every aggregate with the season it describes.** Verified preseason trap: on
   2026-07-26 the 2026/27 payload carried Haaland's *2025/26* totals (`minutes: 2953`,
   `expected_goals: 25.50`). Ingest resolves the owning season from
   `events` — if no event `is_current` and no event `finished`, aggregates belong to the
   **previous** season.
3. **Snapshots are append-only and insert-on-change.** See §4 — this is the only data we
   can never recover, and also the only table with real growth risk.
4. **Raw payloads are cached to disk before parsing.** Two FBref data losses in a year
   argue that a scrape outage should cost future data, not past data.
5. **Every job writes a `sync_runs` row.** Started, finished, rows touched, error. Without
   this, a silently-skipped cron is invisible.

---

## 2. Schema

### Dimensions

| Table | Key | Notes |
|---|---|---|
| `seasons` | `name` (`'2026-27'`) | `is_current`, `gw1_deadline`. One row per season. |
| `teams` | `code` | Stable across seasons: `name`, `short_name`, `pulse_id`. |
| `team_seasons` | `(season, team_code)` | Season-scoped `fpl_id`, plus `strength_*` fields (all `0` until the season starts). `unique (season, fpl_id)`. |
| `players` | `code` | Stable identity: names, `birth_date`, `region`, `opta_code`, `photo`. |
| `player_seasons` | `(season, player_code)` | Season-scoped `fpl_id`, `element_type`, `team_code`, `start_cost`. `unique (season, fpl_id)` — this is what makes payload parsing possible. |
| `events` | `(season, id)` | Gameweeks: `deadline_time`, `finished`, `data_checked`, `average_entry_score`, `most_selected`, chip plays. |
| `fixtures` | `(season, fpl_id)` | `event`, `kickoff_time`, home/away `team_code`, scores, `team_h_difficulty`/`team_a_difficulty`, `pulse_id`, `stats` JSONB. |

### Facts

| Table | Grain | Source |
|---|---|---|
| `player_snapshots` | player × instant | `bootstrap-static.elements` — the time series (§4) |
| `player_price_events` | player × price change | derived when `now_cost` moves (§4) |
| `player_season_totals` | player × season | `bootstrap-static.elements` aggregates + `element-summary.history_past` |
| `player_gw_stats` | player × gameweek | `element-summary.history`, cross-checked against `event/{n}/live` |
| `sync_runs` | job × run | observability |

### Phase-2 enrichment (migration `0002`)

| Table | Grain | Notes |
|---|---|---|
| `understat_team_match` | **team × match** | Normalised from Understat's `home_*`/`away_*` columns into one row per team per match — far easier to aggregate. Carries `ppda`, `deep_completions`, `xg`, `np_xg`, `expected_points`. |
| `understat_shots` | shot | `xg`, `location_x/y`, `minute`, `body_part`, `situation`, `result` |
| `understat_player_season` | player × season | `xa`, `xg_chain`, `xg_buildup`, `np_xg` |
| `sofascore_player_season` | player × season | 114 stats as JSONB + typed columns for the ones we query |
| `club_elo` | club × validity window | `elo`, `valid_from`, `valid_to` |
| `match_odds` | match | closing odds + de-vigged implied probabilities |
| `player_external_ids` | (player_code, source) | Resolved identity map — see §6 |

Enrichment tables store the **source's own** ids and names verbatim alongside the resolved
`player_code`, so a bad match can be re-resolved without re-scraping.

---

## 3. Cadence

| Job | Schedule (UTC) | Endpoint / source | Why this cadence |
|---|---|---|---|
| `snapshot` | `0 * * * *` (hourly) | `bootstrap-static` | Builds the net-transfer curve. Hourly is what price-prediction sites sample at. |
| `snapshot` (price window) | `*/15 0-2 * * *` | `bootstrap-static` | Prices move once nightly ~01:30–02:30 UK. 15-min sampling brackets the change so we capture both the pre-change state and the outcome. |
| `fpl-full` | `30 6 * * *` (daily) | `bootstrap-static`, `fixtures`, `element-summary` | Dimensions, fixtures, per-GW history. |
| `live` | `*/2 * * * *` during matches | `event/{n}/live` | Only enabled on matchdays. Phase 4. |
| `understat` | `0 7 * * *` (daily) | `soccerdata` | Understat updates post-match; daily is ample. |
| `sofascore` | `20 7 * * *` (daily) | `ScraperFC` | Same. Staggered to spread scrape load. |
| `elo-odds` | `40 7 * * 2` (weekly, Tue) | ClubElo + football-data.co.uk | Elo moves per match; the odds CSV is refreshed weekly. |

**Before GW1** only `snapshot` and `fpl-full` matter — and `snapshot` purely to bank
ownership drift, since transfers and prices are frozen (verified: `max(transfers_in) = 0`).
Enrichment jobs can run daily from now for team/player history from 2025/26.

GitHub Actions cron is best-effort and can be delayed under load. Every job is
idempotent, and `sync_runs` plus a staleness view make a skipped run visible.

---

## 4. Snapshots — the one irreplaceable table

`player_snapshots` is the whole reason to start syncing before the season. The FPL API has
no history endpoint; unsampled moments are gone permanently.

**Insert-on-change.** A naive hourly insert of all 558 players is 558 × 24 × ~300 days ≈
**4M rows/season**, roughly 600 MB with indexes — over Supabase's 500 MB free tier. So
each run compares against the player's latest snapshot and inserts only when a watched
field moved:

```
watched = (now_cost, selected_by_percent, transfers_in_event, transfers_out_event,
           cost_change_event, cost_change_start, price_change_percent,
           status, chance_of_playing_next_round, form, ep_next)
```

Low-owned players are static for hours at a time, so this cuts volume substantially
without losing a single transition. The trade-off is that "value at time T" becomes a
last-value-carried-forward lookup rather than a direct row — fine, and what a time-series
query wants anyway.

**`player_price_events`** records each actual price move (`now_cost` differs from the
previous snapshot) with the net-transfer state that preceded it. Tiny — roughly 10–30 rows
a night — and it is the **labelled training set** for the price model. Never rolled up.

**Retention:** hourly rows older than 45 days roll up to one row per player per day
(keeping the day's last value plus min/max cost). `player_price_events` is exempt.

---

## 5. Idempotency

- Dimensions: `insert … on conflict (key) do update`, chunked at 500 rows.
- `player_gw_stats`, `player_season_totals`: `on conflict do update` on their natural keys,
  so re-running a gameweek is safe and corrects revised stats (FPL does amend bonus and
  assists after the fact — `data_checked` marks a gameweek final).
- `player_snapshots`: append-only, guarded by the change comparison and a
  `unique (player_code, captured_at)` index.
- Enrichment: delete-then-insert per `(source, season, scope)` inside one transaction,
  because scraped datasets change shape between runs.

---

## 6. Cross-source identity

FPL, Understat and Sofascore share no ids. FPL exposes `opta_code` (e.g. `p223094`) but
neither free scrape source publishes Opta ids, so it doesn't bridge them.

Resolve **once**, at ingest, into `player_external_ids (player_code, source, external_id,
method, confidence, matched_at)`. Query paths then join on `player_code` and never do
fuzzy matching at read time.

Cascade, in order: exact normalised name + team → exact normalised name → surname + team +
position → surname + team. Normalisation strips diacritics and punctuation and casefolds.
Unmatched rows are written to `tmp/<source>-unmatched.json` for manual review, exactly as
`Sporting_Director_Game` did — that habit is why its mismatches were debuggable.

Once written, a mapping is sticky: later runs reuse it rather than re-matching, so a
one-off manual correction survives.

---

## 7. Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Supabase Postgres, **session pooler**. `vm26`'s notes record that `db.<ref>.supabase.co` does not resolve — use `aws-1-eu-central-1.pooler.supabase.com:5432`. |
| `FPL_SEASON` | Current season label, e.g. `2026-27`. Defaults to derived-from-`events`. |
| `SOCCERDATA_DIR` | Scrape cache location (`~/soccerdata` locally; a cached Actions path in CI). |

Locally: `.env` (gitignored). In CI: repository secrets. No service-role key is needed —
the sync talks to Postgres directly, not through the Supabase REST API.

---

## 8. Verification

A job is only trusted when:

1. `python scripts/probe/probe_sources.py` exits `0`.
2. `python -m sync.cli <job> --dry-run` parses the live payload and reports row counts
   without touching the database.
3. After the first real run, `sync_runs` shows `status='ok'` and the staleness view
   reports every job as fresh.

Growth check to run monthly against the free tier:

```sql
select pg_size_pretty(pg_total_relation_size('player_snapshots'));
```
