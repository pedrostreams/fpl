---
name: prd
description: Plan or resume work on a PRD (product requirements doc) for a feature — rough plan-file driven, updated as work progresses. Use when starting a new feature with a written plan, or resuming an unfinished one.
---

# prd

Plan or resume work on a Product Requirements Document. One skill handles both **starting** a
new PRD and **resuming** an open one — on entry, ask which. The PRD is a _rough_ living plan,
refined as work proceeds; the Progress Log captures what actually happened so it's resumable
across sessions.

**Read the conventions first.** Before writing any code, read and internalize the project's
`CLAUDE.md` (repo root) + `AGENTS.md` + `.claude/rules/`. They are the source of truth and
override this skill; it never restates them (they drift). PRD files live under the project's
`.claude/local/prd/` (gitignored).

## Step 1 — Resume or new?

If `.claude/local/prd/` has files **not** ending in `-[done].md`, ask whether to resume one
or start new. If none, go straight to new.

## Step 2A — Resume

List unfinished PRDs (one → confirm; multiple → pick). Read it, show completed `[x]` /
pending `[ ]` plan items and the latest Progress Log entry, then go to Step 3.

## Step 2B — New PRD

1. **Path** — `.claude/local/prd/[NN]-[feature-slug].md` (highest 2-digit prefix + 1).
2. **Gather context briefly** — main goal, constraints, any reference code from another
   project. Keep it short (it's a rough plan, not a spec).
3. **Plan it** — launch the planner agent (Task tool, `model: opus`):

   ```
   Read and follow the instructions in <this skill dir>/prd-planner.md.
   Also read the project's CLAUDE.md, AGENTS.md, and .claude/rules/ for conventions.
   FEATURE: [parsed]   SOURCE_HINT: [parsed or N/A]   OUTPUT_FILE: [generated]
   CONTEXT: [user's answers]
   Create the PRD file. Return the FULL content as your response.
   ```

   Show the PRD, the file location, then offer: start / view / stop.

## Step 3 — Implementation loop

**Never execute an item automatically — confirm each.** For each iteration: read the PRD,
find the first `- [ ]` item, show a 2–3 sentence summary, `AskUserQuestion` (Work on it /
Show full / Skip / Stop). On working it: implement, mark `- [x]`, add a dated Progress Log
entry (what was done + decisions), append any new sub-items that emerged, offer to commit.
When all items are `[x]`, rename the file with a `-[done]` suffix.

## Pitfalls

Over-engineering the PRD up front (it's rough — details emerge) · treating it as immutable
(adjust the plan; the log captures why) · forgetting to mark `[x]` + log (that's what makes
it resumable) · bundling unrelated items in one branch/PR.
