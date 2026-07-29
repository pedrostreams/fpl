# Playing style, and the small trend layer that rides along

**Status:** built 2026-07-29 — migrations 0021 and 0022, `components/team-style.tsx`,
`scripts/probe/prove_style_claims.py`. Scope agreed the same day: style first, trend reduced to
what a window can actually detect.

Building it moved two more numbers and added a design rule that was missing. Both are recorded
below in place rather than appended, so §3 and §4 describe what shipped; §2 keeps the running log
of what was wrong.

`docs/LATER.md` item 2, in Peder's words:

> More "analysis explanation". You should target Brentford now because their current trend is that
> they are not conceding shots. They have started season well etc.

This document was first written as a trend engine. **The measurements killed most of it**, and
Peder's own counter-proposal — a richer style section on the club page — turned out to be the
better feature by a wide margin. What follows is the reasoning, including the two places where my
first answer was wrong, because a future reader needs to know which claims were re-derived.

---

## 1. Why a rolling window cannot carry this

Prose carries authority a shaded cell does not. "They have stopped conceding" reads as a
conclusion; `1.42` reads as a number the reader can weigh. So the first question was whether a
rolling window is signal at all.

**Test.** Per club, per metric, per window length: shuffle that club's own 38 matches 20 000–
40 000 times and take the mean of a random N. That distribution *is* what "no trend" looks like.
Two-sided p is how often a random window falls at least as far from the season mean as the actual
last N.

**Result.** 4 metrics × 17 clubs × 4 windows = 272 tests. **23 reached p < 0.05 — 8.5%**, where
noise gives 5.0% by construction. Requiring the effect at 2+ window lengths (adjacent windows
share most of their matches, so a real effect persists and a fluke does not) leaves **8 of 102
club-metric pairs, spread over 6 of 17 clubs**.

### Does it improve once the season starts? No — measured

The obvious hope: today's test asks whether the last 6 differ from the 38 that *contain* them,
which drags the two together. From September the question changes shape — this season's first N
against last season, an independent baseline.

Simulated by splitting 2025/26: each club's first N against the remaining 38−N, Welch's t.
**6 pairs over 5 clubs** hold at 2+ windows, against 8 pairs over 6 clubs for the current shape.
Not better. Marginally worse.

The reason is in §3: an independent baseline does nothing about the variance of the 6-match mean
itself, which is where the noise lives.

### What a 6-match window *can* detect

Everything that survived is a near-doubling:

| Club | Metric | First 6 | Rest of season |
|---|---|---|---|
| AVL | expected goals for | 0.86 | 1.59 |
| NEW | expected goals conceded | 0.77 | 1.65 |
| SUN | deep completions created | 3.17 | 6.03 |

**A window resolves changes of roughly ±50% and nothing subtler.** That is an information limit,
not an implementation weakness.

### Peder's own example, checked

Brentford ended 2025/26 conceding **more**: shots 16.7 against a 13.2 season average, xGA 2.10
against 1.56, deep completions conceded 10.0 against 7.3 — and against opposition 25 Elo
*stronger*. The example was illustrative rather than a claim about Brentford, but it is the
argument for having a layer like this at all: a plausible hunch, inverted by the data.

---

## 2. Two things I got wrong, and how they were caught

Recorded because the corrected numbers are the ones the design rests on.

**Wrong 1: "nine of seventeen clubs get nothing."** The 9 surviving pairs fall on only 6 distinct
clubs, so **11 of 17 get nothing**. Thinner than first stated.

**Wrong 2: "PPDA is not a stable club property, reliability 0.48."** This was a split-half
correlation across 17 clubs. The standard error of an r at n = 17 is about ±0.27, so 0.31 was not
distinguishable from 0.05 or from 0.6 — a noisy point estimate quoted as a fact. Peder pushed back
and asked how the assessment was made, which is what surfaced it.

The better estimator uses all 544 club-matches (§3). **PPDA's reliability is 0.77, not 0.48**, and
`/teams` needs no change. The two measurements do not actually conflict: the variance model
predicts a split-half r of ~0.62, and the observed 0.31 sits 1.1 standard errors below it.

A third hypothesis also failed: that PPDA *should* vary, because you do not press City the way you
press a promoted side. Regressing each match's deviation from its club mean on opponent Elo, own
Elo and venue explains **5.8%** of PPDA's within-club scatter (6–18% across the other metrics), and
adjusting for it moves reliability from 0.77 to 0.78. The variability is genuine match-to-match
variation, not response to circumstance.

**Wrong 3: "dead-ball share is the most actionable axis, split-half r 0.44 → reliability 0.62."**
Found while building §4, and it is the *same* underpowered estimator a third time — a split-half
correlation across 17 clubs, exactly what Wrong 2 was about. Measured properly the share is
**0.49**, the same class as xGA.

The share is a ratio of two correlated sums, so neither the split-half nor sd/√n is the right
estimator. A within-club bootstrap over each club's own matches gives the sampling variance
directly, and the decomposition on top of it gives 0.49. The same bootstrap on dead-ball xG *per
match* gives 0.56, agreeing with the per-match variance decomposition's 0.55 — two independent
estimators on the quantity that is a mean, which is what validated the bootstrap before it was
trusted on the ratio.

Normalising by total xG makes it worse, not better: the denominator contributes its own noise.

**Wrong 4: 544 club-matches was the right sample.** It was 646. The earlier figure came from
requiring an opponent Elo, and the join drops every match against the three relegated clubs
because they have no `teams.code` — 17 × 6 = 102, exactly the gap. The decomposition never needed
opponent strength. Shots conceded is now computed as (shots in the game) − (shots by this club),
which needs no opponent code at all.

The corrected sample moved every reliability slightly and moved one across a band boundary
(deep completions conceded, 0.77 → 0.74). The bands are computed, so the wording followed.

---

## 3. The measurement the design rests on

Variance decomposition over all 544 club-matches with opponent Elo. The observed spread of club
means contains within-club noise, so it is corrected before use:

```
var_between = var(club means) − var_within / matches_per_club
rel(k)      = var_between / (var_between + var_within / k)
```

For the one ratio — dead-ball share — `var_noise` comes from the delta method instead of
sd²/n, because sd/√n is meaningless for a ratio of correlated sums:

```
var(N/D) ≈ var(N)/D² + N² var(D)/D⁴ − 2 N cov(N,D)/D³      (N, D per-match means)
```

Agrees with a 6 000-draw within-club bootstrap to within 0.2–2.8% on all 17 clubs. **The
covariance term is not a refinement** — a club that attacks more has a bigger numerator *and*
denominator, and dropping it overstates the error by up to 60%, which would silence real outliers.
Feeding both kinds of figure through the same `var_noise` makes one formula serve both.

Measured over all **646** club-matches (see Wrong 4 above):

| Metric | between (sd) | within (sd) | **rel(38)** | rel(6) | Ranked? |
|---|---|---|---|---|---|
| Deep completions created | 1.46 | 3.72 | **0.85** | 0.48 | yes |
| Shots taken | 1.47 | 4.69 | 0.79 | 0.37 | yes |
| PPDA | 1.58 | 5.16 | 0.78 | 0.36 | yes |
| Expected goals for | 0.25 | 0.84 | 0.78 | 0.36 | yes |
| Shots conceded | 1.26 | 4.47 | 0.75 | 0.32 | yes |
| Deep completions conceded | 1.00 | 3.65 | 0.74 | 0.31 | yes |
| **Dead-ball share of npxG** | — | — | **0.49** | — | **no** |
| **Expected goals conceded** | 0.13 | 0.83 | **0.49** | 0.13 | **no** |

**`rel(6)` is this whole investigation in one column.** A six-match mean is about a third signal.
That is an entirely independent explanation of why the permutation test found nothing and why an
independent baseline does not help — and it is why a season figure works where a window does not.

**`rel(38)` is the design.** A club's season average is a real property for six of these seven
metrics. Expected goals conceded is the exception: over a *full season*, "this club concedes fewer
expected goals" is close to a coin flip. It is worth knowing that `/teams` shades xGA and that the
Defenders and Goalkeepers views rank on xGC — and that `fixture_difficulty` was built on Elo rather
than xGA, which this vindicates.

### Discrimination

Between-club spread against the standard error of one club's 38-match mean: ratios of **1.4 to
2.7**. So the league falls into roughly three to five distinguishable groups per axis, not twenty.
`deep_for` discriminates best at 2.7, `xga` worst at 1.4. Phrasing has to respect that: "Brighton
create more deep completions than anyone bar City" is defensible; "Brighton concede fewer expected
goals than Fulham" is not.

### Dead-ball share — the most actionable style axis

Share of non-penalty expected goals from corners, set pieces and direct free kicks. Penalties
excluded: a penalty is not a style, and the app already separates npxG.

Newcastle **33.5%**, Tottenham 32.2%, Arsenal 31.7% … Manchester City 17.8%, Liverpool **17.5%**.
A 16-point spread — and a reliability of **0.49**, not the 0.62 first claimed (Wrong 3).

So the league cannot be *ordered* on it. But five clubs sit more than two of their own standard
errors from the league mean, and that is a different question with a different answer. Which is
what forced the second gate in §4.

---

## 4. Design — style first

**A style section on `/team/[code]`, built on the full season, ordered by reliability, with the
strength of the evidence stated in words.**

Grouping follows §3 rather than convention: what a side *creates* is a firmer property than what it
*concedes*, so creation leads.

```
CREATE    ─ holds all season      rel 0.78–0.85   ranked
  deep completions created, shots taken, expected goals for
DEAD BALL ─ varies match to match rel 0.49        NOT ranked, but outliers named
  share of non-penalty xG
CONCEDE   ─ mixed                 rel 0.49–0.75   xGA alone is not ranked
  shots conceded, deep completions conceded, expected goals conceded
PRESS     ─ description, not virtue  rel 0.78     ranked from whichever end is nearer
  a low number is an aggressive press, not a good team — already the rule on /teams
```

### Two gates, which is what was missing

The first design had one test, and it silenced the most useful axis in the app. Reliability and
"can this club be named" are different questions:

1. **`rank_earned` — may the league be ORDERED?** Reliability compares real between-club spread
   against the noise in one club's figure, so it is a statement about the whole ordering. Below
   0.60 the middle of the table is arbitrary and `metric_rank` comes back **null**, so no call
   site can render a rank the data will not carry.

2. **`separated` — may THIS club be named?** |value − league mean| ≥ 2 × that club's *own*
   standard error. This works at any reliability, because it is a statement about one club.

Dead-ball share is the case that proves they differ: reliability 0.49, so no rank — and yet
Newcastle (+2.3), Tottenham (+2.0), Manchester United (−2.5), City (−2.4) and Liverpool (−2.7)
are all unambiguous. "Newcastle lean on set pieces, Liverpool do not" is true and useful, and gate
1 alone would have thrown it away. Arsenal's xGA sits **5.2** error bars below the league on a
metric that cannot order the league at all.

Seven club-metric pairs currently fall in that gap. They print *"varies, but clear of the league"*
rather than *"varies match to match"* — because printing the metric-level verdict alone made
Newcastle's page contradict its own headline, which is what the wording exists to prevent.

The comparison is against a mean of 17 club figures, which has its own error, so strictly
var(club − mean) ≈ 0.94 var(club). Using the club's error alone understates z by ~3%. That is the
conservative direction, so it is left alone.

**Print the reliability, in words.** This is the app's first principle applied to itself: a number
without a reference point is decoration, and a claim at rel 0.85 should not look like one at 0.49.
Rendered as *"holds all season"* / *"fairly consistent"* / *"varies match to match"*, never as a
correlation coefficient. `reliability_tier` ships alongside so the component can style the three
cases without containing any of the three strings — the wording stays a measurement.

**The FPL read.** One line per club tying style to position. Every position hint must follow from a
clause the reader can see: taking the two loudest claims for the sentence and then the strongest
hint from anywhere gave Tottenham *"creates little and rarely plays through the opponent box →
Defenders and target men"*, where the recommendation came from a third claim the sentence never
mentioned. `style_check` asserts the link now.

### The trend layer that survives

Reduced to what a window can detect and no more:

- **The ±50% class only**, at |z| ≥ 1.95 holding at 2+ window lengths — calibration in §5. Twelve
  club-metric pairs over 7 of 17 clubs, and the probe confirms the shipped view and the permutation
  test disagree on exactly one (SUN deep completions created), inside the 1-false-positive,
  1-false-negative tolerance the calibration measured.
- **Elo drift** over 30 and 90 days for a genuine *current* direction. The only signal that covers
  all 20 clubs, because the three promoted sides have no Understat season at all — and the only one
  honestly about now. Reported as **what it does to expected goals** rather than as Elo points, by
  running the drift through the goal-model coefficient `calibrate_elo_fixtures.py` already fitted:
  "notable" means ≥3% on expected goals, which is 25 Elo. In preseason the 30-day drift is exactly
  0.0 for all 20 clubs — ClubElo carries a rating forward when nobody plays — so nothing is notable,
  which is the correct output.
- **Opponent-strength control.** `club_elo` is a dated series, so opponent strength on the day is
  available, and it cuts both ways: Crystal Palace's collapse came against opposition **74 Elo
  stronger**, which strengthens the claim rather than explaining it away. Threshold ±40 Elo.

  Stated only on **complete** coverage. Opponent Elo is null for matches against the three
  relegated clubs — ClubElo rates them but reaching the rating needs a `teams.code` they do not
  have — and the missing opponents are precisely the weak ones, so an average over the 4 of 6
  matches that happen to be rated is biased strong. Worse than no average.

---

## 5. Calibration of the trend filter

The permutation test is the reference and cannot live in a view, so a cheap statistic was fitted to
it. The finite-population correction is not optional — sampling n of N matches happens *without*
replacement, and without it every z comes out too small:

```
fpc = sqrt((N − n) / (N − 1))
se  = stddev(season) / sqrt(n) × fpc
z   = (window_mean − season_mean) / se
```

**|z| ≥ 1.95 agrees with the permutation test on 406 of 408 cases** (one false positive, one false
negative). Essentially the normal critical value — but measured, not assumed: the mean of four
matches is not normally distributed, and the correction and the non-normality happen to cancel.

---

## 6. The honesty rules

In the code, not in this document:

1. **Never "now" about last-season data.** `basis = 'last_season'` renders as *"2025/26"*.
   "Currently" is reserved for `in_season` and for Elo drift.
2. **Always name the window and the comparison**, never a bare "improving".
3. **State the opposition control** when the gap exceeds ±40 Elo, in the direction that argues
   against the claim as readily as for it.
4. **A rank requires the reliability to support it** — but naming one club does not. Two gates,
   §4. xGA and dead-ball share are shown without a rank; the clubs that stand clear of the league
   on them are still named. Better to print a number with no rank than a rank the measurement
   cannot carry, and better to name an unambiguous outlier than to hide behind an average.
5. **Say nothing rather than something weak.** Eleven of seventeen clubs get no trend claim today.
   The empty state says so: *"No change large enough to separate from match-to-match variation."*
6. **Promoted clubs get Elo-only claims, labelled.** They have no Understat season, and an absent
   claim must not read as "no trend" when the truth is "no data" — DESIGN.md's three kinds of
   absent apply.
7. **PPDA stays description, never virtue.** Already the rule on `/teams`; the style section
   inherits it.

---

## 7. Where it renders

- **`/team/[code]`** — the style section, `components/team-style.tsx`. **Built.** The read, four
  groups, and the trend layer under "Current direction". The old three-rank grid it replaced said
  "Attack rank 2nd / Defence rank 1st / Press rank 2nd" with no indication that one of those three
  orderings was barely better than chance.
- **Tooltip host** — the workings on hover: season average, league average, rank, matches, the
  club's own error bar, distance from the league in error bars, and how well it holds up. **Built.**
  This is why the tooltip work landed first; a claim of this shape belongs in a panel with rows.

  One trap: `resolveTip` returns null without `data-tip`, so an element carrying only
  `data-tip-rows` renders **no tooltip at all**, silently. The first version of the component did
  exactly that. The blurb goes in `data-tip-why`, the italic slot that already existed for it.
- **`/teams`** — a marker on clubs with a live trend or a notable Elo drift. Not built.
- **Dashboard, "Teams to target"** — one line per club, the FPL read. Not built; `team_style_read`
  is one row per club and is what it would query.

---

## 8. Deliberately out of scope

- **Player-level trends.** `core_insights_player_match` supports it — 9 991 rows, 403 players, 38
  gameweeks, 0 unmapped, a 40-field `stats` jsonb — but the noise floor has not been measured there,
  and minute-limited samples are smaller than any club's. Run the same variance decomposition first.
- **A "worth watching" tier.** A second, weaker tier makes the reader separate the two at every
  glance.
- **Causal language.** "Because they changed formation" is in no table we hold.
- **Cross-season comparison.** Expected stats are zero before 2022/23 and squads turn over.

---

## 9. Verification

All built. `select * from style_check;` and `select * from trend_check;` — every boolean true.

- **`style_check`**, 35 columns. Both directions of gate 1 (an unearned rank is null *and* an
  earned one is present); the words are a function of the measurement; a 6-match figure never
  beats the season figure it is a subset of; no shading where there is no better end; the
  reconciling wording appears exactly where the two gates disagree; the dead-ball parts sum to the
  whole and the situations partition non-penalty xG; promoted clubs are absent rather than zero;
  and every position hint traces to a clause in the same sentence.
- **`trend_check`**, 27 columns. ≥2 windows held; no claim on a season sample under 20 matches;
  `direction` agrees with the sign of the delta **after** the metric's own direction is applied
  (conceding less is `improving` — the heatmap's "colour means better, never bigger" trap in a new
  place); the fpc is in (0, 1]; no `in_season` basis before GW1; the opposition gap is null on
  partial coverage; PPDA is described rather than judged, plus a guard that fires if a second
  direction-'none' metric joins the trend layer and needs that wording generalised.

  And it recovers the goal-model coefficient from `fixture_difficulty`'s own output by regressing
  ln(expected_goals_for) on elo_edge/400, because the Elo drift needed that fitted constant and
  migration 0008 already inlines it. Two copies of a fitted number is how they drift apart, so the
  duplicate is self-detecting: recovers 0.477616 against the stated 0.477618, the gap being the
  3-decimal rounding on the published column.
- **`scripts/probe/prove_style_claims.py`** — a second implementation, in Python, from the raw
  tables. Re-derives every reliability (matches to 3 decimals on all 8 metrics), checks the delta
  method against a bootstrap, recomputes both gates row by row, and re-runs the 20 000-shuffle
  permutation test against the shipped `team_trend`. **Needs `DATABASE_URL`** — the quantities are
  properties of 646 club-matches and cannot be asserted against a fixture, so unlike the three
  `prove_*` scripts that gate CI this one is run by hand, like `calibrate_elo_fixtures.py`.

  It also asserts the two gates genuinely disagree somewhere. If no metric is unranked-but-named,
  gate 2 is decoration and the probe says so.
- **An empty check is not a passing check.** `bool_and` over zero rows is NULL, which reads as a
  pass in a table of booleans. `zero_drift_is_flat` is exactly that today — no club has a 90-day
  drift of exactly 0.0 — so it ships beside `zero_drift_rows` and two assertions that always have
  all 20 rows.
- `FIX_WHEN_LIVE.md` gains: recompute §3 after GW6, GW12 and GW19 — `rel(k)` rises with k, so the
  set of metrics that earn a rank should grow through the season. If it does not, that is a finding.
