# Playing style, and the small trend layer that rides along

**Status:** designed and measured, not built. Scope agreed 2026-07-29: style first, trend reduced
to what a window can actually detect.

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

---

## 3. The measurement the design rests on

Variance decomposition over all 544 club-matches with opponent Elo. The observed spread of club
means contains within-club noise, so it is corrected before use:

```
var_between = var(club means) − var_within / matches_per_club
rel(k)      = var_between / (var_between + var_within / k)
```

| Metric | between (sd) | within (sd) | **rel(38)** | rel(6) |
|---|---|---|---|---|
| Deep completions created | 1.34 | 3.61 | **0.84** | 0.45 |
| PPDA | 1.53 | 5.19 | 0.77 | 0.34 |
| Shots taken | 1.30 | 4.41 | 0.77 | 0.34 |
| Deep completions conceded | 1.11 | 3.68 | 0.77 | 0.35 |
| Shots conceded | 1.25 | 4.42 | 0.75 | 0.32 |
| Expected goals for | 0.23 | 0.81 | 0.75 | 0.32 |
| **Expected goals conceded** | 0.13 | 0.83 | **0.49** | 0.13 |

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
A 16-point spread, sd 4.9, split-half r 0.44. This is the axis that answers "whose defenders are
worth owning", which is the FPL question a style section exists to answer.

---

## 4. Design — style first

**A style section on `/team/[code]`, built on the full season, ordered by reliability, with the
strength of the evidence stated in words.**

Grouping follows §3 rather than convention: what a side *creates* is a firmer property than what it
*concedes*, so creation leads and expected goals conceded is shown without a rank.

```
CREATE  ─ consistent all season          rel ≥ 0.75
  deep completions created, shots taken, expected goals for
DEAD BALL ─ fairly consistent            rel ≈ 0.62
  share of non-penalty xG, corner xG
CONCEDE ─ shown, not ranked              xGA rel 0.49
  expected goals conceded, and why it carries no rank
PRESS   ─ description, not virtue        PPDA rel 0.77
  already the rule on /teams; a low number is an aggressive press, not a good team
```

**Print the reliability, in words.** This is the app's first principle applied to itself: a number
without a reference point is decoration, and a claim at rel 0.84 should not look like one at 0.49.
Rendered as *"holds all season"* / *"fairly consistent"* / *"varies match to match"*, never as a
correlation coefficient.

**The FPL read.** One line per club tying style to position: dead-ball share and deep completions
conceded point at defenders, creation volume at midfielders and forwards. This is the sentence
Peder asked for, with 38 matches behind it instead of 6.

### The trend layer that survives

Reduced to what a window can detect and no more:

- **The ±50% class only.** `team_trend` keeps the |z| ≥ 1.95-at-2+-windows rule from the original
  design — calibration in §5 — which is exactly the filter that admits AVL, NEW and SUN and rejects
  the rest. Phrased as *"started the season differently"*, never as a subtle trend.
- **Elo drift** over 30 and 90 days for a genuine *current* direction. It is the only signal that
  covers all 20 clubs, because the three promoted sides have no Understat season at all — and the
  only one that is honestly about now rather than about last season.
- **Opponent-strength control.** `club_elo` is a dated series, so opponent strength on the day is
  available, and it cuts both ways: Crystal Palace's collapse came against opposition 62 Elo
  *stronger*, which strengthens the claim rather than explaining it away. Threshold ±40 Elo; the
  league spans roughly 500 points.

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
4. **A rank requires the reliability to support it.** xGA is shown without one. Better to print a
   number with no rank than a rank the measurement cannot carry.
5. **Say nothing rather than something weak.** Eleven of seventeen clubs get no trend claim today.
   The empty state says so: *"No change large enough to separate from match-to-match variation."*
6. **Promoted clubs get Elo-only claims, labelled.** They have no Understat season, and an absent
   claim must not read as "no trend" when the truth is "no data" — DESIGN.md's three kinds of
   absent apply.
7. **PPDA stays description, never virtue.** Already the rule on `/teams`; the style section
   inherits it.

---

## 7. Where it renders

- **`/team/[code]`** — the style section. The main deliverable.
- **`/teams`** — a marker on clubs with a live trend or a notable Elo drift.
- **Dashboard, "Teams to target"** — one line per club, the FPL read.
- **Tooltip host** — the workings on hover: window mean, season mean, z, windows held, opposition,
  reliability. This is why the tooltip work landed first; a claim of this shape belongs in a panel
  with rows, not in an attribute string.

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

- `style_check` asserts: every reliability figure on screen traces to a stored measurement rather
  than a literal; no metric carries a rank whose reliability is below 0.6; xGA carries no rank.
- `trend_check` asserts: ≥2 windows held per claim; no claim on a season sample under 20 matches;
  `direction` agrees with the sign of the delta **after** the metric's own direction is applied
  (conceding less is `improving`, creating less is `worsening` — the heatmap's "colour means better,
  never bigger" trap in a new place); no `in_season` basis before GW1.
- A probe re-runs the permutation test against the shipped view and fails if they disagree on which
  pairs survive. The calibration in §5 is a measurement taken once; the probe keeps it true.
- The variance decomposition is itself a probe, not a one-off: reliabilities move as matches
  accumulate, and a figure printed on screen must not be a stale constant from July.
- `FIX_WHEN_LIVE.md` gains: recompute §3 after GW6, GW12 and GW19 — `rel(k)` rises with k, so the
  set of metrics that earn a rank should grow through the season. If it does not, that is a finding.
