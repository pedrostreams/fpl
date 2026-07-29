-- ---------------------------------------------------------------------------
-- 0023 — forward-looking market odds (Norsk Tipping)
--
-- The first source here that prices a fixture BEFORE it is played.
-- `football-data.co.uk` publishes only played matches, so `match_odds` can calibrate the Elo
-- model but can never rate next weekend; `fixture_difficulty` reaches six weeks out but has
-- no team news in it. This table is the third leg: a market price for this gameweek, with the
-- centre-back's suspension already in it.
--
-- WHY A NEW TABLE RATHER THAN COLUMNS ON `match_odds`
-- `docs/feat/allaboutfpl-learnings.md` §7.1 proposes `match_odds` gain `source`,
-- `fixture_fpl_id` and `fetched_at`, keyed `(fixture, source, fetched_at)`. That key cannot be
-- built: football-data rows are retrospective and have no `fixture_fpl_id`, and a Postgres
-- primary key cannot contain nulls. The grain differs too — `match_odds` is one upserted row
-- per match, this is one row per *price movement*. Sharing the table would force one of the
-- two sources to lie about its key.
--
-- APPEND-ON-CHANGE
-- Keyed on `(source, external_event_id, fetched_at)` and written with `insert_ignore`, so
-- drift is preserved rather than upserted away. The job skips a capture whose probability
-- vector is unchanged, which makes every stored row a genuine movement. Consequence carried
-- over from `player_snapshots`: **liveness comes from `sync_runs`, never `max(fetched_at)`** —
-- a quiet market writes no rows at all, and reading freshness off this table would report a
-- healthy job as dead through the whole preseason.
--
-- WHAT IS MEASURED AND WHAT IS NOT (2026-07-29)
-- 9 of GW1's 10 fixtures are priced, each carrying HUB only — 1X2 and nothing else. Fulham v
-- Chelsea, the Monday game, is not posted. The deep 46-market set that carries team totals
-- and `holder nullen` opens ~15h before kickoff, and **the Premier League's depth is
-- unmeasured** because no PL fixture falls inside that window before 21 August. So every
-- column below except the 1X2 block is null today, by design, and `market_odds_check`
-- publishes a row count beside each gated assertion rather than letting `bool_and` over zero
-- rows read as a pass.
-- ---------------------------------------------------------------------------

create table if not exists market_odds (
  source              text not null,            -- 'norsk-tipping'
  external_event_id   text not null,            -- NT eventId, e.g. '8459626.1'
  fetched_at          timestamptz not null,     -- in the key: odds move, and when matters
  season              text not null,
  fixture_fpl_id      int,                      -- null until the event resolves to a fixture
  event               int,                      -- gameweek, denormalised for convenience
  kickoff             timestamptz,
  home_team_raw       text not null,            -- Norsk Tipping's own spelling, always kept
  away_team_raw       text not null,
  home_team_code      int references teams(code),
  away_team_code      int references teams(code),

  -- 1X2. The only market open outside the deep window, and the one that expires.
  odds_home           numeric(8,3),             -- decimal odds as served
  odds_draw           numeric(8,3),
  odds_away           numeric(8,3),
  p_home              numeric(6,5),             -- de-vigged, normalised to sum 1
  p_draw              numeric(6,5),
  p_away              numeric(6,5),

  -- The deep set. Null until the market opens; see the header.
  p_btts              numeric(6,5),
  p_over_05           numeric(6,5),
  p_over_15           numeric(6,5),
  p_over_25           numeric(6,5),
  p_over_35           numeric(6,5),
  p_home_scores       numeric(6,5),             -- '{Team} Totalt 0.5' over = P(scores 1+)
  p_away_scores       numeric(6,5),
  p_home_scores_2plus numeric(6,5),             -- '{Team} Totalt 1.5' over = P(scores 2+)
  p_away_scores_2plus numeric(6,5),
  p_home_clean_sheet  numeric(6,5),             -- '{Team} holder nullen'
  p_away_clean_sheet  numeric(6,5),

  market_count        int not null default 0,   -- how deep this capture was; 1 = HUB only
  markets             jsonb,                    -- every market verbatim, so a newly
                                                -- recognised one needs no re-fetch
  updated_at          timestamptz not null default now(),
  primary key (source, external_event_id, fetched_at)
);

create index if not exists mo_fixture_idx on market_odds (fixture_fpl_id, fetched_at desc);
create index if not exists mo_season_idx  on market_odds (season, event);

-- ---------------------------------------------------------------------------
-- fixture_market_odds — the latest price, one row per team per fixture
--
-- Sided the same way `fixture_odds` and `fixture_difficulty` are, so a consumer joins on
-- (team_code, event) without caring which source produced the number. `distinct on` takes the
-- most recent capture; the rest of the table is the drift history.
-- ---------------------------------------------------------------------------

drop view if exists fixture_market_odds cascade;
create view fixture_market_odds as
with latest as (
  select distinct on (source, fixture_fpl_id) *
    from market_odds
   where fixture_fpl_id is not null
   order by source, fixture_fpl_id, fetched_at desc
)
select season, event, fixture_fpl_id, source, fetched_at, kickoff, market_count,
       home_team_code                        as team_code,
       away_team_code                        as opponent_code,
       true                                  as is_home,
       p_home                                as p_win,
       p_draw,
       p_away                                as p_lose,
       p_home_scores                         as p_team_scores,
       p_home_scores_2plus                   as p_team_scores_2plus,
       p_home_clean_sheet                    as p_clean_sheet,
       p_btts, p_over_25
  from latest
union all
select season, event, fixture_fpl_id, source, fetched_at, kickoff, market_count,
       away_team_code, home_team_code, false,
       p_away, p_draw, p_home,
       p_away_scores, p_away_scores_2plus, p_away_clean_sheet,
       p_btts, p_over_25
  from latest;

-- ---------------------------------------------------------------------------
-- market_odds_check
--
-- Every boolean must be true. The `*_rows` counts beside them are not decoration: most of
-- these assertions are gated on markets that do not open until ~15h before kickoff, and
-- `bool_and` over zero rows is NULL, which reads as a pass in a table of booleans.
-- ---------------------------------------------------------------------------

drop view if exists market_odds_check cascade;
create view market_odds_check as
select
  (select count(*) from market_odds)                                  as rows,
  (select count(distinct external_event_id) from market_odds)         as events,
  (select count(distinct fetched_at) from market_odds)                as captures,
  (select max(market_count) from market_odds)                         as deepest_capture,

  -- 1X2: always present, so this one is not gated.
  (select count(*) from market_odds where p_home is not null)         as with_1x2_rows,
  (select coalesce(bool_and(abs(p_home + p_draw + p_away - 1) < 0.001), true)
     from market_odds where p_home is not null)                       as devig_sums_to_one,
  (select coalesce(bool_and(p_home between 0 and 1 and p_draw between 0 and 1
                        and p_away between 0 and 1), true)
     from market_odds where p_home is not null)                       as probs_in_range,
  (select coalesce(bool_and(odds_home > 1 and odds_draw > 1 and odds_away > 1), true)
     from market_odds where odds_home is not null)                    as odds_above_evens,

  -- Tail ordering: P(2+) can never exceed P(1+). The same assertion `captain_check` makes.
  (select count(*) from market_odds where p_home_scores_2plus is not null)
                                                                      as with_team_totals_rows,
  (select coalesce(bool_and(p_home_scores_2plus <= p_home_scores
                        and p_away_scores_2plus <= p_away_scores), true)
     from market_odds
    where p_home_scores_2plus is not null and p_home_scores is not null)
                                                                      as tail_ordered,
  (select coalesce(bool_and(p_over_35 <= p_over_25 and p_over_25 <= p_over_15), true)
     from market_odds where p_over_35 is not null and p_over_15 is not null)
                                                                      as goal_lines_ordered,

  -- The strongest check available, and genuinely independent: a clean sheet for the home side
  -- IS the away side failing to score, so the two markets must agree. They are priced
  -- separately by the bookmaker, so agreement is evidence the parse mapped both correctly —
  -- not a restatement of our own SQL. 3pp of slack absorbs each market's own rounding.
  (select count(*) from market_odds
    where p_home_clean_sheet is not null and p_away_scores is not null)
                                                                      as cs_cross_check_rows,
  (select coalesce(bool_and(abs(p_home_clean_sheet - (1 - p_away_scores)) < 0.03), true)
     from market_odds
    where p_home_clean_sheet is not null and p_away_scores is not null)
                                                                      as clean_sheet_agrees_with_scores,

  -- Identity. Unmatched events are expected (Norsk Tipping prices cups and friendlies too)
  -- and never fatal, but a run where nothing resolves means the resolver or the season broke.
  (select count(*) from market_odds where fixture_fpl_id is not null)  as fixture_matched_rows,
  (select count(*) from market_odds where fixture_fpl_id is null)      as fixture_unmatched_rows,
  (select coalesce(bool_and(home_team_code is not null
                        and away_team_code is not null), true)
     from market_odds where fixture_fpl_id is not null)                as matched_rows_have_codes,
  (select coalesce(bool_and(home_team_code <> away_team_code), true)
     from market_odds where home_team_code is not null
                        and away_team_code is not null)                as no_self_fixture,

  -- Drift is the reason this table is append-only. Once a price has moved once, this is > 1.
  (select coalesce(max(n), 0) from (
     select count(*) n from market_odds group by source, external_event_id) x)
                                                                      as max_captures_per_event,
  (select coalesce(bool_and(source = 'norsk-tipping'), true) from market_odds)
                                                                      as source_known,

  -- The sided view must not invent or lose rows: two per resolved fixture, one per side.
  (select count(*) from fixture_market_odds)                          as sided_rows,
  (select count(*) = 2 * (select count(distinct (source, fixture_fpl_id))
                            from market_odds where fixture_fpl_id is not null)
     from fixture_market_odds)                                        as sided_view_doubles_fixtures,
  (select coalesce(bool_and(is_home_count = 1), true) from (
     select fixture_fpl_id, count(*) filter (where is_home) is_home_count
       from fixture_market_odds group by fixture_fpl_id) x)           as one_home_side_per_fixture;
