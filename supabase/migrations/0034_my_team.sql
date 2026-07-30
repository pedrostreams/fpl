-- ---------------------------------------------------------------------------
-- 0034 — my team: the squad, the gameweek record, the transfers, the chips
--
-- Every screen in this app so far answers "who is good" in league-wide terms. None answers
-- "what should I do with my fifteen", and that is the question a manager actually has. The
-- difference is not analysis, it is a join: the same views, restricted to the players I own.
--
-- NO AUTHENTICATION IS INVOLVED, AND THAT SURPRISED US
-- `docs/LATER.md` item 10 assumed "log in with FPL" was the prerequisite. It is not, and it is
-- also not possible — login moved to a PingOne OIDC tenant with no public client registration.
-- But `entry/{id}/event/{n}/picks/` is **public from the GW1 deadline onward**, so the squad is
-- a page rather than an integration. The only thing authentication would buy is the *pre*-deadline
-- delta — transfers queued but not confirmed — which is worth about one gameweek of staleness and
-- is not worth storing anyone's credentials for.
--
-- EVERYTHING HERE IS EMPTY UNTIL 2026-08-21 17:30 UTC, AND THAT IS THE EXPECTED STATE
-- Probed 2026-07-30 against entry 1617827: `picks` → 404, `history.current` → `[]`, `transfers`
-- → `[]` with a 200. So these tables ship empty and fill themselves at the deadline with no code
-- change, exactly as `player_price_events` does. The screens must therefore render "not published
-- yet" as a *third* state, distinct from zero and from missing — DESIGN.md §1.2.
--
-- WHY `player_code` AND NOT `element`
-- The picks payload references `element`, which is a **season-scoped** id and is reused across
-- seasons. Every FK in this schema is on `code`, so the resolution happens once at ingest through
-- `player_seasons.fpl_id`. A pick whose element cannot be resolved is dropped and counted rather
-- than stored against the wrong player — the same doctrine as `dedupe_by_player` in the matcher.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- manager_picks — the fifteen, per gameweek
-- ---------------------------------------------------------------------------
-- Historic once written: FPL does not revise a past gameweek's picks, so this is upserted on the
-- natural key rather than appended. `multiplier` carries the captaincy (2, or 3 under Triple
-- Captain) and the bench (0), so it is the single field that says who actually scored for you.
create table if not exists manager_picks (
  entry_id       int         not null,
  season         text        not null,
  event          int         not null,
  player_code    int         not null references players(code) on delete cascade,
  -- 1-11 are the XI in formation order, 12-15 the bench in the order they come on. Keeping the
  -- raw number rather than a boolean means the bench *order* survives, which is the part that
  -- decides who covers a blank.
  pick_position  int         not null,
  multiplier     int         not null default 1,
  is_captain     boolean     not null default false,
  is_vice        boolean     not null default false,
  updated_at     timestamptz not null default now(),
  primary key (entry_id, season, event, player_code)
);

create index if not exists manager_picks_event_idx
  on manager_picks (entry_id, season, event);

-- ---------------------------------------------------------------------------
-- manager_events — the per-gameweek record
-- ---------------------------------------------------------------------------
-- `history.current`. Bank and squad value are in tenths in the payload and stored in millions
-- here, matching `managers` and every price column in the schema.
create table if not exists manager_events (
  entry_id            int         not null,
  season              text        not null,
  event               int         not null,
  points              int,
  total_points        int,
  rank                int,
  overall_rank        int,
  bank                numeric(6,1),
  squad_value         numeric(6,1),
  event_transfers     int,
  transfers_cost      int,
  points_on_bench     int,
  updated_at          timestamptz not null default now(),
  primary key (entry_id, season, event)
);

-- ---------------------------------------------------------------------------
-- manager_transfers — what I actually did
-- ---------------------------------------------------------------------------
-- This is the half of the accountability loop (W7) that costs nothing: the API records my
-- decisions, so no part of the app has to ask me to type them in. Append-only in spirit — FPL
-- never revises a transfer — but keyed so a re-run cannot duplicate one.
create table if not exists manager_transfers (
  entry_id        int         not null,
  season          text        not null,
  event           int         not null,
  player_in       int         not null references players(code) on delete cascade,
  player_out      int         not null references players(code) on delete cascade,
  -- The prices *at the time of the transfer*, which is not the price now and is what decides
  -- whether the move made or lost money.
  price_in        numeric(4,1),
  price_out       numeric(4,1),
  made_at         timestamptz not null,
  primary key (entry_id, season, event, player_in, player_out, made_at)
);

-- ---------------------------------------------------------------------------
-- manager_chips — which chip was played when
-- ---------------------------------------------------------------------------
-- Stored now although the chip planner is a later feature, because it arrives inside the
-- `history` payload the job already fetches: capturing it costs one table and no request, and
-- not capturing it would mean the planner's first question ("which chips do I still hold") is
-- unanswerable for every gameweek that passed before it was built.
create table if not exists manager_chips (
  entry_id   int         not null,
  season     text        not null,
  event      int         not null,
  chip       text        not null,
  played_at  timestamptz,
  primary key (entry_id, season, event, chip)
);

-- ---------------------------------------------------------------------------
-- my_squad — the fifteen, with everything the rest of the app knows about them
-- ---------------------------------------------------------------------------
-- The latest gameweek for which picks exist, which before the first deadline is no gameweek at
-- all and the view is correctly empty.
--
-- **Scoped to `managers`, and that is load-bearing.** `manager_picks` is keyed on `entry_id` and
-- the mini-league job (0035) writes every *rival's* picks into the same table — that is the whole
-- point of storing it by entry. `managers` holds exactly the one entry that is mine, so joining
-- it is what keeps "my squad" from quietly becoming "everyone's squads". Without this the page
-- would render ten teams and the check below would fail on `fifteen_players` in a way that looks
-- like a broken ingest.
--
-- `player_wide` is the join target rather than `player_scout` because it already carries the
-- fixture, the percentages, availability and the club context — every column the squad screen
-- wants is one that some other screen already needed. Adding `rotation_risk` on top is the only
-- thing here that is not already composed.
drop view if exists my_squad cascade;
create view my_squad as
with latest as (
  select p.entry_id, p.season, max(p.event) as event
  from manager_picks p
  join managers m on m.entry_id = p.entry_id
  group by p.entry_id, p.season
)
select
  p.entry_id,
  p.season,
  p.event,
  p.pick_position,
  p.multiplier,
  p.is_captain,
  p.is_vice,
  -- The XI is picks 1-11. Deliberately derived from the position rather than from
  -- `multiplier > 0`, because a benched player under Bench Boost also has a multiplier.
  (p.pick_position <= 11)                              as in_xi,
  w.player_code, w.web_name, w.position, w.element_type,
  w.team_code, w.team_short, w.team_name,
  w.price, w.selected_by_percent, w.total_points, w.points_per_90,
  w.xgi_per_90, w.defcon_per_90, w.xgc_per_90,
  w.minutes_share, w.start_rate,
  w.status, w.news, w.chance_of_playing, w.is_available,
  w.fixture_count, w.opponents, w.fixture_rank, w.fixture_difficulty,
  w.p_team_scores, w.p_team_scores_2plus, w.p_clean_sheet,
  w.gem_score,
  -- Null where the player is not flagged, which is most of them. `risk_word` is the sentence
  -- and `risk_reasons` the codes behind it — the same shape as `sell_candidates`, and for the
  -- same reason: a reason can be argued with and a score cannot.
  r.risk_word,
  r.risk_reasons,
  r.minutes_moved
from manager_picks p
join latest l
  on l.entry_id = p.entry_id and l.season = p.season and l.event = p.event
join player_wide w on w.player_code = p.player_code
left join rotation_risk r on r.player_code = p.player_code;

-- ---------------------------------------------------------------------------
-- my_squad_check
-- ---------------------------------------------------------------------------
-- Every assertion is an aggregate over the same rows, so it is one scan and one aggregate —
-- migration 0031's lesson. Row counts sit beside the booleans because `bool_and` over zero rows
-- is NULL and reads as a pass, and zero rows is exactly what this view holds until 21 August.
drop view if exists my_squad_check cascade;
create view my_squad_check as
with per_squad as materialized (
  -- One scan, grouped once. A lateral subquery per row would re-evaluate the whole view fifteen
  -- times per squad — the `sell_candidates` correlated-exists trap in a new place.
  select
    entry_id, season, event,
    count(*)                                              as players,
    count(*) filter (where in_xi)                         as starters,
    count(*) filter (where is_captain)                    as captains,
    count(*) filter (where is_vice)                       as vices,
    bool_or(is_captain and in_xi)                         as captain_in_xi,
    count(*) filter (where player_code is null)           as unresolved
  from my_squad
  group by entry_id, season, event
)
select
  (select count(*) from manager_picks)                            as picks_rows,
  count(*)                                                        as squads,
  coalesce(sum(players), 0)                                       as squad_rows,
  max(event)                                                      as event,
  -- A squad is fifteen players. Fewer means the element resolution dropped one, which is the
  -- failure this ingest is most likely to have — and a fourteen-man squad merely looks odd
  -- rather than wrong, so nobody would catch it by eye.
  bool_and(players = 15)                                          as fifteen_players,
  bool_and(starters = 11)                                         as eleven_starters,
  bool_and(captains = 1)                                          as exactly_one_captain,
  bool_and(vices = 1)                                             as exactly_one_vice,
  -- A captain on the bench is a real state only under Bench Boost, and even then it is worth
  -- seeing rather than smoothing over.
  bool_and(captain_in_xi)                                         as captain_starts,
  bool_and(unresolved = 0)                                        as all_resolved
from per_squad;
