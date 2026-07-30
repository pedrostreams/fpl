# The weekly decision surface — what to show, in what order, and the fast/depth split

**Status: W1, W2, W4, W7, the status page and the new nav are BUILT** — migrations 0033–0037,
same day. W3 is deferred on a measurement, W5 is skipped, W6 is unstarted, and §5 (fast/depth) is
deliberately unbuilt until Peder has used the rest. Written and shipped 2026-07-30; §10 records
what building it changed about the plan.

This sits one layer above [`allaboutfpl-learnings.md`](allaboutfpl-learnings.md). That document
concluded that our deficit was *the order of the questions and a sentence about each*, and `/gw`
answered it. This one asks the next question: **which surfaces should exist at all, and how fast can
a decision be made on one.**

**Everything in W1, W4 and W7 is empty until 2026-08-21 17:30 UTC and that is the expected state.**
FPL publishes no squad — anyone's — before the GW1 deadline. The tables, jobs, views and pages all
ship reading "not published yet" and fill themselves at the deadline with no code change, the same
pattern the price screen already used. The go-live checks are §2.0 of
[`FIX_WHEN_LIVE.md`](../FIX_WHEN_LIVE.md), and **the first of them has a hard deadline**: the
recommendation log must be written inside a six-hour window before the first kickoff or GW1 is
lost from it permanently.

---

## 0. The finding, stated once

*§0 to §2 are the diagnosis as it stood on the morning of 2026-07-30, kept in the present tense
because the reasoning is only legible that way. What each one led to is marked at the end of the
section.*

**The data is ahead of the screens.** Two shipped views reach no screen at all, and the two
percentage columns most likely to change a decision are computed from the model while a market price
for the same quantity sits unread in a table three feet away.

**And the scatter is not a page count.** Six routes is not many. The feeling comes from three
specific things, and only the third is hard: two homes for the same week, pages named after data
rather than questions, and **no diff** — nothing in the app tells you what moved since you last
looked, so finding the three things that changed means sweeping all seven pages.

> **Resolved the same day.** `market_odds` now feeds the change feed (its *columns* still wait on
> W3); the duplicate panels are gone and the nav rule is in DESIGN.md; the diff is `/changed`.
> `rotation_pairs` stays unshown on purpose — see §1.

---

## 1. Computed and never shown

Verified 2026-07-30 by grepping every view name against `lib/`, `app/`, `components/` and the other
migrations.

| View | Migration | Reached by | Verdict | Now |
|---|---|---|---|---|
| `market_odds`, `fixture_market_odds` | 0023 | **nothing** | A gap. See below. | **Read by `change_feed`** (0036) as the `market` branch. The *columns* still wait on W3. |
| `rotation_pairs` | 0028 | **nothing** (check view only) | Correct today. Needs a trigger, not a panel. | Unchanged, deliberately. The trigger is written up in DESIGN.md §5 as a rule; the panel is still not built. |
| `player_midweek_load` | 0029 | `rotation_risk` only | Fine, but see §5.3. | Unchanged. |
| `squad_competition` | 0029 | `rotation_risk` only | Fine. | Unchanged. |
| `player_form_reliability` | 0027 | `player_form` only | Fine — it is a gate, not a display. | Unchanged. |
| `hidden_gems` | 0014 | `/gems` | — | Route retired; the composite moved to `player_wide.gem_score` (0033) and the view survives as the parity target for `gem_score_check`. |

**`market_odds` is the one that matters.** 0023 shipped ahead of everything else in F1–F8 precisely
because the source serves no history and an uncaptured gameweek is lost forever. That argument was
right and the capture is running. But `p_team_scores`, `p_team_scores_2plus` and `p_clean_sheet` in
`player_wide` come from 0025 and are **Elo-derived**, and §7.1 of the learnings doc set out the split
they were supposed to have:

> This gameweek → market. Team news priced in. Next 2–6 gameweeks → Elo. Label which is which on
> screen. `basis`, the same discipline as everywhere else.

That half is unbuilt, so we are banking a market price with the centre-back's suspension already in
it and showing the model instead. **This is the cheapest large gain on the list.**

**`rotation_pairs` is not the same kind of gap.** Its own header records the honest verdict: measured
2026-07-29 over GW1–6, the best defensive pair gains 0.204 expected clean sheets — **0.8 points
across six gameweeks, 0.14 a week** — because the window holds no blank and no double, so
`max(a, b)` is barely above the better of two similar numbers. Rotation earns its keep when the
calendar breaks. So the missing piece is a **condition**, not a screen: surface it when
`gameweek_shape` reports a blank or a double inside the window, and not otherwise.

That generalises into a rule worth adopting: **a panel that would mislead in the common case should
hide in the common case.** We already do the inverse (render `·` for the three kinds of absent);
this is the same honesty applied to a whole panel.

---

## 2. Why it feels scattered

**Cause 1 — two homes for the same week.** `CaptainPanel` is rendered by both
[`app/page.tsx`](../../app/page.tsx) and [`app/gw/page.tsx`](../../app/gw/page.tsx). So are the
watchlist and the target list. The nav comment states the intended split — the dashboard is the
state of the data, `/gw` is the decision — and it is a good split, but the dashboard is the route
that opens.

**Cause 2 — pages named after data, not questions.** `/gems` is a filter that became a route.
`/prices` is, in preseason and arguably after it, a coverage-and-health screen. `/teams` holds two
questions ("who do they play" and "how do they play"), which DESIGN §9.9 already flags.

**Cause 3 — no diff, and this is the real one.** `player_snapshots` is written **insert-on-change**:
every row in it is, by construction, a thing that moved. `market_odds` is **append-on-change**, same
property. `player_price_events` is a labelled event log. We have three change logs and no screen
reads any of them as one. Every question the app answers is answered in the present tense.

The fix for causes 1 and 2 is an hour of routing. The fix for cause 3 is §4 W2, and it is worth more
than any new metric.

> **All three resolved 2026-07-30.** Cause 1: the dashboard now links to the captain panel instead
> of rendering a second one, and the rule that prevents it recurring is DESIGN.md §5 rather than
> this document. Cause 2: `/gems` is retired, `/prices` left the nav, `/status` took the health
> content off the decision surface. Cause 3: `/changed`.
>
> **The estimate was wrong in an instructive direction.** "An hour of routing" was right for the
> routing and wrong about `/gems`, which turned out not to be a duplicate at all (§3) — the cheap
> half of the work was the part that needed a migration and a parity check.

---

## 3. Information architecture

**Three decisions, settled 2026-07-30.**

**`/gw` stays its own route.** Not folded into `/`. Peder has not decided whether the brief or the
dashboard should be the front door, and the answer is easier to see after one live gameweek than
before. Revisit after GW1. Until then the duplication in cause 1 is the thing to remove, not the
route: **the dashboard should link to the captain panel, not render a second copy of it.**

**`/gems` is removed — but the score is not the page.** `?view=differentials` is *not* an
equivalent. It is a row filter (`ownedMax: 10`, available, reliable, `minutesShareMin: 0.25`) plus a
column set, sorted on `points_per_90`. `hidden_gems` is a **five-component composite** (0014):
position-aware output, ownership scarcity, value, fixture rank and minutes rank, averaged. Deleting
the route without moving the composite deletes the composite.

Sequence, in this order, or the feature is silently lost — **done 2026-07-30 in migration 0033**:

1. ~~Promote `gem_score` into `player_wide`~~ **Done**, via a new `player_gem_score` view so the
   five-component average has one home. Registered in `lib/columns.ts` — but in a **new
   `Composite` group**, not `Price & ownership`: a composite is a different kind of thing from a
   measurement and the picker should not imply otherwise by filing it next to xG.
2. ~~Point the `differentials` preset's sort at it.~~ **Done.**
3. ~~Delete and redirect.~~ **Done**, as a `redirects()` entry in `next.config.ts` rather than a
   `page.tsx` calling `redirect()` — a route file would keep `/gems` in the `typedRoutes` union,
   so a stale `<Link>` would still compile. Removing the route is what turns each one into a
   build error, which is how the inbound links were found.
4. ~~Fix the inbound links.~~ **Done.**

**And the change made the column better than the view it came from.** `hidden_gems` filters to
under 10% ownership, but *scarcity is already one of the five components* — a heavily-owned player
scores low on that axis and keeps what he earns on the other four. So `gem_score` is defined for
every player in the eligible pool regardless of ownership: **42 players now carry a score the old
page could never have shown**. It is null outside the eligible pool, which is the eligibility gate
speaking rather than a low score, and `gem_score_check` asserts exactly that.

`gem_score_check` was written and run **before** the route was deleted, and reported
`agrees_with_hidden_gems = true` over 202 shared players with `lost_in_the_move = 0`.

Note while doing it: the two paragraphs of explanation on `/gems` — why minutes is a separate axis
from output, why the fixture axis is ranked across 20 clubs rather than across players — are the
kind of sentence §4 W5 is about. **Not yet done**: they currently survive only as the column's
`why` text, which is thinner than the original. Worth revisiting when W5 is picked up.

**Nav rule.** One page owns one question. A panel that answers another page's question **links
there; it does not render a second copy.** Cause 1 is what happens without this rule.

**Shipped shape.** The nav is `Dashboard · Gameweek · My team · League · Changed · Players · Teams`,
ordered as a week is lived, with `/status` reachable from a coloured dot in the header instead of a
nav slot.

| Route | Question | State |
|---|---|---|
| `/` | dashboard — state of the data | Built. Captain panel, manager record and coverage metrics removed — each now has exactly one owner elsewhere. |
| `/gw` | what do I do this week | Unchanged, and still its own route. |
| `/me` | what do I do with **my** fifteen | **New.** W1. |
| `/league` | who am I actually playing | **New.** W4 — this route was not in the original table; the mini-league needed its own home rather than a panel on `/me`. |
| `/changed` | what moved since last time | **New.** W2. |
| `/players` | who is good | Absorbed `/gems`. |
| `/teams` | who do they play, how do they play | Unchanged. Split only if it gets worse (DESIGN §9.9). |
| `/status` | is the data alive | **New**, and **out of the nav** — a precondition for trusting a decision is not itself a decision. |
| `/prices` | price and ownership movement | Kept as a route, dropped from the nav until prices unfreeze. Linked from `/changed` and `/status`. |
| `/scout` | — | **Still present and still legacy.** Not in the nav, superseded by `/players`. Left alone as out of scope; worth retiring the same way `/gems` was. |

The rule and the table are now also in [DESIGN.md](../../.claude/context/DESIGN.md) §5, because a
convention that lives only in a feature doc gets undone by the next feature commit.

---

## 4. Seven features, ordered

**The order changed while writing §5, and the reason is worth recording.** My first pass put the
change feed first and "my team" third. That is wrong: a change feed without a squad is a newspaper,
and with a squad it is a to-do list. Fast mode (§5) cannot compute "does this week need me" without
knowing what I own. **W1 comes first because W2 and everything in §5 depend on it.**

### W1 — My team · **BUILT** (0034, `/me`)

`entry/{id}/event/{n}/picks/` is **public from the GW1 deadline onward** — 404 before it, no
authentication after (LATER item 10, probed 2026-07-29 against entry 1617827). `managers` and
`manager_seasons` are already synced and `entry_picks_optional` already fetches picks. So this is a
page, not an integration.

What it turns on:

- ✅ The XI and the bench, each with fixture, `rotation_risk` and availability. The bench is held
  in **pick order**, because 12/13/14/15 is the order they come on and that is what decides who
  covers a blank — a page that re-sorts it destroys the only information the bench carries.
- ⏸ **Transfer as a delta** — not built. It needs a squad to subtract from, and there is none
  until the deadline. Deferred rather than guessed.
- ⏸ Captain restricted to the eleven I own — same gate.
- ⏸ Chip windows. `manager_chips` **is** captured now, though: it arrives inside the `history`
  payload the job already fetches, so storing it costs one table and no request, and not storing
  it would leave the planner's first question ("which chips do I still hold") unanswerable for
  every gameweek that passed before it was built.
- ✅ **`entry/{id}/transfers` is public too** — probed 2026-07-30 and it returns **200 with an
  empty list**, not a 404, so unlike picks it needed no gate at all. `manager_transfers` is live.

**Four tables, not two.** `manager_picks`, `manager_events` (the per-gameweek record from
`history.current`), `manager_transfers`, `manager_chips`, plus the `my_squad` view.

**One correction found while building.** `my_squad` has to join `managers`, because W4 writes
every *rival's* picks into `manager_picks` — same grain, same key, same element-resolution
problem, so a second table would have been duplication. Without the join, "my squad" silently
becomes "everyone's squads" and `my_squad_check` fails `fifteen_players` in a way that reads like
a broken ingest rather than a scoping bug.

### W2 — What changed · **BUILT** (0036, `/changed`)

The three change logs from §2, read as change logs. One feed, one line per event, newest first,
scoped to what I own and what I watch once W1 lands.

What it can already answer: price moved, ownership swung, a player was flagged (`status` and
`chance_of_playing_next_round` are both in `WATCHED`), the market re-priced a fixture.

Two things it cannot answer yet, both cheap — **both now fixed**:

- ~~**`news` is stored in `player_snapshots` but is not in `WATCHED`**~~ — added. **Measured
  first**, per the SYNC_PLAN §8 rule: over the 1 478 rows and 84.3 hours captured so far, news
  changed 9 times and **none of those was news-only** — every one arrived with a status change, so
  the row already existed and the cost today is zero. Honest in-season upper bound ~100 rows.
- ~~**Set-piece taker order is not captured at all.**~~ — three columns added to
  `player_snapshots` and to `WATCHED`. The baseline capture ran the same day: 129 rows inserted,
  and `set_piece_events` correctly stayed **0**, because the feed requires *both* sides of a
  change to be observed and refuses to read the start of watching as 558 changes.

**Four kinds, not three.** `price`, `availability`, `set_piece`, `market` — the market branch is
the cheap half of W3, landed here rather than waiting, since a market drifting toward a club
between Wednesday and Friday is team news being priced in before it reaches FPL's own `news`.

**It paid for itself on the first render**: nine real injury and transfer events from the previous
two days — Grealish 75%, Jaros, Kroupi Jr, two Ipswich players — none of which appeared anywhere
else in the app.

The read position is `localStorage`, per §8.3. The server renders every row regardless; the stored
timestamp only decides which ones get a dot, so the page is complete without JavaScript and the
marking is an enhancement rather than the content.

Both change rarely, which is exactly the case insert-on-change is good at — but **check the growth
query in `SYNC_PLAN.md` §8 before extending `WATCHED`**, per the standing rule.

Window: "since the last deadline" needs no stored state and is the right default. "Since you last
looked" needs a `localStorage` timestamp, and it can make the same argument theme made in DESIGN §8
— it is a property of the reader, not of the question. Decide it in the design round, not in a
feature commit.

### W3 — The market on screen · **DEFERRED** (its cheap half landed in W2)

**Scope call, 2026-07-30.** Peder asked whether there is anything here to implement yet. Mostly no,
and the split is worth stating precisely: **the valuable half is blocked on a measurement, and the
cheap half belongs to W2.**

- **Blocked.** The columns that would change a decision — `{Team} Totalt 0.5/1.5` and `holder
  nullen`, i.e. P(scores), P(scores twice), P(clean sheet) — need the deep 46-market set, and
  whether the Premier League gets it is unmeasured until the probe on 19–20 August. Building
  catalogue entries for columns that may never populate is building a screen full of em dashes.
- **Not blocked, and taken here.** What we hold today is HUB 1X2 for 9 of GW1's 10 fixtures, and it
  is enough for one thing: **market versus model on a fixture that has not been played.** That is a
  feed event ("the market moved toward Arsenal since Wednesday") and a validation line, both of
  which live in W2. No new catalogue entry, no new page.

So W3 is not a work item in this build. It becomes one the day the 19–20 August probe comes back,
and the rest of this section is the brief for that day.

Three notes for then:

- **The deep markets open ~15h before kickoff** and the Premier League's depth is still unmeasured
  (no PL fixture falls inside the window before 21 August). The probe on 19–20 August decides
  whether we get `{Team} Totalt 0.5/1.5` and `holder nullen` or only the HUB 1X2. Build the column
  plumbing so it degrades to Elo, and it works either way.
- **The drift is the part nobody else shows.** Append-on-change means we hold the movement, and a
  market moving toward a club between Wednesday and Friday *is* team news being priced in — often
  before it reaches FPL's `news` field. That is a signal, not a nicety, and it belongs in W2's feed.
- If team totals never appear for the PL, §7.1's least-squares inversion from 1X2 + O/U + BTTS gives
  them, **and the residual is the goodness check** — store it, do not discard it.

### W4 — Mini-league — league id **422500** · **BUILT** (0035, `/league`)

Given by Peder 2026-07-30 and **probed the same day**, which corrected two things.

`sync/jobs/manager.py`'s header says all five of Peder's leagues are `league_type = 's'` and that
"a friend-group mini-league is `league_type = 'x'` and there is not one yet — so mini-league
effective ownership is blocked on the league being *created*". True on 2026-07-26; **false now.**
Peder created it at 06:27 on 2026-07-30. Fix that comment in the same commit as the job change.

What `leagues-classic/422500/standings/` actually returns today:

| Field | Value | Consequence |
|---|---|---|
| `league.name` | Hakuna Mateta | |
| `league.league_type` | `x` | A real invitational league. |
| `league.admin_entry` | 1617827 | Peder. |
| `standings.results` | **empty** | Standings do not exist before GW1. |
| `new_entries.results` | **2 members** | 1617827 Joga Bonitos, 1771466 Claude fc (Stian Korsbøen). |

**The trap, and it would be easy to ship as "the league is empty":** before the season starts,
members are published under **`new_entries`**, not under `standings`. A sync that reads only
`standings` finds nothing and a page built on it reports an empty league that is not empty. Read
both, union them on `entry`, and let `standings` take over once it fills. Both are paginated
(`has_next`), so page through both even though 2 members fit on one page — the friend group will
grow before GW1.

Also probed: `entry/1617827/transfers/` → **200 with an empty list** (so it works now and needs no
gate), and `entry/1617827/event/1/picks/` → **404**, exactly as `manager.py` documents.

Effective ownership against the ten or twenty squads I am actually playing, not the global top-10k.
Then the thing worth more than EO: **with every rival's squad known and a per-player return
probability (W6), the week has a win probability** — "if Haaland hauls I finish 4th; if he blanks I
finish 2nd". Fantasy Football Fix structurally cannot do this; it does not know who I am playing.

Sequence it after W1 (same picks endpoint, same parsing) and after W6 for the probability half. EO
alone is useful before W6 lands.

**What shipped.** `leagues`, `league_entries`, `league_ownership`, `league_check`,
`sync/jobs/league.py`, and `/league`. The job walks both lists and both paginations, then fetches
every member's picks for the current gameweek — a loop that makes zero requests in preseason,
because `managers.current_event` is 0 and there is nothing to ask for.

The pagination concern was not theoretical: the league went from **2 members to 3 within an hour**
of first being read, and the third (Sander Moen, "Grünerball") arrived between the dry run and the
real one.

**Two numbers, not one, and the second has no ceiling.** `owned_pct` answers the *transfer*
question — bringing in a player six of eight already own gains nothing even if he hauls. `Σ
multiplier ÷ rivals` answers the *points-swing* question, where a benched owner counts zero and a
captain counts twice. **EO above 100% is correct and is not clamped**: eight rivals all captaining
the same player is 200%, and that is precisely the swing you are exposed to by not owning him.
`league_check` asserts the floor and deliberately asserts no ceiling.

The win-probability half still waits on W6, as planned.

### W5 — The sentence layer · **SKIPPED** by Peder, 2026-07-30

`docs/LATER.md` item 2, the oldest open wish in the file:

> More "analysis explanation". You should target Brentford now because their current trend is that
> they are not conceding shots.

**The machinery exists for clubs**: `style_phrase`, `team_style_claim`, `style_read`, `style_rank_noun`
(0021/0022) already turn a measurement plus a reliability into a sentence, with two gates deciding
what may be said. What is missing is the same treatment for **players** and for **the week**.

The rules are already written in [`trend-claims.md`](trend-claims.md) §6 and do not need
re-deriving. The one thing to hold onto: reliability governs the *ordering*, not whether a club can
be named — conflating those is what silenced the xGA axis once already.

### W6 — `P(anytime return)` · **NOT STARTED**

§7.2 stage 1, unchanged, and gated on beating the trivial baseline (a player's own season return
rate) on 2025/26's 9 991 player-matches with a Brier score and a reliability curve **before it
renders**. W3 makes it materially less speculative: the team term stops being modelled and becomes
`{Team} Totalt 0.5`, leaving minutes as the single weak factor, standing alone where it can be
labelled instead of buried in a product.

What it buys the *decision*: comparability across positions, and the honest compression of ninety
columns into one number. It is the input to W4's win probability and to fast mode's ranking.

Still no projected-points number. §7.2 argues that out fully and nothing here changes it.

### W7 — The recommendation log · **BUILT** (0037)

**Not in any existing document.** An append-only table — top-N of `captain_picks`, `target_players`
and `sell_candidates`, stamped per gameweek at deadline — joined afterwards to what actually
happened.

Three reasons it is worth more than it costs (one table, one insert per sync):

1. It is the only thing that tells me whether to trust my own tool. Every other honesty mechanism
   here is a *pre-ship* gate; this is the *post-hoc* one.
2. It makes calibration visible in the app's own currency, which is the standard §10 of the
   learnings doc holds everything else to.
3. With W1's `entry/{id}/transfers` it scores **me** as well as the app — what I was told, what I
   did, what happened. No paid tool will ever show you that, because the incentive runs the other
   way.

Caveat to build in from the start: a recommendation is only scoreable against the information
available *at the time*, so the row must be stamped at the deadline and never recomputed. A log that
re-derives its own history is a log that always looks right.

**What shipped, and the caveat became three mechanisms.** `recommendation_log`,
`recommendation_scored`, `recommendation_check`, `sync/jobs/recommendations.py`, and
`scripts/probe/prove_recommendation_log.py`.

- **A window.** The job refuses to write outside six hours before the deadline (and ten minutes
  after). Outside it the source views describe a *different gameweek*, so a late write would not
  be a stale recommendation, it would be the wrong one.
- **`insert_ignore`, never `upsert`.** The first capture in the window stands, and a second run
  cannot restate it as the views drift.
- **`basis` frozen at write time.** Whatever the source said about that player at that instant,
  so a row can be explained a month later without asking a view that has moved on.

**Four kinds, not three:** `captain_floor` and `captain_ceiling` are separate, because migration
0012 refuses to collapse the two axes into one ranking and storing a single captain ordering here
would have quietly undone that.

**The comparison is against a baseline, not against zero.** "Our top captain pick scored 8" means
nothing; "scored 8 against a median of 4 for the pool we chose from" means something, so the pool
median travels with every row.

**Peder's own decisions are not scored yet** — deliberately. `manager_transfers` gives them for
free, but building the join now would mean guessing the shape of a comparison against a table that
has never held a row.

---

## 5. Fast and depth · **NOT BUILT — deferred by Peder, 2026-07-30**

He wants to use the tool before deciding what "fast" should be, which is the right call: every
item in §4 is a prerequisite for this section anyway, and none of the reasoning below is wasted if
the answer changes. Kept in full as the brief for when it is picked up. The one thing already
recorded from it is the deadline-phase threshold in §8.4.

Peder's framing: the app should have a **fast** mode and a **depth** mode, where depth is much of
what exists. This section works out what that actually means, because the obvious implementation —
a toggle that hides columns — is the wrong one.

### 5.1 Fast is not fewer columns. It is fewer decisions.

Depth mode's job is to let you *contest* a number: ninety columns, scatter plots, shot maps, style
profiles, percentile shading. Fast mode's job is to hand you a **conclusion you can act on in
seconds**, with exactly enough reason attached that you can tell when to distrust it.

This is not a new philosophy for this codebase — it is the one already in it. `sell_candidates`
emits reason codes rather than a blended score *specifically so it can be argued with*. 0012 exposes
all seven rank components for the same reason. Fast mode is the conclusion; depth mode is the
evidence; **the deep link between them is the feature.** Every fast-mode line must land in depth
mode with the player, view and filter already selected — otherwise fast mode is just a smaller,
less honest app.

### 5.2 The most common correct output is "nothing needs you"

Most gameweeks, the right action is no action. An app that cannot say so forces you to re-derive
that conclusion yourself every week, which is precisely the cost Peder is describing.

So the fast surface leads with a **verdict**, not a feed:

> **Nothing needs you before Friday.** No flags in your fifteen, no price fall inside 24 hours, the
> captain default has not changed.

and when something does:

> **Two things before Friday 18:30.** Saka flagged 75%. Gabriel is 3 hours from a price fall.

A feed is still a list to read. A verdict is a thing to accept or reject. That difference is most of
the speed.

### 5.3 The week has phases, and the app already knows the clock

The deadline countdown is on the dashboard as a *number*. It should be a *driver*. The questions
arrive in a fixed order over the week and only one of them is live at any moment:

| Phase | Detected by | The one question | Lead panel |
|---|---|---|---|
| **Results** | last fixture `finished`, next deadline > 4 days | what happened | Your points, hauls, damage. W7's scoring. |
| **Planning** | midweek | who am I moving toward | Watchlist, fixture runs, W2 feed |
| **Team news** | deep markets open (~15h), press conferences Thu/Fri | who is actually playing | Flags, `rotation_risk`, market drift |
| **Deadline** | < 6h to `deadline_time` | final XI and armband | My eleven, captain, bench order |

Everything needed to detect the phase is already in `events.deadline_time`, `fixtures.kickoff_time`
and `next_gameweek`. The market phase is detectable *from the data itself* — when the 46-market set
appears for a PL fixture, the market has team news in it, and that is a better trigger than a
weekday.

**This is a better answer than a mode toggle**, because it needs no decision from the user at all.
The page is fast because it is already showing the question you came to ask.

### 5.4 Fast mode needs stricter gates than depth mode

Depth mode may show a measurement with an error bar — that is what an error bar is for. Fast mode
asserts, so **it may only show what has cleared a reliability gate.** Concretely: big chances
(`rel(6)` of 0.11/0.15/0.25 by position) can appear as a column in depth and must never carry a
sentence in fast. Box touches (0.55/0.71/0.54) can carry one.

And a metric that fails the gate is **absent from fast mode, not greyed out in it.** Greyed-out
content is content you still have to read past.

### 5.5 Build it as two surfaces, not one toggle

A global `mode` state means every component grows a branch, DESIGN grows a second language for every
rule in it, and the two modes drift. Instead:

- **Fast is a page** — `/now`, or `/gw` restructured, or `/` after GW1 settles it. It owns the
  verdict and the phase logic. It is allowed to be almost empty; that is a feature.
- **Depth is the pages that exist** — `/players`, `/teams`, the profiles. Unchanged.
- **The deep link is the contract.** URL state already encodes view and filters on `/players`, which
  is most of the work done.

One place a real toggle *does* earn itself: **density on `/players`** — 13px rows are tight on a
laptop and comfortable on a large monitor. That is DESIGN §9.2 and it is a genuine mode, because it
is a property of the reader rather than of the question. Same test theme passed.

### 5.6 The budget

What makes it fast is a constraint, so write the constraint down:

- **One screenful.** No scroll on a laptop. If it does not fit, it is not the fast surface.
- **Five items maximum.** More than five and the rest are counted, not listed: "+3 lesser".
- **One line each**: subject, verb, reason. The reason is a clause, not a panel.
- **Words over numbers** unless the number changes the action. "3 hours from a price fall" changes
  it; `0.64` does not — the same argument that made F4 percentages.
- **Nothing requiring a comparison to interpret.** A comparison is depth, by definition.

---

## 6. Deliberately not

- **A projected-points number.** §7.2 of the learnings doc argues this out; nothing here reopens it.
- **Predicted lineups.** Unchanged: a confidently wrong starting eleven is worse than none.
- **More columns.** Ninety against allaboutfpl's six was never the problem.
- **A global fast/depth toggle.** §5.5.
- **Notifications and email.** LATER item 11 — Peder said not now, and he will say when.
- **Scoring my rivals' decisions.** W4 reads public picks to compute EO. It should not grow into a
  page that grades the friend group; that is a different and worse product.

---

## 7. Verification

**What was planned, and what exists.** All five built check views are wired into
`python -m sync.cli verify` and report **0 false**. Four of them are all-NULL with row counts
beside them, which is this project's convention for "asserts nothing yet" rather than a pass —
they cannot assert anything until there is a squad, a standing and a scored gameweek.

| Planned | Built as | State 2026-07-30 |
|---|---|---|
| `market_basis_check` (W3) | — | Not built; W3 deferred. |
| `changed_check` (W2) | **`change_check`** | 11 columns, 0 false, **0 null** — it has real data. |
| Growth measurement before `WATCHED` grows | done, recorded in W2 and in 0036's header | 9 news changes / 84.3h, 0 news-only. |
| `squad_check` (W1) | **`my_squad_check`** | 10 columns, 0 false, 7 null. |
| `gem_score_check` (§3) | as planned | 8 columns, 0 false, **0 null**; ran before the route was deleted. |
| — | **`league_check`** (W4) | 10 columns, 0 false, 5 null. |
| `recommendation_log` immutability probe | **`recommendation_check`** + `prove_recommendation_log.py` | 8 columns, 0 false, 4 null; probe green. |

Two planned assertions were **dropped as unbuildable today** and are now in
[`FIX_WHEN_LIVE.md`](../FIX_WHEN_LIVE.md) §2.0 instead: "the fifteen sum to the squad value FPL
reports" needs a squad, and "a transfer delta never proposes a player already owned" needs the
delta, which is deferred.

One was **strengthened**. The plan said a probe should assert that re-running the writer changes
no row. The probe does that — but by **reading the row back**, not by trusting the return value,
because `insert_ignore` reports rows *attempted* rather than rows written and its count can never
prove immutability. Discovering that is what caught the bug below.
- W6 is gated on **beating the trivial baseline** with a Brier score and a reliability curve, per
  §7.2. Unchanged.
- Fast mode (§5.4): a probe asserting no sentence on the fast surface derives from a metric whose
  measured reliability is below the gate. This is `style_check`'s job in a new place.

---

## 8. Open questions — answered 2026-07-30

1. **Front door.** ~~`/gw` or `/`?~~ **`/` stays the front door**, `/gw` stays its own route.
2. **Fast mode's route.** ~~Own page or `/gw`?~~ **Deferred** — Peder wants to use the tool before
   deciding, so §5 ships as nothing for now. The phase clock in §5.3 is recorded, not built.
   Everything in §4 is a prerequisite for it anyway, and none of it is wasted if the answer changes.
3. **"Since you last looked."** **Yes — `localStorage`.** It earns the same exception theme did: a
   read-position is a property of the reader.

   Peder's counter-question, *"or should we implement auth and a simple login now?"*, deserves a
   direct answer: **no, and the reason is not cost.** A read-position needs a timestamp, not an
   identity — auth would be solving a different problem. But that different problem is real and
   this build makes it sharper, so it is written down here rather than discovered later:

   **The app is single-user by construction today, and nothing says so.** `watchlist` is keyed on
   `player_code` *alone* — the primary key has no owner — and `saved_views` has no owner column
   either. The moment the Vercel URL is shared with Hakuna Mateta, ten people share one watchlist
   and one set of saved views, and W1's `/me` shows Peder's squad to all of them. That is the
   trigger for auth: **sharing the URL, not the feed.** PLAN.md §1 deferred auth on the grounds that
   every figure displayed is public — true then, and W1/W4/W7 are the first features for which it
   stops being true.

   Decision: build W1–W7 single-user. Revisit auth when the URL is shared, as its own piece of work
   (Supabase Auth + RLS + an owner column on three tables), not folded into a feature commit.
4. **Phase thresholds.** **The deadline phase starts 2 hours before the first kickoff of the
   gameweek** — Peder's number, from knowing the game. Worth noting the arithmetic for whoever
   implements it: FPL's own deadline is 90 minutes before that kickoff, so this window opens 30
   minutes *before* the deadline and closes with it. Short, and deliberately so — it is the "final
   XI and armband" moment, not the planning one. `events.deadline_time` and `fixtures.kickoff_time`
   give both instants, so the phase can be derived either way and should be derived from the
   kickoff, as stated.
5. **How public W7 is.** **Fine to show**, contingent on the auth answer above — a hit rate is
   comfortable to publish while the only reader is the person it is about.
6. **Mobile.** Peder will raise it as its own task.

---

## 9. Relationship to the existing PRD

`.claude/local/prd/01-allaboutfpl-f1-f8.md` is complete except its last item (docs in the same
commit as the code they describe). This document became **`.claude/local/prd/02-weekly-decisions.md`**,
which holds the ordering, the checkboxes and the build log; all six of its items are `[x]`. This
document holds the reasoning. Neither restates the other.

---

## 10. What building it changed

Five things the plan did not anticipate. Recorded here rather than only in the PRD log, because
three of them are facts about the codebase rather than about this feature.

**1. The ordering flipped, and it flipped for a reason worth keeping.** The first draft put the
change feed first and "my team" third. Wrong: a change feed without a squad is a newspaper, and
with a squad it is a to-do list. W1 went first and everything else hung off it — including the
decision to put rivals' picks in `manager_picks` rather than a second table.

**2. `db.upsert` and `db.insert_ignore` call `conn.commit()` themselves.** So "simulate it inside a
transaction and roll back", the technique CLAUDE.md recommends for exercising a code path the
frozen data cannot reach, **does not work through those helpers**. The first draft of
`prove_recommendation_log.py` rolled back at the end and had already written 44 rows to the live
database. They were deleted, the probe now uses a sentinel season and an explicit `finally`, and
the finding is in CLAUDE.md because the technique is recommended there.

**3. Two bugs that would have fired at 17:30 on 21 August and nowhere else.** `target_players` has
no `score` column — it is `target_score` — and `basis` held raw `Decimal`s, which `json.dumps`
refuses. Both were found by *running the queries directly* and then by simulating the write,
neither by reading the code. That is the whole argument for exercising a deadline-gated path
before the deadline, and it is now the first item of §2.0 in `FIX_WHEN_LIVE.md`.

**4. The `new_entries` trap was real and would have shipped.** `standings.results` is `[]` before
the season and every member sits under `new_entries`. A job reading only `standings` reports an
empty league that is not empty — and it would have looked *plausible*, because a preseason league
with no table is exactly what you would expect to see. The league also grew from 2 members to 3
within the hour, which turned "walk both paginations" from caution into necessity.

**5. Retiring a page was more than deleting it.** `/gems` looked like a duplicate of
`?view=differentials` and was not: the preset is a filter and a sort, the page was a five-component
composite. Moving the composite first, proving parity with `gem_score_check`, and only then
deleting is what kept the retirement lossless — and it left the score *better* than it was, since
it is now defined for the 42 eligible players above 10% ownership that the old page excluded by
construction.

**Still open after this build**, in the order they will matter:

- **The market probe, 19–20 August.** It decides W3's scope and it is one curl.
- **The recommendation window, 21 August, 11:30–17:40 UTC.** Miss it and GW1 is gone from the log.
- **Transfer-as-delta on `/me`**, unblocked the moment picks publish.
- **W6**, which is what turns W4's effective ownership into a win probability.
- **Auth**, the day the URL is shared and not before (§8.3).
- **`/scout`**, still a legacy route, still not in the nav.
