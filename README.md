# FPL — data-driven Fantasy Premier League tooling

A free-data replacement for a Fantasy Football Fix Premium subscription, built for one
Norwegian friend-group mini-league.

**GW1 deadline: 2026-08-21 17:30 UTC.** That's the target.

- [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) — every candidate source, tested against
  the live endpoint, with what it actually provides and what died recently.
- [docs/PLAN.md](docs/PLAN.md) — phases and sequencing.
- [docs/SYNC_PLAN.md](docs/SYNC_PLAN.md) — schema, cadence, idempotency, identity matching.
- [docs/FIX_WHEN_LIVE.md](docs/FIX_WHEN_LIVE.md) — 136 checks to run once the season starts,
  ordered by when each becomes checkable. Nothing is `finished` until the deadline, so a large
  part of this codebase has never executed against the data shape it will run on for ten months.

## Stack

| Layer | Choice |
|---|---|
| Store | Supabase Postgres (`eu-central-1`) |
| Sync runtime | GitHub Actions cron → Python → Postgres |
| Enrichment scrapers | `soccerdata` (Understat), `ScraperFC` + `curl_cffi` (Sofascore) |
| Web app | Next.js + TypeScript, read-only over SQL views |
| Hosting | Static export on Cloudflare Workers (free plan), `fpl.peiling.tech` |

Sync is Python end-to-end and writes straight to Postgres. That's a deliberate change
from `Sporting_Director_Game`, whose `Python → JSON → TypeScript` hop is documented as
"currently manual" — the extra step is what stopped it being automated.

## Three facts that shape everything

1. **The FPL API now carries Opta xG/xA/xGC natively** — 105 fields per player. No paid
   provider is needed for FPL work.
2. **FBref is dead for advanced stats.** Sports Reference lost its Opta licence in
   January 2026 and deleted the data. Don't build on it.
3. **The FPL API has no history endpoint.** Price and ownership time series only exist if
   we capture them. Nothing can be backfilled — which is why the snapshot job runs now,
   even though prices are frozen until GW1.

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env      # then fill in DATABASE_URL
```

`DATABASE_URL` must use the Supabase **session pooler** host. `vm26`'s notes record that
`db.<ref>.supabase.co` does not resolve:

```
postgresql://postgres.<ref>:<pw>@aws-1-eu-central-1.pooler.supabase.com:5432/postgres
```

Apply the schema:

```bash
psql "$DATABASE_URL" -f supabase/migrations/0001_fpl_core.sql
```

Migrations are idempotent — safe to re-run.

## Commands

```bash
# Health-check every data source (exit code = number of failures)
python scripts/probe/probe_sources.py
python scripts/probe/probe_sources.py understat     # one source

# Sync — --dry-run fetches and transforms but writes nothing
python -m sync.cli dimensions --dry-run
python -m sync.cli snapshot
python -m sync.cli history --limit 20
python -m sync.cli all

# Did the data land, and does it look right? Row counts, freshness, season attribution,
# snapshot behaviour, and growth against the 500 MB free tier.
python -m sync.cli verify
python -m sync.cli verify --reap-stale     # close out runs stuck on 'running'
```

## Cron

| Workflow | Schedule (UTC) | Purpose |
|---|---|---|
| `sync-snapshot` | `0 * * * *` + `*/15 0-2 * * *` | Price/ownership time series; 15-min sampling brackets the nightly price change |
| `sync-daily` | `30 6 * * *` | Dimensions, fixtures, per-gameweek history |
| `probe-sources` | `0 8 * * 1` | Source health; goes red when a scrape breaks |

Set `DATABASE_URL` and `CLOUDFLARE_DEPLOY_HOOK` as repository secrets. Every job that writes
ends by POSTing the deploy hook, because the site is a build artefact — see **Deploy**.

**Note:** GitHub disables scheduled workflows after 60 days without repo activity, and
cron is best-effort under load. Every job is idempotent so a missed run self-heals, and
the `sync_freshness` view surfaces anything stale:

```sql
select * from sync_freshness;
```

## Deploy

The site is a **static export**: `next build` renders all 687 pages to `out/` and Cloudflare
serves them as files. Nothing renders per request, and that is a requirement rather than an
optimisation — the Workers free plan allows **10ms of CPU per invocation**, `/players` was measured
at **300ms**, and exceeding the limit returns Error 1102 rather than a slow page. Requests to static
assets are unmetered and never invoke the Worker, so reading the site has no CPU ceiling at all.
`scripts/check-static.mjs` fails the build if any page slips back to rendering on demand.

The only code that runs per request is `worker/index.ts`: three `/api` endpoints for the watchlist
and saved views, which are the only state a visitor can change. They are one SQL statement each,
and Cloudflare bills CPU rather than the wait for Postgres.

### One-time setup

Everything below needs a Cloudflare login, so it is done once by hand.

PowerShell, because that is the shell on the machine this is run from — `grep` and `$(...)` are
not available there, and getting a *silently empty* connection string out of them makes wrangler
complain about a missing `--database` instead of about the real problem.

```powershell
cd C:\Users\Peder\Desktop\Hobby\fotball\fpl
npx wrangler login

# 1. Hyperdrive pools the connection next to Supabase and terminates TLS itself.
$db = ((Select-String -Path .env -Pattern '^DATABASE_URL=' | Select-Object -First 1).Line) `
        -replace '^DATABASE_URL=', ''
if (-not $db) { throw 'DATABASE_URL not found in .env' }
npx wrangler hyperdrive create fpl-db --connection-string="$db"

# Copy the id it prints into the "hyperdrive" block in wrangler.jsonc, then commit it.
# The id is not a secret: the connection string itself is stored at Cloudflare, not in the repo.

# 2. First deploy, which also creates the Worker. Uploads ~5,500 files / ~132 MB the first time.
npm run deploy
```

Then, in the Cloudflare dashboard under **Workers & Pages → fpl**:

| Step | Where | Value |
|---|---|---|
| Custom domain | Settings → Domains & Routes | `fpl.peiling.tech` (the zone is already on Cloudflare, so DNS is automatic) |
| Deploy on push | Settings → Builds → Connect | repo `pedrostreams/fpl`, branch `main`, build `npm run build`, deploy `npx wrangler deploy` |
| Build variable | Settings → Builds → Variables | `DATABASE_URL` — the build renders every page from Postgres |
| Deploy hook | Settings → Builds → Deploy Hooks | create one for `main`, then add the URL as the `CLOUDFLARE_DEPLOY_HOOK` repository secret |

### Freshness

There is no ISR and no five-minute cache. Every sync job that writes ends by POSTing the deploy
hook, so Cloudflare rebuilds when the data actually changed. Builds take ~2 minutes and run on
Cloudflare's 3,000 free build minutes a month — deliberately not GitHub's 2,000, of which
`verify` already projects ~1,654 going to snapshot dispatches.

### Locally

```bash
npm run dev        # PORT=3210; reads Postgres directly over DATABASE_URL
npm run build      # the export, plus the static-only check
npm run preview    # wrangler dev: the real Worker, the real assets, one env var short —
                   # CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=$DATABASE_URL
```

## Status

Phases 0–2 are in and **running against Supabase**. As of 2026-07-26, 32 MB of the 500 MB
free tier, `verify` all green:

| Table | Rows | Source |
|---|---|---|
| `players` / `player_seasons` | 558 | FPL API |
| `fixtures` | 380 | FPL API |
| `player_season_totals` | 2 568 | FPL API, 21 seasons back to 2006/07 |
| `player_snapshots` | 558 | hourly, insert-on-change |
| `understat_team_match` | 760 | **PPDA + deep completions**, 380/380 matches |
| `understat_shots` | 9 524 | x/y position, body part, situation |
| `core_insights_player_match` | 12 242 | per-match stats incl. physical data |
| `club_elo` | 21 935 | 20 clubs since 2015 |
| `match_odds` | 380 | de-vigged 1X2 + O/U 2.5 |
| `player_external_ids` | 399 | FPL ↔ Understat, avg confidence 0.976 |

**Read before building on any of it:**
[docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) §2.1 — `history_past` is authoritative for
completed seasons (bootstrap disagrees for loan/transfer cases), expected stats only exist
from 2022/23 onward, and 19% of the player pool has no 2025/26 record.
[CLAUDE.md](CLAUDE.md) — the name-matching rules, which exist because the first run stored
ten false positives.

**Web app** (Next.js 16, `npm run dev -- -p 3210`):

| Route | What it shows |
|---|---|
| `/scout` | All 558 players, per-90 rates with percentile heatmaps, sortable and filterable client-side |
| `/gems` | Hidden gems ranked on output × ownership scarcity × value, each score showing its components |
| `/teams` | Fixture difficulty for the next six gameweeks, plus style and performance per team — PPDA press axis, xG/xGA, clean sheets, Elo |
| `/prices` | Price and ownership movement from our own hourly snapshots — the only screen whose data exists nowhere else |

Design language: [.claude/context/DESIGN.md](.claude/context/DESIGN.md). Per-surface go-live
checks: [docs/FIX_WHEN_LIVE.md](docs/FIX_WHEN_LIVE.md).

### Fixture difficulty

No free source prices a fixture more than about a week ahead, and FPL's own rating uses four
values across 760 team-fixtures with 45% of the season in one bucket. So difficulty is modelled
from ClubElo, with every constant **fitted against last season's betting market** rather than
picked by hand:

```bash
python scripts/probe/calibrate_elo_fixtures.py     # refit; prints the constants and the error
```

Fitted on the 272 matches of 2025-26 where both clubs are in the current league and we hold
each side's Elo on the day. It reproduces the market's fixture ordering at a Spearman of
**0.92**, with cross-entropy 1.0281 against a theoretical floor of 1.0142. Clean-sheet
probability is monotone and well-scaled across quartiles (0.181/0.169 → 0.346/0.353,
predicted/observed). The constants live in
[`supabase/migrations/0007_fixture_difficulty.sql`](supabase/migrations/0007_fixture_difficulty.sql);
`python -m sync.cli verify` guards the invariants.

### Price watch

Built, and deliberately near-empty until 2026-08-21. FPL moves no price and counts no gameweek
transfer before the GW1 deadline — verified: all 558 players read 0 net transfers and 0 price
change since the season start. Ownership *does* drift as the crowd builds squads, and that is
the one live signal in preseason.

The columns that need history show `·`, not `0`, until the series reaches back far enough.
`0` would claim a player is stable when the truth is we have not been watching long enough;
`verify` fails if a delta ever appears without the history behind it.

Remaining before GW1: deploy. See [docs/PLAN.md](docs/PLAN.md).
