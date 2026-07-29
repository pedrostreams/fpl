-- ---------------------------------------------------------------------------
-- 0024 — clock the market-odds capture
--
-- Separate from 0023 so the table and the schedule can be reasoned about independently: the
-- table is schema, this is deployment cadence, and the cadence is the part with a deadline.
--
-- Norsk Tipping serves **no history** — any window ending before today returns 204 — so this
-- is the same class of table as `player_snapshots`: an uncaptured gameweek is gone permanently.
-- Start capturing before 2026-08-21 and we own a season of pre-match prices; start in January
-- and half the season is lost.
--
-- Cadence reasoning, and why two jobs rather than one:
--   - Every two hours is enough to never miss a gameweek and to catch the deep market set,
--     which opens ~15h before kickoff — a window seven times wider than the interval.
--   - Prices move most in the hours around a deadline and on match days, so Friday through
--     Sunday gets hourly. `insert_ignore` plus the job's change detection means a quiet market
--     writes nothing, so the extra frequency costs requests, not rows.
--
-- Both are off the round minute. Measured 2026-07-28: moving the sync crons off :00 improved
-- GitHub's dispatch latency from ~200 to ~130 median minutes. `cron.schedule` is
-- upsert-by-name, so re-running this migration re-points rather than duplicates.
--
-- ORDERING NOTE, because `verify` will go red otherwise
-- These jobs dispatch a workflow **by filename on the default branch**. Applying this migration
-- before `.github/workflows/sync-market-odds.yml` is pushed means the first firing gets a bare
-- `404 Not Found` from the Actions API, and `workflow_dispatch_health` reports a failure that
-- looks like a dead token. It is neither — it clears on the next run after the push. Apply the
-- migration and push the workflow together, and if you see that 404, check the file is on `main`
-- before touching the PAT.
-- ---------------------------------------------------------------------------

select cron.schedule(
  'market-odds-regular',
  '23 */2 * * *',
  $$select dispatch_workflow('sync-market-odds.yml')$$
);

-- Friday, Saturday, Sunday. pg_cron's day-of-week is 0=Sunday, so 5,6,0.
select cron.schedule(
  'market-odds-matchdays',
  '53 * * * 5,6,0',
  $$select dispatch_workflow('sync-market-odds.yml')$$
);
