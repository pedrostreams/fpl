# Design language

The contract for anything rendered in this app. Read it before adding a screen, and update
it in the same commit as any change to `app/globals.css`.

This is a **decision tool**, not a dashboard. The user is one person, on a laptop, deciding
a transfer before a deadline. Every rule below serves one goal: *make a number's meaning and
its trustworthiness readable at a glance*. Anything that competes with that loses.

---

## 1. Five principles

1. **A number without a reference point is decoration.** Raw `xGI/90 = 0.412` says nothing.
   The same number with a percentile behind it says "top 8% of midfielders". Every metric
   that can be ranked *is* ranked, and the rank is what carries the colour.

2. **Absent must never look like low.** A player with no data has not scored zero. 19% of the
   player pool is cold-start; if they read as "bad" the hidden-gems screen defeats itself.
   There are **three distinct kinds of absent** and each has its own glyph, because collapsing
   them loses the reason:

   | Glyph | Means | Where |
   |---|---|---|
   | `—` | No value exists | `fmt()` in [lib/format.ts](../../lib/format.ts) |
   | hatching | A value exists but is not ranked — sample too small | `.heat-null` |
   | `·` | Not observed for long enough yet | `/prices` 24h and 7d deltas |

   The third is the subtlest and the most dangerous to get wrong. A `0` in a 24-hour delta
   column says "this player is stable"; the truth may be "we have only been watching for an
   hour". The SQL enforces it — `has_24h_history` in `player_movement` — and `verify` fails the
   build if a delta ever appears without the history to support it.

3. **The screen states its own provenance.** Which season the numbers describe, whether
   the season has started, whether a sync job is stale, whether a club was promoted — all
   of it on the page, not in a doc. A silently stale data tool is worse than no tool.

4. **Explain the metric where it is used.** PPDA gets its "low means high press" sentence on
   the teams page; DEFCON gets its thresholds in a column tooltip. Never assume the reader
   remembers which direction is good.

5. **Composite scores show their workings.** `gem_score` is a mean of three percentiles, so
   the card renders all three as bars. A score you cannot decompose is a score you cannot
   argue with, and the whole point is to disagree with the friend group's consensus.

---

## 2. Tokens

Defined in [app/globals.css](../../app/globals.css). **Never hardcode a colour**, in CSS or
in a `style` prop. Every token has a dark and a light value; dark is the default.

| Token | Role |
|---|---|
| `--bg` | Page background |
| `--surface` | Cards, table body |
| `--surface-2` | Table headers, inset controls, inactive chips |
| `--border` | All borders (`* { border-color: var(--border) }`) |
| `--text` | Primary text |
| `--muted` | Secondary text, units, ranks |
| `--faint` | Labels, legends, disabled, `—` |
| `--accent` | Interaction, active sort, emphasis. **Green-teal, ~165°** |
| `--heat-lo` / `--heat-hi` | The two ends of the percentile ramp |
| `--pos-gkp` `--pos-def` `--pos-mid` `--pos-fwd` | Position identity |
| `--tip-bg` / `--tip-border` / `--tip-shadow` | Tooltip panel. Deliberately not `--surface`: it floats above cards that already use it, so it is lifted a step and given the one earned shadow in this language. In light mode it inverts and goes *darker* than the page, because above near-white a lighter panel has no edge to stand on — which is why its foreground tokens are pinned rather than inherited. |
| `--scrim` | Behind a modal — the search palette and the column picker. Carries its own alpha, because the two modes need different *weights* and not merely different hues: the 55%-black both call sites hardcoded is a barely-there dimming over an L 0.155 page and a blackout over a near-white one. |
| `--chart-mark` `--chart-gkp` `--chart-def` `--chart-mid` `--chart-fwd` | Data marks — **not** the same steps as the UI hues |
| `--ok` `--warn` `--danger` | Status only — availability, staleness, sign of a difference |

**Why charts get their own hues.** A data mark has a tighter lightness band than UI text or a
badge — L 0.48–0.67 in dark, 0.43–0.77 in light — and `--accent` sits at 0.74, so a dot drawn
in it fails the band check against the chart surface. The chart steps were snapped to the
nearest passing value and verified with the dataviz palette validator (lightness band, chroma
floor, contrast vs surface: PASS for all five, both modes). **Only one is ever on a chart at a
time** — red and green together fail colourblind separation at ΔE 2.5 under deuteranopia, and
mixing positions on one plot would contradict the within-position rule anyway.

Everything is **oklch**. The heatmap interpolates continuously across 0–1, and sRGB midtones
go muddy. `color-mix(in oklab, …)` is the only mixing function used; percentages in
`color-mix` are the idiom for tinting a surface with a semantic colour:

```css
background: color-mix(in oklab, var(--warn) 9%, var(--surface));
borderColor: color-mix(in oklab, var(--warn) 28%, var(--border));
```

**Dark is not the only mode.** Light overrides live in both a `prefers-color-scheme` block
and a `[data-theme='light']` block, so an explicit toggle can win over the OS. Both blocks are
now reachable from the UI — see §7, *Theme*. **Any token added to one must be added to all
three places**, or the manual override draws dark-mode values on a pale surface; that is why
the chart hues are duplicated rather than factored out.

### Colour budget

Accent, position and status are three separate systems and they must not blur. A rule of
thumb that has held so far: **one accent element per row, at most.** If a screen starts
looking festive, the failure is that something semantic was given a decorative colour.

---

## 3. Typography and numbers

- One font stack, system sans. No web fonts — nothing here justifies a network round-trip
  or a layout shift.
- `body` sets `font-variant-numeric: tabular-nums`. Non-negotiable: every column is scanned
  vertically and proportional digits make that impossible.
- `.num` (mono, 13px, `-0.01em`) wraps **every** number that sits in a column with others.
  Prose numbers inside a sentence do not need it.
- Sizes are explicit brackets, not Tailwind's scale, because the range in use is narrow:
  `text-xl` for a page title, `[14px]` card title, `[13px]` body and cells, `[12px]` dense
  secondary, `[11px]` labels and legends, `[10px]`/`[9px]` uppercase micro-labels and badges.
- Micro-labels are `uppercase` + `tracking-wider`/`tracking-widest` + `--faint`. That
  combination *is* the label style; do not invent a second one.

### Formatting rules

All display formatting goes through [lib/format.ts](../../lib/format.ts) so "what does a
missing value look like" is one decision. Decimal places carry meaning — 3 for per-90
expected stats (`0.412`), 2 for rates and money, 1 for percentages and counts-per-match, 0
for minutes and points. Widening a column's precision beyond its measurement error is a lie
about how much the number is known.

---

## 4. The heatmap

The one component with real rules.

```tsx
<div className="heat" style={{ ['--p' as string]: pct }}>
```

- Percentile arrives as a `--p` custom property in **0–1**, and `color-mix` does the blend in
  CSS. Nothing computes a colour in JS: switching theme swaps two variables with no re-render.
- **Colour always means better, never bigger.** On the fixed screens, `xGC/90` and `Owned` are
  inverted in SQL before they reach the component. On `/players` the user composes the columns,
  so there is no view to invert them in: `direction` in [lib/columns.ts](../../lib/columns.ts)
  carries it instead, and [lib/rank.ts](../../lib/rank.ts) reads it. **Every new catalogue entry
  must declare a direction**, and `'none'` is a real answer — price, PPDA and G−xG are shown
  unshaded because "better" is genuinely undefined for them, and colouring them would assert
  something false. Never leave the direction to the reader.
- `pct === null` → `.heat-null` hatching, value shown in `--faint`.
- Every heat cell explains itself on hover, and **naming the comparison set is the point**: a
  defender's xGI against forwards is meaningless, which is why player percentiles are within
  position. On `/players` that is the resolver in §7 — the metric's full name, the value, *"12th
  of 148 midfielders shown"*, which direction is better, and the reason the metric exists. On
  `/teams` it is `data-tip` with the percentile and the league as the set.
- `--heat-hi` stays mid-dark in dark mode so `--text` keeps contrast at the top of the ramp.
  If you change the ramp, check the darkest cell against the lightest text.
- A legend showing the 0→1 ramp plus the hatch appears wherever the heatmap does.

---

### The fixture ticker

A second established pattern, in [components/fixture-ticker.tsx](../../components/fixture-ticker.tsx):

- **A lens switches the meaning of the whole table, not a column.** Overall / Attack /
  Defence each re-colour every cell *and* swap the summary metric (xWins / xG / xCS). Adding
  three more columns per gameweek would be unreadable; the same grid re-interpreted is not.
  Reach for this whenever one dataset has several audiences.
- **`ARS` is home, `ars` is away.** The universal FPL ticker convention, and it saves a
  column. The `H`/`A` suffix stays as the unambiguous form.
- **A blank gameweek is `.heat-null` with the word "blank"** — the same "absent ≠ low" rule
  as an unranked player, and here absence is actively the worst outcome on the row, so it must
  not render as a pale easy fixture.
- **A double gameweek stacks two chips in one cell** and is called out in prose above the
  table, because it is the single most actionable thing on the screen.
- **Difficulty is inverted for colour** (`--p = 1 - difficulty`), because 0 means easiest and
  colour means better.
- **A rate and a total are different columns, never one column.** A gameweek spans Friday to
  Monday, so mid-gameweek some clubs have played it and others haven't, and their windows hold
  different numbers of fixtures. The per-fixture rate stays comparable; the sum silently
  rewards having more fixtures left. Both are shown, the fixture count `#` beside them, and a
  banner appears only while the windows actually differ. Generalise the rule: **when an
  aggregate's denominator varies between rows, put the denominator on screen.**

---

### The composed table

[components/players-view.tsx](../../components/players-view.tsx). A **view** picks columns, a
**filter** picks rows, and the user builds both.

- **The comparison set is whatever is on screen.** Ranks are computed over the *filtered* rows,
  so narrowing to forwards under £7.0 rescales the shading to those forwards. That is the
  question being asked, and the tooltip still names the set.
- **Ranked within position by default**, across the whole pool only where the metric is
  team-level or absolute (`scope: 'all'`). A centre-back's xGI against forwards is meaningless.
- **A zero must never stand in for an unknown.** `player_wide` coalesces headed xG to 0 only
  for players Understat actually observed; the 159 with no mapping stay null and hatch. The
  first draft coalesced everything and quietly told the reader that an unmapped player has no
  aerial threat. Same for the three promoted clubs' corner figures.
- **A preset that sorts by a rate must bound the sample**, or the default view leads with a
  two-minute cameo at 3.29 npxG/90.
- **Sorting nulls last needs `sortUndefined`, not a comparator.** TanStack inverts the
  comparator on a descending sort, so a comparator that pushes nulls down ascending pulls them
  to the top descending. Both directions must be checked, on every numeric column.

---

### Percentiles

A rate on its own is not information. `0.398 xGI/90` says nothing; *83rd percentile among 148
midfielders* is a scouting report. So every rate on a player profile carries its rank, and
[player_metric_percentile](../../supabase/migrations/0018_metric_percentiles.sql) is where they
come from.

- **Mid-rank, not `cume_dist`, not `percent_rank`.** Both of the obvious choices are wrong on
  ties, in opposite directions. `percent_rank` gives a tie group its first member's position —
  every full-time starter read "37th percentile" for minutes. `cume_dist` counts rows at or
  *below* — all 22 goalkeepers tied on 0.000 xG/90 read "96th percentile" for scoring.
  `(strictly worse + half of equal) / n` is honest either way. `lib/rank.ts` must match, or the
  shaded cell and the printed sentence describe the same number differently.
- **Name the pool, always.** Within position, excluding cold-start players, and the count is on
  screen. "Better than 88% of midfielders" is worthless if a third of that pool played twenty
  minutes.
- **Refuse to quote a percentile that cannot mean anything.** A pool under 12, or a metric that
  does not vary within the position — `saves` across midfielders is 148 zeros, and ranking them
  told every one of them they were first. `is_quotable` decides in SQL, so no component has to
  remember.
- **Do not rank what the position does not do.** Correct arithmetic on a meaningless metric is
  still meaningless: a goalkeeper's headed xG is honestly the median and never worth a cell.

---

### Charts

[components/scatter.tsx](../../components/scatter.tsx) is the only chart primitive. Anything
new goes through the `dataviz` skill's procedure — form, then colour, then **run the palette
validator**, then marks, then hover, then look at it — not by taste.

- **Better is always up and to the right.** An axis where a low number is the good outcome is
  reversed, and the axis label says so out loud. The same contract as the heatmap; without it
  the reader relearns which corner is good on every chart.
- **One series on a scatter.** It is an all-pairs form, so the categorical cap is three, and
  our four position hues exceed it. The app's own rule settles it anyway: a centre-back is
  never compared to a forward, so a scatter shows one position and says so when none is picked.
  One series means no legend.
- **Selective direct labels, never one per point.** The outliers by distance from the centroid,
  with greedy de-collision; everything else is on hover. Measured, not assumed — 15 of 17 clubs
  labelled with zero collisions.
- **The hit target is ~24px even when the mark is 10px.** An invisible `r=13` circle above every
  mark, focusable, Enter/Space activating. A tooltip is never the only route to a value: the
  table view is always present.
- **Absent is omitted, never plotted at zero.** A promoted club at the origin would sit in the
  "worst in the league" corner for having no data. Omit, and say how many and why.
- **Solid hairline gridlines.** Dashing is reserved for a genuine threshold — the mean lines —
  because that is what a dashed rule conventionally means.

## 5. Page skeleton

```
header (sticky, backdrop-blur, 88% bg)
main   max-w-[1800px] px-4 py-6
  └ flex flex-col gap-5
      1. title + one-sentence subtitle explaining the screen's metric choices
      2. provenance / caveat banners (preseason, promoted clubs, stale sync)
      3. controls
      4. the data
      5. legend and footnotes in [11px] --faint
```

- `max-w-[1800px]`: this is a wide-table tool and a 1280px column wastes a laptop screen.
- Radii: `rounded-xl` for containers and banners, `rounded-lg` for inputs and buttons,
  `rounded-full` for nav pills and bar tracks, `rounded` for badges.
- Gaps: `gap-5` between page sections, `gap-3`/`gap-4` inside a section, `gap-2` inline.
- **Banners are conditional, never decorative.** Each one exists because a specific piece of
  data is missing or misleading, and it disappears when the condition clears — the preseason
  banner goes when `season_started` flips. A banner that is always visible is documentation
  in the wrong place.

### Tables

`border-separate border-spacing-0` with `sticky top-0` headers on `--surface-2`; first column
`sticky left-0` when the table scrolls horizontally (mind the z-index ladder: body cell 10,
header 20, first header 30). Cells are `p-0` with padding on the inner element, so a heat
cell can fill its cell edge to edge. Headers are clickable for sort and show `▲`/`▼` at full
opacity, `▾` at 0.25 when unsorted. Wrap in `.scroll-thin`.

Sorting must put **nulls last in both directions** (`nullsLast` in
[components/scout-table.tsx](../../components/scout-table.tsx)) — TanStack's default
interleaves them and a blank row appearing "best" is a bug the user learns to ignore.

### Controls

Label above input, `Field` wraps both. 36px (`h-9`) control height throughout. Sliders show
their current value in the label (`Max price · £8.5`) because a bare thumb position is
unreadable. Active toggles use an accent tint with an accent border; active position filters
fill with the position colour and flip text to `--bg`.

Filtering is **client-side over the full row set**. `/scout` ships all 558 rows — 2.4 MB of
HTML, **109 KB compressed** (measured). Instant filtering beats a round-trip; don't
"optimise" this without measuring the compressed size.

---

## 6. Badges

Small, uppercase, meaning-dense. Established vocabulary:

| Badge | Style | Meaning |
|---|---|---|
| `P1` `F2` `C1` | accent tint, `[9px]` bold | Set-piece order — penalty, free-kick, corner |
| `new` | `--surface-2` on `--faint` | Cold start, no reliable sample |
| `promoted` | `--surface-2` on `--warn` | No prior Premier League season |
| status dot | 6px round, `--ok`/`--warn`/`--danger` | Availability; `title` carries the news text |

A badge always carries `data-tip`. Two-to-three characters of jargon are worth it for density,
but only if hovering explains them — and `title` is not how, see §7.

### Club crests

`resources.premierleague.com/premierleague25/badges/{code}.svg`, keyed on **`teams.code`** —
the stable code every FK in this schema uses, never the season-scoped `fpl_id`. Verified across
all 20 clubs; 11 is Everton.

SVG rather than the `badges/50|70|100/{code}.png` ladder: 41 KB of pure vector, no embedded
raster, so one file per club is sharp from a 14px table row to the 44px club-page header. Twenty
files, each cached after its first fetch. `object-fit: contain`, never `cover` — crests are not
square and cover shaves the points off a shield.

`TeamBadge` renders **nothing** for a null code. A player between clubs has no crest; a broken
image frame would be worse than an absent one.

### Player identity

**One component, `components/player-identity.tsx`.** There were five hand-rolled copies — the
dashboard, the captain panel, the players table's first cell, a search result, and the gems card
— differing in spacing, in whether the name was a link, and in whether a crest appeared at all.
A player is the app's main noun and should look like one thing.

Fixed inside the component so no call site can drift:

- **Identity is a link.** The name goes to `/player/[code]`, the club to `/team/[code]`, always.
  This is why the dashboard, gems and teams screens stopped being dead ends: the fix was not
  "add links to three pages" but "identity is a link wherever it appears".
- **`v OPP` / `@ OPP`** for the next fixture, and the word **blank** when the club has none.
  The `opponents` *column* encodes home and away as upper and lower case, which is right for a
  column with a header and help text, and invisible in a line of prose. The two conventions
  coexist deliberately.
- **`wrap={false}` in tables.** The identity line wraps by default, which suits a narrow panel.
  In a table it must not: row height would depend on name length and the rows would stop lining
  up.

Callers supply only the slots — `lead`, `sub`, `right`, `action`, `chips`. Panels differ in what
they measure, not in who they are measuring.

### The avatar crop

Player photos are **head-and-torso studio portraits**, not face shots, so `object-fit: cover`
into a circle keeps the centre of the frame — which is chest — and clips the forehead at the top
edge. That is the whole of "the photo looks like it's on top of the circle, not inside it".

`object-position: 50% 15%` with `transform: scale(1.6)` about the same point. Chosen by
rendering six players who differ in build and hair at five candidate crops and looking at the
sheet: 1.6× is the largest zoom where all six keep a whole head with margin, and 1.8× starts
shaving crowns. Expressed as cover-then-scale because `cover` normalises the aspect ratio first,
so one pair of numbers serves both sources.

Two sources, and **the path names lie about their dimensions**: `40x40` serves 80×80 at 13 KB,
`110x140` serves 220×280 at 97 KB, `250x250` is a 403. Size picks between them at 40px, because
558 rows × 97 KB is 55 MB of headshots to scroll a table.

---

## 7. Interaction

### Tooltips

**One host, `components/tooltip-host.tsx`, mounted once in the root layout.** A trigger is any
element with `data-tip`, which a *server* component can emit — so an explanation costs one
attribute and no client boundary. There are no per-trigger components: `/players` alone has
**8 445** tagged cells, and a `<Tooltip>` wrapper each would be 8 445 pieces of state.

**Never the native `title` attribute.** Three reasons, in order of how much they matter:

1. It does not appear on **keyboard focus** in any browser, so every explanation in the app was
   mouse-only — the `P1` badge, the "no shots" chip, why a cell is hatched instead of shaded.
2. It cannot be structured. Five facts about a fixture arrived as one `·`-joined run of prose,
   and a `
`-joined list of stale sync jobs rendered as one line or not at all depending on
   the browser.
3. Two tooltips on one element means the browser draws its own over ours, so the two cannot
   coexist. When you add `data-tip`, remove `title`.

   (`title` on an `<img>` is fine — that is alt-text territory. And `Panel`/`Section` take a
   `title` **prop** that never reaches the DOM; don't "fix" those.)

**Content: values lead, labels follow.** The value is the large high-contrast element and the
label above it is small and secondary — a legend answers "which series is this colour", a
tooltip answers "what is this number", and the reader already has the series. Order is
title → value → note → rows → why.

**Two ways to supply it, and scale picks which.**

| | Mechanism | Right when |
|---|---|---|
| Static | `data-tip`, `data-tip-value`, `data-tip-note`, `data-tip-rows` (via `tipRows()`), `data-tip-why` | A badge, a header, a chart cell. The only route to a *rich* tooltip from a server component. The ticker's 120 fixture cells cost a few KB of repetitive markup and no client code. |
| Resolved | `data-tip-src` on an ancestor + `registerTipSource()` | Thousands of triggers. `/players` cells carry a 14-byte `data-tip-c` and nothing else; the content is built on hover from data already in memory. Serialising it would be megabytes. |

**A metric tooltip states its comparison set.** "12th of 148 midfielders shown" — and *shown* is
load-bearing: ranks are computed over the filtered rows, so narrowing to forwards under £7.0
changes both the shading and the sentence. `describeRank()` shares its pooling code with
`rankColumn()` so the number in the sentence cannot disagree with the colour of the cell.
`scripts/probe/prove_rank_detail.mjs` asserts that.

**What it deliberately does not do:** touch (`title` never worked there either, and a long-press
gesture inside a horizontally scrolling table breaks scrolling), and focus on non-focusable
elements — a decorative `<span>` stays hover-only rather than 8 000 spans entering the tab
order. Both are survivable only because of the rule below.

**Tooltips enhance, they never gate.** Every number a tooltip shows is already on screen or in
the table. Nothing is reachable only by hovering.

### Theme

[components/theme-toggle.tsx](../../components/theme-toggle.tsx) in the header, `lib/theme.ts`
for the storage key and the pre-paint script. **Three states, not two** — `Auto` / `Light` /
`Dark`, which is what the CSS in §2 already described: `data-theme='system'` (or no attribute)
leaves the `prefers-color-scheme` query in charge, `'dark'` trips the `:not([data-theme='dark'])`
guard so `:root` wins, `'light'` wins on source order. A binary toggle would make "follow the OS"
unreachable after the first click and strand a block of working CSS.

Two rules, and both are about the first frame:

- **The stored choice is stamped by a blocking inline `<script>` in `<head>`.** No server can read
  `localStorage`, so the only alternative is painting the default theme and correcting it — a
  visible flash, and the loudest possible one because it is the whole viewport. ~200 bytes of
  blocking script is the honest price. It must `try`/`catch`: `localStorage` *throws* on access in
  Safari private mode, and an unhandled throw would leave every page stuck on the default.
- **The active segment is selected in CSS off `<html data-theme>`, never from React state.** The
  server does not know the choice, so state-driven styling either mismatches on hydration or lights
  up `Auto` for a frame before jumping — the same flash, reintroduced inside the control that exists
  to prevent it. React state in that component drives *only* `aria-pressed` and the resolved value
  in the `Auto` tooltip, i.e. the things CSS cannot say, and it is seeded with the value the server
  rendered so hydration has nothing to reconcile.

`Auto`'s tooltip names what it currently resolves to, and a `matchMedia` listener keeps that
honest when the OS flips mid-session — principle 3 applied to a control rather than to data. And
no icon: §8 has no icon set, and the sun/moon pair is exactly how a codebase acquires one.

**No transition on the theme swap.** §8's "no animation" holds, and cross-fading every surface on
the page is the most expensive possible exception to it. The switch is instant, which is also what
makes the CSS-variable approach free.

- **No client JS unless the interaction needs it.** Pages are server components; only
  `/scout`'s table is `'use client'`. A card grid that never sorts stays on the server.
- Hover states are `transition-colors` on background only. No transforms, no shadows.
- `revalidate = 300` per page. The sync writes hourly at most.
- No loading skeletons yet — server rendering against a pooled connection is fast enough
  that a skeleton would flash. Revisit if a query passes ~300 ms.

---

## 8. Deliberately absent

Each of these is a decision, not a gap:

- **No chart library.** Bars are divs, ramps are `color-mix`. A 200 KB charting dependency
  for eleven bars is not a trade worth making. Revisit only for a genuine time series —
  price history over a season is the first real candidate.
- **No icon set.** Text labels and 6px dots. Icons would need a legend anyway.
- **No component library.** `Field`, `Slider`, `Toggle`, `Heat`, `Bar` are ~15 lines each and
  local to where they're used. Promote to `components/` on the *second* use, not the first.
- **No animation.** Nothing here benefits from motion.
- **No auth.** All data is public; there is nothing to protect. Filter state lives in React and
  dies on reload — deliberate for now, see §9. **Theme is the one thing in `localStorage`**, and
  it earns the exception by being a property of the reader rather than of the question they are
  asking: a filter is part of what you are looking at right now, a theme is a fact about the room
  you are sitting in. Anything else wanting to persist should have to make that argument too.

---

## 9. Open questions for the design round

Recorded, not decided. Do not resolve these silently in a feature commit.

1. ~~**Theme toggle.**~~ **Settled 2026-07-29** — three-state `Auto`/`Light`/`Dark` in the
   header, stamped before first paint by an inline head script. Contract in §7, *Theme*. The
   part still unaudited is the *light* palette itself: it has now been looked at, but only on
   one display, and the heatmap's light ramp (`--heat-lo` near-white → `--heat-hi` at L 0.80)
   has a shorter usable range than the dark one. If light mode gets real use, that ramp is the
   first thing to re-measure.
2. **Density.** 13px rows are tight on a laptop and comfortable on a large monitor. A
   compact/comfortable switch, or pick one and commit?
3. **`/scout`'s 18 columns.** Column visibility presets ("attacking", "defensive",
   "value") versus one wide table you scroll.
4. **Shareable state.** Filters in the URL would let a mini-league argument be linked. Costs
   a `useSearchParams` and some care over history entries.
5. **Mobile.** Untested and almost certainly poor. The scout table cannot work under 600px
   without a different layout — probably cards. Is a phone even a target?
6. **The colour ramp's midpoint.** A single-hue ramp reads as "more/less". A diverging ramp
   through a neutral at the 50th percentile would read as "above/below average" — arguably
   the more useful question, and a real fork in the language.
7. **Landing page.** `app/page.tsx` currently exists only to redirect. A summary view — "what
   changed since you last looked" — is the obvious thing and the price-watch data is what
   would feed it.
8. **Visual review has not happened.** Every screen so far is verified by asserting on
   rendered HTML, never by looking at it. Treat spacing, weight and contrast as unaudited.
9. **The teams page now holds two tables.** The ticker and the style profile answer different
   questions ("who do they play" versus "how do they play") and are used together, which is why
   they share a route. If it feels crowded, splitting the ticker onto `/fixtures` is the
   obvious move — but then the two tables can no longer be read side by side.
10. **The ticker's blank and double paths are still unexercised.** No gameweek in GW1–6 has
    anything but exactly one fixture per club, because reschedules haven't happened yet. Both
    code paths are written and neither has rendered real data. The *mixed-window* path has
    been exercised, by briefly marking GW1's early fixtures finished against the live database
    and reverting — see the note in `CLAUDE.md` on how to repeat that.
