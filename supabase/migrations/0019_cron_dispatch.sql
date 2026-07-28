-- ---------------------------------------------------------------------------
-- 0019 — move the hourly clock off GitHub's best-effort scheduler
-- ---------------------------------------------------------------------------
-- MEASURED 2026-07-28 over the preceding 24 hours: 12 of 33 scheduled snapshot runs
-- delivered. 36%. The 00:00-02:59 UTC price window — the entire reason the job runs at all —
-- got 1 of 12. Across the whole 49-hour series there is not one hour-to-hour pair: 22 distinct
-- captures, median gap 130 minutes.
--
-- Migration 0018's predecessor commit (cd2986a) moved every cron off the round minute on the
-- theory that ':00' and '*/15' are the contended minutes. It helped a little — median gap fell
-- from ~200 to ~130 — and that is the whole story of what minute offsetting can buy. Packing
-- four cron entries into one hour bought nothing at all: the price window had 4/hour scheduled
-- and delivered 1 in 3 hours.
--
-- `created_at` equals `run_started_at` on all 12 delivered runs, so these are not delayed runs
-- that eventually fired. GitHub never dispatches the other 21.
--
-- THE FIX IS THE TRIGGER TYPE, NOT THE MINUTE. GitHub drops `schedule` events under load; that
-- is documented and best-effort by design. `workflow_dispatch` is an ordinary API-triggered run
-- and is not subject to it. So: keep the Python as the single implementation, and move only the
-- clock — into this database, where pg_cron is a Postgres background worker that does not do
-- best-effort.
--
-- WHY NOT DO THE CAPTURE HERE. pg_net could fetch bootstrap-static directly and the whole
-- insert-on-change diff is expressible in SQL over a jsonb payload. That would remove GitHub
-- from the path entirely — and create a second implementation of `snapshot.WATCHED` to drift
-- out of sync with the first. The scheduler is what is broken. Replace the scheduler.
--
-- COST. 33 dispatches/day, each a run billed at GitHub's 1-minute minimum, is ~1020 min/month
-- against the 2000 free minutes a private repo gets. Plus daily (~150), enrich (~230), probe
-- (~26) and the reduced GitHub backstop (~250) puts the total near 1680. That fits, but not
-- roomily — `workflow_dispatch_load` below reports the running rate so this stops being a
-- guess. If it needs cutting, the daytime hours are the ones to thin: the price window is
-- load-bearing and the rest is transfer-momentum resolution.
--
-- THE PAT IS NOT IN THIS FILE. It lives in Supabase Vault under 'github_actions_pat', inserted
-- out of band. Until it exists every dispatch records `response_error = 'no PAT in vault'`
-- rather than raising, so one query explains the silence instead of a stack trace in
-- cron.job_run_details.
-- ---------------------------------------------------------------------------

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Dispatch log
-- ---------------------------------------------------------------------------
-- pg_net is fire-and-forget: http_post returns a request id and the response appears in
-- net._http_response later, where pg_net's own background worker eventually deletes it (6h
-- TTL by default). A 401 from an expired token would therefore be invisible by the next
-- morning. This table is the durable record; `collect_dispatch_results` copies the outcome
-- across before pg_net drops it.
create table if not exists workflow_dispatches (
  id            bigserial primary key,
  workflow      text        not null,
  request_id    bigint,
  requested_at  timestamptz not null default now(),
  status_code   int,
  response_error text,
  checked_at    timestamptz
);

create index if not exists workflow_dispatches_pending_idx
  on workflow_dispatches (requested_at)
  where checked_at is null;

create index if not exists workflow_dispatches_recent_idx
  on workflow_dispatches (requested_at desc);

-- ---------------------------------------------------------------------------
-- dispatch_workflow — one POST to the Actions REST API
-- ---------------------------------------------------------------------------
-- Not `security definer`: pg_cron runs each job as the role that scheduled it, which is
-- `postgres`, which already owns everything this touches. Adding definer rights would widen
-- the blast radius for no gain.
--
-- One caveat worth knowing rather than discovering: net.http_post writes its headers — token
-- included — into net.http_request_queue until the worker consumes the row. The exposure is
-- transient and visible only to `postgres`, which holds the token anyway, but it is the reason
-- not to hand this function a token belonging to anything other than this one repository.
create or replace function dispatch_workflow(workflow text, git_ref text default 'main')
returns bigint
language plpgsql
as $$
declare
  tok  text;
  req  bigint;
begin
  select decrypted_secret into tok
  from vault.decrypted_secrets
  where name = 'github_actions_pat';

  if tok is null or tok = '' then
    insert into workflow_dispatches (workflow, response_error, checked_at)
    values (workflow, 'no PAT in vault (expected secret named github_actions_pat)', now());
    return null;
  end if;

  select net.http_post(
    url := format(
      'https://api.github.com/repos/pedrostreams/fpl/actions/workflows/%s/dispatches',
      workflow
    ),
    body := jsonb_build_object('ref', git_ref),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || tok,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      -- GitHub rejects API calls without one, and naming the caller means a rate-limit
      -- question can be answered from their side rather than guessed from ours.
      'User-Agent', 'fpl-pg-cron',
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 10000
  ) into req;

  insert into workflow_dispatches (workflow, request_id) values (workflow, req);
  return req;
end;
$$;

-- ---------------------------------------------------------------------------
-- collect_dispatch_results — copy pg_net's answer somewhere it survives
-- ---------------------------------------------------------------------------
-- A successful dispatch answers 204 No Content. Anything else is the interesting case: 401
-- expired or revoked token, 403 missing the Actions:write permission, 404 wrong repo or the
-- workflow file absent from the default branch, 422 bad ref.
create or replace function collect_dispatch_results()
returns int
language plpgsql
as $$
declare
  touched int;
begin
  with resolved as (
    update workflow_dispatches d
       set status_code    = r.status_code,
           response_error = coalesce(
             r.error_msg,
             case when r.status_code between 200 and 299 then null
                  -- The body carries GitHub's own message ("Resource not accessible by
                  -- personal access token"), which names the actual fault far better than
                  -- the status code does. Truncated: a 404 page is HTML.
                  else left(r.content, 500) end
           ),
           checked_at = now()
      from net._http_response r
     where d.request_id = r.id
       and d.checked_at is null
    returning 1
  )
  select count(*) into touched from resolved;

  -- A request whose response pg_net already expired can never be resolved. Mark it rather
  -- than leaving it pending forever and making the backlog look like a live problem.
  update workflow_dispatches
     set response_error = 'response expired before collection',
         checked_at = now()
   where checked_at is null
     and requested_at < now() - interval '3 hours';

  delete from workflow_dispatches where requested_at < now() - interval '30 days';

  return touched;
end;
$$;

-- ---------------------------------------------------------------------------
-- Monitoring
-- ---------------------------------------------------------------------------
-- The question this has to answer at a glance is "is the clock still running, and is the
-- token still valid". Both, in one row.
create or replace view workflow_dispatch_health as
select
  workflow,
  count(*)                                                          as dispatches_24h,
  count(*) filter (where status_code between 200 and 299)            as ok_24h,
  count(*) filter (where status_code is not null
                     and status_code not between 200 and 299)        as failed_24h,
  count(*) filter (where checked_at is null)                         as pending,
  max(requested_at)                                                  as last_dispatch,
  round(extract(epoch from (now() - max(requested_at))) / 60.0)::int  as minutes_since_last,
  -- The first non-2xx message, which is what tells you whether to renew the token or fix a
  -- permission. Nulls sort last so a real error wins over an empty success.
  (array_agg(response_error order by requested_at desc)
     filter (where response_error is not null))[1]                    as last_error
from workflow_dispatches
where requested_at > now() - interval '24 hours'
group by workflow;

-- Billing is the constraint nobody notices until Actions stops, and it cannot be read from
-- the API without a `user`-scoped token. Dispatch count is the part we control, so measure it.
create or replace view workflow_dispatch_load as
select
  count(*)                                              as dispatches_7d,
  round(count(*) / 7.0, 1)                              as per_day,
  -- Every run bills at GitHub's 1-minute minimum however short it is, so dispatches are
  -- minutes. 2000 is the free-plan private-repo allowance.
  round(count(*) / 7.0 * 30)                            as est_minutes_month
from workflow_dispatches
where requested_at > now() - interval '7 days'
  and status_code between 200 and 299;

-- ---------------------------------------------------------------------------
-- The schedule
-- ---------------------------------------------------------------------------
-- pg_cron reads the server timezone, which is UTC on Supabase — the same basis the old
-- workflow crons used, so the price-window reasoning carries over unchanged.
--
-- cron.schedule is upsert-by-name, so re-running this migration re-points an existing job
-- rather than duplicating it. No `if not exists` needed and no unschedule dance.
select cron.schedule(
  'snapshot-hourly',
  '17 * * * *',
  $$select dispatch_workflow('sync-snapshot.yml')$$
);

-- Prices move once nightly, ~01:30-02:30 UK, which is 00:30-01:30 UTC in summer and
-- 01:30-02:30 in winter. Sampling 00:00-02:59 brackets it either way. With the hourly :17
-- this gives four samples an hour across the window: :02, :17, :32, :47.
select cron.schedule(
  'snapshot-price-window',
  '2,32,47 0-2 * * *',
  $$select dispatch_workflow('sync-snapshot.yml')$$
);

-- Five minutes is well inside pg_net's 6-hour response TTL and cheap enough not to think
-- about. It also carries the 30-day retention delete.
select cron.schedule(
  'collect-dispatch-results',
  '*/5 * * * *',
  $$select collect_dispatch_results()$$
);
