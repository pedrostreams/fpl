# FPL data platform — plan

**Goal:** a data-driven FPL web app good enough to replace a Fantasy Football Fix Premium
subscription, built on free sources that refresh at least daily.

**Two dates that drive everything:**
- **2026-08-14** — the premium subscription lapses. The tool should be *useful* by then.
- **2026-08-21 17:30 UTC** — GW1 deadline. The tool should be *complete* by then.

Written 2026-07-26, revised the same day after the first real sync surfaced four
constraints that changed the sequencing. Those are in §2 — read them before planning work.

---

## 1. Decided stack

| Layer | Choice | Why |
|---|---|---|
| Store | Supabase Postgres (`eu-central-1`) | Same as `vm26` and `Sporting_Director_Game`. |
| Sync runtime | **GitHub Actions** | Only free host doing sub-daily cron *and* Python. Vercel Hobby cron is 1×/day and can't run `soccerdata` at all. |
| Ingest language | **Python → Postgres directly** | `soccerdata` is Python-only. Drops the `Python → JSON → TS` hop that left SDG's enrichment "currently manual". |
| Web app | Next.js + TS on Vercel, read-only over SQL views | Phase 4. |
| Auth | **None for v1** | Every figure we display is public data. Adding Supabase auth + RLS costs days and protects nothing. Revisit only if mini-league picks get stored. |

Status: sync is live and verified against Supabase. `verify` green at 1.7 MB of 500 MB.

---

## 2. The four constraints that reshaped this plan

All four were discovered by probing live sources and inspecting real synced data, not from
documentation. Each one invalidated an assumption in the first draft of this plan.

**1. Prices are frozen until GW1, so the price model cannot start early.** Verified:
`max(transfers_in) = 0` and `cost_change_start = 0` for all 558 players. Squad selection
does not register as transfers. The price screen is blocked by *data*, not by code.

*But* `selected_by_percent` is live — 1.57M squads are being built and ownership drifts
daily. That can never be backfilled, so the hourly snapshot job runs from now regardless.
It costs one cron and banks the only thing that's currently accruing.

**2. Expected stats only exist from 2022/23.** `history_past` reaches back to 2006/07 (21
seasons), but xG/xA/xGI/xGC are zero through 2021/22. Any xG-based backtest has **four**
completed seasons. Pre-2022/23 history is usable for points, minutes and price trajectories
only.

**3. 19% of the player pool has no prior-season record.** 104 of 558 players, all with zero
minutes — new signings, promoted clubs, academy. **A scout that ranks on last-season xGI/90
is blind to exactly where hidden gems live.** The scout and hidden-gems screens need an
explicit cold-start path, not a silent omission.

**4. Sofascore is blocked from GitHub Actions.** Confirmed in CI: 403 to runner IPs,
fine from a home connection. Datacenter ranges are filtered. **Decision: drop Sofascore from
the hosted sync and use FPL-Core-Insights instead** — it carries per-match player stats
(tackles, interceptions, clearances, blocks, dribbles, keeper stats) keyed on FPL ids, at
better granularity than Sofascore's season aggregates, and is reachable from Actions.
`sync/sources/sofascore.py` stays in the repo for optional local use if a specific metric
proves necessary.

Also worth remembering: **`history_past` is authoritative for completed seasons, not
`bootstrap`** (they disagree for loan and transfer cases), and **`soccerdata` caches
aggressively** — a short row count means a stale cache, not a source gap. Both cost real
time already. Details in [DATA_SOURCES.md](DATA_SOURCES.md) §2.1 and §3.1.

---

## 3. Week-by-week to GW1

Sequenced so a *usable* tool exists by 2026-08-14 when premium lapses, rather than
everything landing at once on the 21st.

### Week 1 — 2026-07-27 → 08-02: enrichment sync

Migration `0002` plus one Python job per source, each `run(client, *, dry_run=False)`.

- **Understat** — `understat_team_match` (normalised to one row per team per match, so
  PPDA and deep completions aggregate cleanly), `understat_shots` (9 524/season with x/y,
  body part, situation), `understat_player_season` (xA, xGChain, xGBuildup).
- **FPL-Core-Insights** — per-match player stats, keyed on FPL ids. Mirror what we use;
  it's one volunteer's repo with no stated licence or SLA.
- **ClubElo** — team Elo time series.
- **football-data.co.uk** — closing odds. `2627/E0.csv` 404s until matches are played, so
  ingest 25/26 now and let the current season appear on its own.
- **Identity** — resolve FPL ↔ Understat once into `player_external_ids`. Cascade on
  normalised name + team, then surname + team + position. Log unmatched to
  `tmp/<source>-unmatched.json`. Sticky: later runs reuse the mapping so a manual
  correction survives.

Done when: `verify` covers the new tables and the probe still exits 0.

### Week 2 — 2026-08-03 → 08-09: derived metrics + scout screen

Migration `0003`, views and materialised views. SDG proved the matview pattern; reuse it,
including its rule that base-stat writes need an explicit refresh.

- Rolling per-90s over last N gameweeks, minutes-weighted.
- Percentile ranks per position — the input to the heatmap.
- Over/underperformance: `goals − xG`, `assists − xA`.
- Value: points per £m, xGI per £m.
- **DEFCON reliability** — rate of clearing the threshold per 90, not the season total.
- **Cold-start handling** for the 104 players with no history (constraint 3).

Then the Next.js app: scaffold + **player scout** table with percentile heatmaps. Lift the
TanStack Table approach and `lib/heatmap.ts` from
`Sporting_Director_Game/components/players-table/` rather than reinventing it.

Note: `vm26` runs Next 16 with Base UI (not Radix) and composes via the `render` prop, not
`asChild`. Match that, and read `node_modules/next/dist/docs/` first — its `AGENTS.md`
warns the version has breaking changes.

### Week 3 — 2026-08-10 → 08-16: the tool becomes useful

**Target: usable by 2026-08-14.**

- **Hidden gems** — high xGI/90 × low ownership × low price × rising minutes, with the
  reason shown, and honest about cold-start players.
- **Team profiles** — PPDA and deep completions as a defensive/pressing axis, rolling
  xG/xGA, Elo.
- ~~**Fixture ticker on odds-implied difficulty.** De-vigged 1X2 and O/U 2.5 give win and
  clean-sheet probabilities. Falls back to Elo until `2627/E0.csv` exists.~~ **Done, but not
  as planned.** The fallback turned out to be the only option: `E0.csv` contains *only played
  matches*, so it never prices a future fixture and "until it exists" was never going to
  arrive. Elo is the primary input, and the odds are used to **fit** the model's constants
  against the 272 matches where we hold both. Better than the original plan — the market
  still sets the numbers, and the fit is measurable (Spearman 0.92 vs market). Delivered with
  three lenses, because one difficulty number cannot serve a striker and a centre-back.
- Set-piece and penalty threat, straight from the FPL taker orders — free and first-party.

### Week 4 — 2026-08-17 → 08-21: price watch, deploy, buffer

- **Price watch** screen. Net-transfer velocity plus FPL's own `price_change_percent` as an
  input signal. Shows nothing until the GW1 deadline unfreezes prices — that's expected,
  and the snapshot pipeline is already warm so it fills in by itself.
- Deploy to Vercel, wire `sync_freshness` into a visible staleness indicator.
- Buffer. Four weeks with no slack is not a plan.

---

## 4. After GW1

**Mini-league effective ownership** — the differentiator. Pull the friend group's actual
squads via `leagues-classic/{id}/standings/` → `entry/{id}/event/{n}/picks/` and compute EO
against *those 10–20 rivals* instead of the global top-10k.

Fantasy Football Fix structurally cannot offer this: it doesn't know who you're playing
against. It is the most direct answer to using this to your advantage. Blocked until the
season starts, because picks are hidden pre-GW1.

**Still needed from you:** the mini-league id, from the FPL URL
(`.../leagues/XXXXXX/standings/c`).

**Price model training** — once `player_price_events` has a few weeks of labelled moves,
fit the rise/fall model properly instead of a threshold heuristic.

---

## 5. Feature → source map

| What you asked for | Source | Lands |
|---|---|---|
| Who's performing right now | FPL `form`, xGI/90, DEFCON/90 | Week 2 |
| Hidden gems | FPL ownership × xGI/90 × price | Week 3 |
| Price rise/fall next 24h | **our own snapshots** + `price_change_percent` | collecting now, screen Week 4 |
| Which teams are performing | Understat xG/xGA, ClubElo | Week 3 |
| Which teams play defensively | **Understat PPDA + deep completions** | Week 3 |
| Better fixture difficulty | ClubElo, fitted to de-vigged odds | Week 3 |
| DEFCON bankers | FPL `defensive_contribution_per_90` | Week 2 |
| Set-piece threat | FPL taker orders | Week 3 |
| Beat *your* mini-league | `leagues-classic` + `entry/.../picks` | After GW1 |

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| A Tier 2 source breaks — FBref lost two feeds in a year | Cache raw payloads; the weekly probe gates CI and names what failed. An outage costs future data, not past. |
| Four weeks with no slack | Week 4 is deliberately light. If it slips, price watch is the thing to cut — it shows nothing before GW1 anyway. |
| Scope creep into the web app | Weeks 1–2 are data. Resist starting UI before the views exist; a pretty table over wrong numbers is worse than no table. |
| `player_snapshots` outgrows the free tier | Insert-on-change (proven by `prove_snapshot_logic.py`), plus a 45-day rollup to daily. `verify` prints total size every run. |
| Actions cron drifts or is skipped | Every job is idempotent, so a missed run self-heals. `sync_freshness` makes staleness visible. |
| FPL-Core-Insights disappears (one volunteer, no SLA) | Mirror what we consume into our own tables; never read it live at request time. |

---

## 7. Conventions

- Migrations are **append-only and idempotent** (`if not exists`); views get `drop` +
  `create` in a new numbered migration.
- **Any change to a data source or derived metric updates
  [DATA_SOURCES.md](DATA_SOURCES.md) in the same commit.** This is what keeps the project
  debuggable, and it has already caught two of our own wrong claims.
- Every sync job records to `sync_runs` and is safe to re-run.
- New source → `sync/jobs/*.py` exposing `run(client, *, dry_run=False) -> dict`,
  registered in `sync/cli.py:JOBS`, plus a check in `scripts/probe/probe_sources.py`.
- Docs and code in English; commit messages and conversation in Norwegian.
