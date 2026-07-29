# What allaboutfpl.com actually publishes, and the eight features it argues for

**Status:** researched and gap-analysed, not built. Corpus read 2026-07-29: the 2025/26 season,
August 2025 through May 2026, plus the 2026/27 preseason run.

**Revised 2026-07-29 after Peder raised Norsk Tipping.** §7's conclusion that no new odds source
was needed is **wrong and is corrected in §7.1**, which records what the API actually serves. §7.2
answers "should we build a points-projection engine" — the short version is *build the calibrated
probability, not the point estimate*.

`docs/LATER.md` item 5, in Peder's words:

> Analyse this page: https://allaboutfpl.com to see if we can learn something.

**Part of this item has already shipped, and the doc has to start there.** Migration 0012
(`captain_v2`) was written from a *single* allaboutfpl captaincy article, and its header says so.
Reading the whole season confirms that method held from GW3 to GW35 without change, so 0012 is not
a lucky read of one post — it is their house method, correctly copied. What the full corpus adds is
everything the other eight weekly article types were doing while we were looking at the captaincy
one.

---

## 1. What was read, and what the site is

Monthly archives paginate at ten posts. Verified page counts: Aug 4, Sep 4, Oct 3, Dec 5, Mar 3,
Apr 3, May 4 — 26 pages over seven months. Extrapolating the four months I did not page through
puts the season at roughly **350–400 posts**. I read 20 in full, chosen to cover every recurring
type at three points in the season (GW3, GW19, GW31) plus the episodic chip and preseason pieces.

**The first finding is structural, and it reframes the rest.** allaboutfpl is not an analytics
site. It is a **weekly publication running a fixed template**, and the template is the product:

| Weekly article | The question it answers | Us, today |
|---|---|---|
| Ultimate Guide | hub — links the eight below in a fixed order | **nothing** |
| Transfer Tips: two to Buy, **Hold**, **Sell** | what do I change | buy only (`target_players`) |
| Captain Picks Based on Analysis & Metrics | who takes the armband | **`captain_picks`** ✔ |
| Differential Picks (<10% owned) | how do I gain rank | `differentials` preset ✔ |
| Scout Picks | an XI for the week | editorial — see §8 |
| Predicted Lineups, Injuries & Press Conferences | will he start | `chance_of_playing`, partially |
| Transfer Targets & Watchlist | who am I buying *next* | `watchlist_detail` ✔ |
| AK's Team Reveal & Transfer Plans | a worked example, multi-GW | needs "my team" |
| Fixtures & Players to Target | which fixture do I attack | `fixture_run`, `/teams` ✔ |

Episodic on top: **Wildcard Guide** (GW6, GW7, GW32, GW35 — whenever a swing or a chip window
opens), **Free Hit Guide** (GW34, the big blank), **Chip Strategy Guide** (twice, September and
January), **Upcoming Doubles & Blanks** (one page, maintained all season, last updated 28 April),
position deep-dives when a big name gets injured ("Best Saka Replacements", GW3), and a preseason
series: fixture analysis, team structures, rotational pairs, best £4.0m defenders, best premium
defenders, rules changes.

Then evergreen SEO — funny team names, most expensive players ever, FPL history, most points in a
gameweek — and a hard pivot to World Cup Fantasy through May 2026. Worth naming so nobody mistakes
their traffic volume for analytical depth.

**The second finding is the important one.** Their metric vocabulary is *tiny*. Across every
article the same six numbers do almost all the work:

> shots in the box · big chances · xG · xGI/90 · DEFCON · ownership

plus two fixture numbers (`% chance of 1+ goal`, `% chance of 2+ goals`), and two bought
projections (anytime-return %, projected points). `lib/columns.ts` registers **89** columns. They
win with six.

That is not a case for deleting columns. It is a case for what §9 concludes: our deficit is not
data, it is a **decided order of questions, answered weekly, in words**.

---

## 2. The Cumulative Rank Factor, reverse-engineered

Their captaincy method, which 0012 already implements. Worth pinning down exactly, because the
arithmetic is checkable and it tells us the aggregation shape.

Four rank tables, each over the same five candidates. GW31 verbatim:

| Player (last 6) | Shots in Box | Big Chances | xG |
|---|---|---|---|
| Igor Thiago | 15 | 8 | 4.30 |
| Gordon | 10 | 4 | 3.44 |
| Ekitike | 12 | 4 | 2.28 |
| Bruno Fernandes | 3 | 2 | 1.76 |
| Wilson | 7 | 1 | 0.90 |

| Team (last 6) | Shots in Box | Big Chances | xG |
|---|---|---|---|
| Liverpool | 70 | 17 | 11.35 |
| Newcastle | 53 | 12 | 10.27 |
| Brentford | 49 | 22 | 10.10 |
| Fulham | 62 | 12 | 9.47 |
| Manchester United | 54 | 16 | 8.36 |

| Fixture | Opponent | % 1+ Goal | % 2+ Goals |
|---|---|---|---|
| Newcastle | Sunderland (H) | 86% | 37% |
| Liverpool | Brighton (A) | 81% | 23% |
| Brentford | Leeds (A) | 81% | 22% |
| Manchester United | Bournemouth (A) | 78% | 19% |
| Fulham | Burnley (H) | 78% | 18% |

| Projection | Anytime Returns | Points |
|---|---|---|
| Bruno Fernandes | 53% | 5.8 |
| Harry Wilson | 51% | 5.9 |
| Gordon | 49% | 5.4 |
| Thiago | 49% | 5.1 |
| Ekitike | 48% | 5.1 |

Final: Gordon 8, Ekitike 11, Thiago 11, Bruno 14, Wilson 15. Lowest wins.

**The five CRF values sum to 59.** Four independent 1–5 rankings sum to 60, and competition-style
ranking of a two-way tie (1, 2, 2, 4, 5) costs exactly one point. So **CRF is the sum of four
category ranks**, with one category containing one tie. Not a weighted blend, not a z-score — four
ordinals added up.

The GW3 write-up names a fifth phase, **"Wisdom of the Crowd"** — their own captaincy poll — which
is absent from the GW31 tables. Treat it as optional. We have no audience and `selected_by_percent`
is the same signal with 11 million voters, so we skip it either way.

**Three things they omit and 0012 keeps:** ownership, penalty duty, and minutes security. Their own
article names those as gaps in its method.

**Two things they have and we do not:** the six-gameweek window (§4) and bought projections (§7).

---

## 3. Where our data is already better, and where it is worse

Stated plainly, because it decides what to build and what to ignore.

**Better:**

- **Fixture difficulty.** They use FPL Page's fixture ticker and, in the preseason rotational-pairs
  piece, a *three-tier bucket* of last season's table: top 6 / 7th–12th / promoted-and-13th–17th.
  `fixture_difficulty` is a continuous, venue-aware, market-calibrated Poisson model (Spearman 0.92
  against de-vigged odds, migration 0007). Their own headline fixture numbers — `% 1+ goal`,
  `% 2+ goals` — fall out of our λ in two expressions, which 0012 already does.
- **Chance quality.** `player_shot_profile` computes shots in the box from Understat's normalised
  pitch coordinates and big chances as xG ≥ 0.3, per player. Theirs comes from a third-party
  screenshot.
- **Set pieces and style.** Corner xG, dead-ball share, PPDA, deep completions, `team_style`. They
  discuss set pieces qualitatively.
- **Price history.** `player_snapshots` insert-on-change plus `player_price_events`. Their entire
  "FPL Player Prices" category is *three posts, all from 2022* — they outsource price tracking to
  livefpl. This is a genuine differentiator, not a gap.

**Worse:**

- **Recency.** Every number of theirs is a rolling last-4-to-6-game window. Ours is season totals.
- **Projections.** They buy anytime-return % and projected points. We have no projection at all.
- **Availability.** Their predicted-lineups article is hand-built from Wednesday/Thursday press
  conferences, updated after Friday's. We have FPL's `news` and `chance_of_playing`, which is the
  official line and lands late.
- **Season shape.** Blanks, doubles and chip windows dominate their second half. We have
  `fixture_count` and nothing built on it.

---

## 4. Recency — and a correction to FIX_WHEN_LIVE

`FIX_WHEN_LIVE.md` §6 says:

> Switch the captain model to a rolling six-gameweek window. `player_shot_profile` and
> `captain_picks` are whole-season today because `player_gw_stats` is empty.

**For the three metrics that carry their captaincy table, that is not true.** Shots in the box, big
chances and xG all come from `understat_shots`, which has `game_id`, `team_code` and **`kickoff` per
shot**, and holds all of 2025/26 today. A six-match window over those three is available *now*, in
preseason.

And it is exactly what they do at GW3: *"the metrics use the last six games of prior season data to
establish performance baselines during this early season period."* Their window crosses the season
boundary without comment. So the recency axis can ship before the GW1 deadline, labelled
`basis = 'last_6_2025_26'`.

What genuinely waits on `player_gw_stats` is the FPL side: per-match minutes, bonus, BPS and DEFCON.
That half of the checklist item stands.

**One implementation trap.** "Last six matches" must mean the player's last six *appearances*, not
his last six shot-bearing games — a striker who blanked twice would otherwise have a window
stretching back three months. `core_insights_player_match` has `event` and `minutes_played` for
9 991 player-matches across all 38 gameweeks, so it is the correct denominator; `understat_shots`
supplies the numerator, joined through `fixtures` on kickoff. **That join is the risk in this
feature** and needs a probe asserting every windowed player resolves the expected number of matches.

**And a caveat we have already measured.** `docs/feat/trend-claims.md` §3 decomposed variance over
544 club-matches: **`rel(6)` is 0.32–0.45 for team metrics**. A six-match team mean is about a third
signal. That is a direct verdict on their *Team Underlying Numbers (last 6)* table — mostly noise.

It does not invalidate their use of it, because a noisy ordinal is one of four inputs rather than a
claim about the club. But it does decide our design:

- **Player axis: last 6.** Small samples, but it is the player's own recent role and finishing, and
  it is what a manager is reacting to.
- **Team axis: season.** `rel(38)` is 0.75+ for xG-for and shots. Keep 0.75 signal over 0.32.
- **Recency for the team comes from Elo, not from a six-match xG mean.** `club_elo` is a dated
  series updated per match, forward-looking, and covers the promoted three that have no Understat
  season at all.

That last point is the one place we should knowingly diverge from them, and §6 of trend-claims.md
already holds the honesty rules for saying so on screen.

---

## 5. The correctness finding — BPS is not comparable across the season boundary

From their 2026/27 rules piece, and this is the most important single line in the whole exercise:

- **The −1 BPS for being tackled is gone.** Dribblers gain.
- **CBI is now 1 BPS per 3 actions, was 1 per 2.** Every defender's BPS falls.
- **Goalkeepers restructured:** 2 BPS per save including deflections, +1 inside the box, +1 for a
  big chance saved, outside-the-box save BPS removed, penalty save cut to 7 from 8.

`bps` and `bps_per_90` are live columns in `lib/columns.ts`, and they sit in the **Defenders** and
**Goalkeepers** presets — the two positions the changes hit hardest, both in the same direction.
So a defender ranked on 2025/26 BPS is ranked on a rule that no longer exists, and the error is
systematic rather than random.

This is the `player_season_totals` carry-over trap in a new place: the numbers describe a season
whose *scoring rules* differ from the one being played. Actions to take:

- `docs/DATA_SOURCES.md` gains a subsection on BPS rule changes by season, same discipline as §2.1.
- `FIX_WHEN_LIVE.md` gains: after ~GW5, refit nothing, but **compare observed BPS/90 by position
  against 2025/26** and confirm the direction and rough size of the shift. If defender BPS/90 has
  not fallen, one of the two premises is wrong.
- Until then the honest move is a tooltip on the BPS columns saying the basis is a superseded rule
  set. `data-tip`, never `title`.

**Second finding from the same article, and it bears on the price model.** After the GW1 deadline
FPL itself will publish, for every player, percentage progress toward a rise or drop *plus a
predicted progress* over 100% meaning it is expected to cross. `price_change_percent` is already in
the catalogue. If that field populates, a large part of the planned price model becomes redundant —
check it before building. That is a schedule change, not a scope change, and it is good news.

---

## 6. Eight features, ordered by value over cost

### F1 — Norsk Tipping odds ingest. First, because it expires.

Detail in §7.1. It is first not because it is the most valuable but because it is the only item on
this list with a **deadline**: the API serves no history, so every gameweek we do not capture is
gone permanently. Cheap — an extension of `sync/jobs/odds.py`, no key, no new client pattern — and
it feeds F4, unblocks continuous Elo validation, and halves the speculation in §7.2's Stage 1.

Build the ingest before 21 August. The **probe on 19–20 August** decides whether we get team totals
and `holder nullen` for the Premier League, which is what determines how much else follows.

### F2 — Rotational pairs. Zero new data, and strictly better than theirs.

Their preseason piece pairs two clubs with complementary schedules and alternates which defender
starts, scoring the result as *"0/7 games vs last season's top 6"*. The whole thing runs on a
three-tier bucket of last season's table.

We have `fixture_difficulty` per club per gameweek, continuous and venue-aware. So the pair score
is a sum:

```
score(i, j, N) = Σ over the next N gameweeks of max(easiness_i, easiness_j)
```

`easiness` is `p_clean_sheet` for a defensive pair and `1 − attack_difficulty` for an attacking one
— the split already exists precisely because an easy fixture for a striker is a different fixture.
Doubles and blanks fall out for free: a blanking club contributes nothing that week and a doubling
club contributes both fixtures.

New view `rotation_pairs`, restricted to players who are actually rotatable — `price ≤ 5.0`,
`minutes_share` high, `is_available`. A rotation between two £6.5m defenders is not a rotation, it
is two starters.

**Cheapest strong feature in the document.** One migration, one panel.

### F3 — `sell_candidates`, and the weekly brief

Their most repeated weekly format is **Buy, Hold, Sell**. We have buy (`target_players`) and hold
is a non-action. **We have no sell view at all**, and their sell reasons are every one of them
derivable from columns we already hold:

| Their sell reason, from GW19 | Our column |
|---|---|
| fixtures turning brutal | `fixture_run` next 6 against the last 6 |
| injury through a good run | `status`, `news`, `chance_of_playing` |
| clean sheets dried up | `team_clean_sheet_pct`, `xgc_per_90`, rolling |
| no attacking upside to compensate | `xgi_per_90` low *and* defensive metrics falling |
| price drop coming | `net_transfers_event`, `price_change_percent` |
| rotation risk | `pct_minutes_outside_league`, `start_rate` |

Build it as a view with an explicit **reason code**, not a blended score — the reason is the
product. A player can hold more than one, and two reasons is a stronger sell than one.

Then `/gw`: a single page walking their order — fixtures → buy/hold/sell → captain → differentials
→ watchlist. Almost no new SQL. `fixture_difficulty`, `captain_picks`, `target_players`,
`sell_candidates`, the `differentials` preset, `watchlist_detail` and `form_players` all exist and
are already on the dashboard as separate panels. What is missing is the **order** and the sentence
between the panels.

### F4 — Fixture odds as percentages, everywhere

They never print a difficulty. They print *"86% chance of 1+ goal"*, *"37% chance of 2+"*,
*"clean sheet odds"*. We compute all three inside `captain_picks` and then throw them away — the
rest of the app shows `fixture_difficulty` as `0.64`.

Promote `p_team_scores`, `p_team_scores_2plus` and `p_clean_sheet` into `player_wide` and
`lib/columns.ts` as `pct0` columns. Two lines of SQL, three catalogue entries, and it is the single
largest legibility gain available: a percentage carries its own reference point and `0.64` does not.

With F1 landed these become **two-source** columns — market for this gameweek, Elo beyond it — and
`basis` says which. That is the shape §7.1 argues for, and it is why F1 comes first: the same three
columns then carry the better number wherever the better number exists.

### F5 — Season shape: blanks, doubles, and a chip planner

Their entire second half. The January chip guide is a four-scenario decision tree keyed on chip
stock, and it moves more points than any transfer.

Two layers, and the second is gated:

1. **`gameweek_shape`** — per club per gameweek, fixture count, with blanks and doubles flagged and
   a league-wide summary. Buildable now from `fixtures`.

   **Be strict about what this can know.** FPL's fixture list shows what is *scheduled*. A blank
   caused by an FA Cup semi-final does not exist until the round is drawn and FPL removes the
   league fixture. allaboutfpl's own maintained page is explicitly provisional — *"the exact number
   of teams blanking will depend on the FA Cup results"* — and they update it by hand for months.
   So: **detect confirmed shape, and render provisional as unknown, not as normal.** DESIGN.md's
   three kinds of absent, in a new place. Cup-draw contingency is out of scope and should be said
   so on the page.

2. **Chip planner** — rank gameweeks for Bench Boost (expected points across all 15 with doubles
   counted twice), Triple Captain (best single ceiling × doubles), Free Hit (largest blank exposure).
   This needs to know my squad, so it is **gated on the first half of LATER item 10** — which needs
   no authentication at all from the GW1 deadline onward. Build `gameweek_shape` first; it is
   useful on its own.

### F6 — Enablers, and a claim of theirs worth testing

Their preseason is dominated by price points: best £4.0m defender, best premium defender, six rated
team structures. The criterion for a £4.0m defender is not output, it is **will he start** —
*"featured in all 44 games and started in 43"*.

- **An `enablers` preset**: `price ≤ 4.5`, sorted by `minutes_share` then `start_rate`, with
  `chance_of_playing` and `defcon_per_90` alongside. Two lines in `lib/columns.ts`, no migration.
  Answers a real recurring question the current presets cannot.
- **Test their central quantitative claim rather than repeating it.** They assert *"£5.0–5.5 DEFs
  are good value for money … can easily outscore Midfielders at the same price point or even
  higher"*, citing Milenković at £5.5m on 178 points, and attribute it to DEFCON. We hold all of
  2025/26 in `player_season_totals` where `source = 'history_past'` — the post-DEFCON season. So
  compute points-per-million by position × price bucket and put the **measured** answer on screen.
  If it holds it is the most actionable line in the app for squad building; if it does not, we have
  saved ourselves from repeating received wisdom. Either way it is a probe, not a guess.

### F7 — The rolling window (§4)

`player_shot_profile` gains a `last_6` variant now, from `understat_shots` + the appearance
denominator; `captain_picks.basis` moves from `'season'` to `'last_6_2025_26'`; the team axis stays
on the season with Elo drift carrying recency. Post-GW1 it extends to the FPL side.

### F8 — Rotation risk, built from what is derivable

Their predicted XI is out of scope (§7). The derivable part is not:

- `pct_minutes_outside_league` — European and cup load, already a column
- `start_rate` and per-match minutes once `player_gw_stats` fills
- **squad competition** — how many other available players at the same club and position have a
  comparable minutes share. This is new and cheap, and it is what "competition for the LB spot"
  means in their £4.0m article
- `chance_of_playing` and `news`, unchanged

Composed into one flag, this is most of what a predicted lineup tells you, without pretending to
have read a press conference.

---

## 7. New data — what is actually needed

Peder's instruction was not to treat data as a limitation. Having looked, the honest answer is that
**almost nothing new is required**, which is the more useful finding.

- ~~**Pre-match bookmaker odds — not needed.**~~ **Wrong, and worth recording why.** The reasoning
  was: `football-data.co.uk` is retrospective by construction (DATA_SOURCES §3.4), our λ is
  calibrated *to* that market at Spearman 0.92 and emits the same two percentages, so a new source
  buys only **team news priced in** and that is not worth a dependency. Every clause of that is
  true. The conclusion does not follow, because I generalised from the one odds source in the repo
  to "free forward-looking odds do not exist". They do — see **§7.1**. This is the same error shape
  as the LATER item 10 premise: a limit assumed from the tool at hand rather than checked.
- **Projections — build, do not buy.** The real gap. Anytime-return probability has a clean shape
  from what we hold:
  ```
  P(return) = 1 − exp( −(xG90 + xA90) × E[minutes]/90 × λ_fixture / λ_league )
  ```
  and it is **calibratable before shipping**: `core_insights_player_match` gives 9 991 player-matches
  of 2025/26, so a Brier score and a reliability curve are computable against actual returns.
  Sequence it after F7, because it needs the rolling window as its input, and **gate it on
  calibration** — an uncalibrated projected-points number is exactly the false authority
  trend-claims.md §1 warns about. Projected *points* is the harder half; anytime-return is the half
  worth doing first. **§7.2 develops this into a recommendation**, and the λ term above is the part
  that F1 replaces with a market price.
- **Predicted lineups — deliberately not.** Their GW9 article is press-conference transcription,
  updated Friday. Scraping a predicted-XI site adds a Tier 2 dependency whose failure mode is a
  confidently wrong starting eleven, which is worse than no starting eleven. Build F8 instead and
  say plainly that press-conference text is out of scope.
- **Opta "big chance" — low priority.** We proxy with xG ≥ 0.3, documented in 0012. Sofascore
  carries a real big-chance count among its 116 stats; worth checking coverage opportunistically,
  but the proxy is defensible and the label already says what it is.
- **`understat_shots` per-match team aggregates — free.** Shots in box and big chances *for and
  against* per club per match need no new source, just a group-by on a table we already hold. This
  is the input to their team table and to F2's opponent context.

---

## 7.1 Norsk Tipping (Oddsen) — probed 2026-07-29

Peder had this from `../vm26`. **There is no API key** — `vm26/docs/oddsen.md` and
`vm26/src/lib/ingest/odds.ts` show an unauthenticated public endpoint whose only header is
`Accept: application/json;charset=utf-8`. Nothing to store, nothing to leak.

```
GET /OddsenGameInfo/v1/api/events/FBL/{fromYYYYMMDDHHmm}/{toYYYYMMDDHHmm}   → events + mainMarket
GET /OddsenGameInfo/v1/api/markets/{eventId}                               → every OPEN market
        host: api.norsk-tipping.no
```

`events/{eventId}` and `livedata/{eventId}` return 204 for a non-live match; most other paths 403.
So `markets/{eventId}` is the one that matters and it is not in vm26's ingest, which only reads
`mainMarket` off the event list.

**Premier League is tournament `35887`** (Community Shield is `37442`). Two facts that make this
cheaper than vm26's version: club names arrive in **English** — `Brighton and Hove Albion`,
`Nottingham Forest`, `Manchester United` — so the Norwegian nation-name alias map is not needed,
only short-name normalisation against `teams.name`; and `startTime` is a real offset timestamp, so
the kickoff-tolerance match in vm26 carries over directly.

### What is actually served, measured

**GW1 is already priced.** All nine 21–23 August fixtures are posted, and Arsenal–Coventry's HUB
carried `betStart = 2026-06-21` — **two months** ahead. Peder's screenshot of their site shows the
same fixtures with `Begge lag scorer` and `Handikap 3-veis` rendered as **padlocks**: the market
template is defined per league, the prices open later, and the API returns only what is open. Two
channels, one answer.

**Market depth against lead time**, 40 events sampled:

| Lead time | Markets | Total-goals O/U | BTTS | Team totals | Clean sheet |
|---|---|---|---|---|---|
| ≤ ~15 h (deepest) | **46** | ✔ | ✔ | **✔** | **✔** |
| ≤ ~2 d | 4–8 | ✔ | mostly | ✘ | ✘ |
| ≥ 3 d | **1** (HUB) | ✘ | ✘ | ✘ | ✘ |

The 46-market set is the prize, because two of its markets are the exact numbers this whole document
has been circling:

- **`{Team} Totalt 0.5`** over → **P(team scores ≥ 1)**. allaboutfpl's `% 1+ Goal`, priced.
- **`{Team} Totalt 1.5`** over → **P(team scores ≥ 2)**. Their `% 2+ Goals`, priced.
- **`{Team} holder nullen`** → **P(clean sheet)**. Nobody's projection — a market price.
- Plus `Korrekt resultat`, a full scoreline distribution, from which everything else is exact.

`holder nullen` is the single most valuable field here. Clean sheets decide every goalkeeper and
defender — half the squad — and `fixture_difficulty` currently supplies `exp(−λ_against)` from a
two-parameter Elo model. A market price with the centre-back's suspension already in it is a
different quality of number.

### Three findings that constrain the design

**1. Depth is per-competition, and the Premier League is unmeasured.** Lead time does not explain
it: UEFA Conference and Champions League qualifiers 4–30 hours out carried **8** markets and no team
totals, while Brasil Serie A and CONMEBOL Sudamericana at 12–15 hours carried **46** and Argentine
Primera **22**. So depth tracks the competition's market template, not importance or imminence. **No
Premier League fixture falls inside the window before 21 August**, so whether the PL gets the
46-market set cannot be established today. A priori it should — the PL is Norsk Tipping's largest
football product — but that is an expectation, not a measurement. **`FIX_WHEN_LIVE.md` item: probe
tournament 35887 on 19–20 August and record the market list.** It is one curl and it decides how
much of this section survives.

**2. There is no history. At all.** Any window ending before today returns **204 No Content**;
December 2026 also 204; September 2026 has one event. This puts market odds in the same class as
`player_snapshots`: **not backfillable**. Start capturing at GW1 and we own a season of pre-match
prices; start in January and half the season is gone permanently. That is the argument for building
the ingest before the deadline rather than after it, and it is the same argument the snapshot job
already rests on.

**3. The horizon is roughly one gameweek.** GW2 is not posted. So this source cannot rate a fixture
six weeks out, which means it **does not replace `fixture_difficulty`** — it complements it, and the
split is clean:

- **This gameweek → market.** Team news priced in. Captain, differentials, the deadline decision.
- **Next 2–6 gameweeks → Elo.** The only thing that reaches that far, and it covers promoted clubs.
- Label which is which on screen. `basis`, the same discipline as everywhere else.

### If team totals do not appear for the PL, we can still derive them

With de-vigged 1X2 + total-goals O/U 1.5/2.5/3.5 + BTTS there are **six constraints on two
unknowns** (λ_home, λ_away). The two cleanest are closed-form under independence:

```
P(under 1.5) = e^−(λh+λa) · (1 + λh + λa)
P(BTTS)      = (1 − e^−λh)(1 − e^−λa)
```

The other four overdetermine the system, so a least-squares fit **yields a residual, and the
residual is the goodness check** — it measures how badly the independence assumption holds rather
than assuming it away. That is strictly better than what `fixture_odds` does today: migration 0004
inverts P(over 2.5) as `2.7 × (0.5 + p_over_25)`, honestly labelled there as "a cheap monotone
stand-in for the exact inverse". This replaces it with the real thing.

### Where it lands in the repo

Not a new source pattern — an extension of one that exists. `sync/jobs/odds.py` already de-vigs and
lands market probabilities; `match_odds` already has `p_home/p_draw/p_away/p_over_25`; `fixture_odds`
already sides the table and inverts a λ. What is needed:

- `match_odds` gains a **`source`** discriminator (`football-data` vs `norsk-tipping`), forward-looking
  columns (`fixture_fpl_id`, `p_team_scores`, `p_team_scores_2plus`, `p_clean_sheet`), and a
  `fetched_at` — because odds move, and a price captured at the deadline is a different fact from one
  captured three days earlier. **Append-only, keyed on `(fixture, source, fetched_at)`**, so the drift
  is preserved rather than upserted away. This is the one place to resist the `upsert` habit.
- The client uses `curl_cffi` like the rest of `sync/sources/`, and the job goes in
  `probe_sources.py` — a 204 outside the horizon is the **expected** state, exactly as
  `2627/E0.csv` 404ing in preseason is, and the probe must not read it as a failure.
- **A bonus that removes a blocked checklist item.** `FIX_WHEN_LIVE.md` currently defers validating
  the Elo model to "once `2627/E0.csv` exists (~GW10)", because football-data only publishes played
  matches. Norsk Tipping prices *unplayed* ones, so `p_win` can be compared against a live market
  from GW1 — ten fixtures a week, continuously, no waiting. A one-off calibration becomes a
  monitored one.
- We store **derived probabilities**, not betting links or prices as an invitation to bet. The app is
  a football-analysis tool for a friend group and should stay one.

---

## 7.2 Should we build an FPL points-projection engine?

Peder's question. My answer: **build the calibrated probability. Do not build a projected-points
number, at least not as a number.** The reasoning, and the conditions under which I would change my
mind.

### Why not projected points

1. **The dominant term is the one we model worst.** Points ≈ `P(starts) × P(60+ mins) ×
   (points | on pitch)`. The first two factors carry most of the variance and both depend on team
   news — press conferences, Thursday-night Europa League, a manager's rotation habit. §7 declines
   to scrape predicted lineups for good reasons, and `minutes_security` today is
   starts-per-appearance, which `cume_dist` pins at 1.000 for every full-time starter and therefore
   discriminates almost nothing (FIX_WHEN_LIVE says so already). A model whose largest term is its
   weakest term does not become trustworthy by being multiplied out to one decimal.
2. **It is maximally authoritative and minimally arguable.** `trend-claims.md` §1 opens with exactly
   this: *"Prose carries authority a shaded cell does not."* `5.8 projected points` is worse than
   prose, because it looks like a measurement. Migration 0012 deliberately exposes all seven of its
   rank components so *"the ranking can be argued with rather than trusted"*. A single projected
   total is the opposite move.
3. **It collapses the split 0012 was built to create.** Expected points is a **mean**. FPL is won in
   the tail. The actual question is *"do I want a floor or a ceiling this week"* — leading the
   mini-league versus chasing — and one expected value answers it for the user and hides that it did.
4. **The commercial ones disagree with each other.** FFH, FPL Review, Fix, DraftHound. Their
   disagreement is the evidence that the residual signal beyond fixture × minutes × underlying is
   small. We would be buying the appearance of precision, not precision.

### What to build instead, in order

**Stage 1 — `P(anytime return)`, and nothing else.** Defensible because it is *verifiable in the
app's own currency*: a probability has a Brier score and a reliability curve. "Of the players I put
at 40%, 39% returned" is checkable, and it is the standard §10 already holds everything else to. A
projected-points number has no equivalent test that a reader can see.

**And §7.1 makes this roughly half as speculative**, which is the real reason to sequence the odds
ingest first. Decompose:

```
P(he returns)  =  P(he plays enough)  ×  P(his team scores)  ×  P(it is him | they score)
                  └─ ours, weak ─┘        └─ MARKET ─┘          └─ ours, and stable ─┘
```

The middle term stops being modelled at all — it is `{Team} Totalt 0.5`. The third is his share of
the club's non-penalty xG and xA, which is a **ratio**, and ratios are the kind of thing
`trend-claims.md` §3's variance decomposition can put a reliability on before we ship it. That
leaves minutes as the single weak factor, standing alone where it can be labelled rather than buried
inside a product.

**Stage 2 — a distribution, only if Stage 1 calibrates.** If we ever want a points number, make it
`P(blank) / P(return) / P(haul ≥ 10)` rather than a mean. Then floor and ceiling read off the same
object, 0012's two axes survive, and it is **strictly better than what allaboutfpl buys** — their
`Anytime Returns` and `Points Projection` are two separate purchased numbers that we would be
deriving from one coherent distribution. Never render a single decimal without the distribution
beside it.

**Stage 3 — never: multi-gameweek projections.** Beyond this gameweek the fixture comes from Elo and
minutes six weeks out is unknowable. Multi-week projected points is where the paid tools are most
confidently wrong, and copying it would undo every honesty rule in `trend-claims.md` §6 at once.

### The calibration is available before anything ships

`core_insights_player_match` holds **9 991 player-matches** of 2025/26 with per-match xG, xA and
minutes. So Stage 1 can be scored — Brier, reliability curve, and a comparison against the trivial
baseline of "his season return rate" — *before* it reaches a screen. **Gate it on beating that
baseline.** If a fixture- and market-aware probability cannot beat a player's own season average,
that is a finding worth having and it costs one probe.

**One caveat on that data, from §5.** Returns are goals and assists, which the BPS changes do not
touch, so the 2025/26 labels are valid for Stage 1. A projection of *points* would inherit the
BPS problem — another reason Stage 2 waits.

---

## 8. Deliberately not copying

- **The captaincy poll** ("Wisdom of the Crowd", CRF phase 1). No audience, and
  `selected_by_percent` is the same signal with a vastly larger sample.
- **Scout Picks XI.** An eleven with no budget constraint and no knowledge of my squad is a
  magazine feature. Reconsider once "my team" lands; a *transfer* suggestion against a real squad is
  a different and much better product.
- **The unqualified eye test.** *"Juicy fixtures"*, *"squad confidence"*. trend-claims.md §6 already
  sets what we may assert and what reliability has to back it.
- **Evergreen SEO** — team names, FPL history, most expensive players ever, records. Large share of
  their output, zero analytical content.
- **World Cup Fantasy.** Their whole of May 2026. Different game, out of scope.
- **A single blended captain score.** They aggregate four ordinals and 0012 splits floor from
  ceiling, which is better than both — the question is *"do I want a floor or a ceiling this week"*
  and one number answers it for the user. Keep the split.

---

## 9. The lesson, stated once

On data we are ahead almost everywhere: a calibrated continuous fixture model against a three-tier
bucket, 89 registered metrics against six, our own shot-level chance quality against a screenshot,
a price-event history they do not attempt. The one axis where they were genuinely ahead — a market
price with team news in it — turns out to be free (§7.1), which removes the last of it.

Their advantage is that **every week, in a fixed order, someone answers the five questions a manager
actually has and writes a sentence about each.** Fixtures, then buy/hold/sell, then captain, then
differentials, then what is next. We have the answers computed and scattered across seven pages
with no order and no sentence.

So the ranking in §6 is deliberate. F1 is first purely because it **expires** — no history means an
uncaptured gameweek is lost, and that is a schedule constraint, not a value judgement. After that,
`/gw` and `sell_candidates` (F3) and percentage fixture odds (F4) are worth more than any new metric.
Rotational pairs (F2) ranks high only because it is nearly free. The projection engine is last, and
§7.2 argues it should arrive as a probability rather than as a number.

---

## 10. Verification

- `rotation_pairs_check` — every pair's score equals the recomputed `Σ max(easiness)`; no pair
  contains two players from the same club; a blanking club contributes 0 and a doubling club
  contributes both fixtures. This is the `fixture_run` incomparable-totals trap in a new place, so
  simulate a double and a blank rather than waiting for one.
- `sell_check` — every row carries at least one reason code; no row is both a sell candidate and a
  `target_players` row without the conflict being visible on screen; injury reasons agree with
  `player_availability`.
- `window_check` — for each player the last-6 window resolves to exactly six appearances from
  `core_insights_player_match`, and the shots joined from `understat_shots` fall inside those six
  fixtures' kickoff range. **This is the probe that matters**: the Understat-to-fixture join is where
  this feature breaks silently, and a wrong window is a wrong number with no error.
- `gameweek_shape_check` — blanks and doubles counted from `fixtures` reconcile against
  `fixture_count` in `player_wide`; a club with no scheduled fixture renders as unknown-or-blank and
  never as an easy fixture.
- `bps_basis_check` — every BPS column on screen carries a basis label, and it is not silently
  `2026/27` while the numbers are 2025/26.
- The F6 price-bucket claim is a **probe with an answer**, not a constant: recompute
  points-per-million by position × price bucket each time it renders, so it cannot go stale into a
  July number quoted in March.
- `odds_check` (F1) — de-vigged probabilities sum to 1 per market; `p_team_scores_2plus ≤
  p_team_scores`, the same tail-ordering assertion `captain_check` already makes; every priced event
  resolves to a `fixtures` row, and unmatched events are logged and **never fatal** (vm26's rule —
  odds are decision support, not scoring); a 204 outside the horizon is recorded as *expected*, not
  as an error, exactly as `2627/E0.csv` 404ing in preseason is.
- **λ-inversion residual is a stored number, not a discarded one** (§7.1). Six constraints on two
  unknowns means the fit can fail, and a bad fit must be visible rather than smoothed into a
  plausible-looking λ. Where team totals are priced directly, assert the inverted λ agrees with them.
- **Market against model** — `p_win` from `fixture_difficulty` against the Norsk Tipping HUB on
  *unplayed* fixtures, Spearman tracked weekly from GW1. This replaces a blocked FIX_WHEN_LIVE item
  rather than adding one.
- §7.2 Stage 1 is gated on **beating the trivial baseline** — a player's own season return rate —
  on 2025/26's 9 991 player-matches, with a Brier score and a reliability curve, before it renders.
- `FIX_WHEN_LIVE.md` gains: **probe tournament 35887 on 19–20 August** and record which markets open
  for the Premier League (§7.1 — this one decides the scope of F1 and F4); correct the §6
  rolling-window item (§4 above); confirm `price_change_percent` populates after the GW1 deadline
  (§5); compare defender and keeper BPS/90 against 2025/26 after ~GW5 (§5); check whether the first
  real FA Cup round makes provisional blanks detectable or confirms they are not (F5).
