# FPL — data-driven Fantasy Premier League tooling

A free-data replacement for a Fantasy Football Fix Premium subscription, built for one
Norwegian friend-group mini-league.

**GW1 deadline: 2026-08-21 17:30 UTC.** That's the target.

- [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) — every candidate source, tested against
  the live endpoint, with what it actually provides and what died recently.
- [docs/PLAN.md](docs/PLAN.md) — phases and sequencing.
- [docs/SYNC_PLAN.md](docs/SYNC_PLAN.md) — schema, cadence, idempotency, identity matching.

## Stack

| Layer | Choice |
|---|---|
| Store | Supabase Postgres (`eu-central-1`) |
| Sync runtime | GitHub Actions cron → Python → Postgres |
| Enrichment scrapers | `soccerdata` (Understat), `ScraperFC` + `curl_cffi` (Sofascore) |
| Web app (Phase 4) | Next.js + TypeScript, read-only over SQL views |

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

Set `DATABASE_URL` as a repository secret.

**Note:** GitHub disables scheduled workflows after 60 days without repo activity, and
cron is best-effort under load. Every job is idempotent so a missed run self-heals, and
the `sync_freshness` view surfaces anything stale:

```sql
select * from sync_freshness;
```

## Status

Phase 0 (research) and Phase 1 (core FPL sync) are in and **running against Supabase**.
First real sync 2026-07-26: 558 players, 380 fixtures, 2 568 season-total rows across 21
seasons, 558 snapshots. `verify` reports all checks passing at 1.7 MB of 500 MB.

Three data constraints found in that first sync — read
[docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) §2.1 before building on the aggregates:
`history_past` is authoritative for completed seasons (bootstrap disagrees for loan and
transfer cases), expected stats only exist from 2022/23 onward, and 19% of the player pool
has no 2025/26 record.

Phase 2 (Understat / Sofascore / ClubElo / odds enrichment) is next — see
[docs/PLAN.md](docs/PLAN.md).
