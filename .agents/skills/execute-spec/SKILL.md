---
name: execute-spec
description: Implement a ready spec against its requirements, one piece at a time. Triggers on natural-language requests to "implement", "build", "execute", "do spec X", "work on spec", and on the /execute-spec slash command. The model reads the spec, decomposes it into right-sized tasks persisted to a plan sidecar on disk (specs/plans/<slug>.md), implements incrementally while keeping every change tied to a requirement, and transitions the spec ready → in-progress → review. This skill does NOT verify acceptance or archive — that is verify-spec.
---

# execute-spec

Take a **ready** spec to **implemented**: a decomposed task list that
captures the HOW, code that meets each requirement, and the spec left at
`review` for verify-spec to gate on.

This skill is the *execution* leg of the loop
`brainstorm-spec → execute-spec → verify-spec`. It owns planning + coding.
It does **not** decide whether the spec is *done* — that's verify-spec's
job, on purpose, so the verdict comes from outside the context that wrote
the code.

## Invocation

`/execute-spec @path/to/spec.md` — usually a file in `specs/pending/`.
Accept a bare path or an `@`-mention. If no spec is given, ask which
ready spec to work on (list `specs/pending/`, filtered to Status
`ready` or `in-progress`).

## Step 0: Gate on status (read first)

This skill operates on specs that are ready to build. Before anything else:

- If the path is under `specs/done/` → **refuse**. Done specs are immutable
  history. Suggest a follow-up spec in `pending/` instead.
- If Status is `draft` → **stop**. It isn't ready to build. Point the user
  at `brainstorm-spec`.
- If Status is `review` → **stop, don't implement**. Implementation is
  complete and awaiting verify-spec. If work is actually still needed, the
  user should explicitly reset Status to `in-progress` first so the re-open
  is deliberate, not silent.
- `ready` and `in-progress` are fair game. `in-progress` means **resume** —
  read the plan sidecar at `specs/plans/<slug>.md` (the durable resume
  source) to recover the task list, requirement mapping, and what's
  already done; pick up where it left off rather than starting over. If
  the sidecar is missing, reconstruct the plan from the diff against the
  spec's creation, re-decompose explicitly, and write a new sidecar
  before continuing — don't silently re-scope.

## Workflow

### 1. Load the spec and its context

- Read the target spec in full. It is the source of truth for WHAT/WHY.
- Read `CLAUDE.md` (stack, conventions) and the relevant `docs/` entry
  **only if the spec touches** what that doc covers
  (`docs/architecture.md` for stack/data-model, `docs/data-sources.md` for
  any provider adapter). Don't read docs preemptively.
- Read any **cross-referenced specs** the target depends on (linked by
  slug). Fetch their actuals so you build against real behavior, not
  assumptions. If a dependency isn't `done` yet, flag it before starting —
  don't silently build around a gap.
- Skim the code you'll touch before writing: confirm the functions,
  columns, or services the spec names actually exist and behave as the
  spec assumes. If the spec says "reuse `PlaytimeService.getEstimate()`",
  go read it.

### 2. Plan: decompose into tasks (the plan lives on disk, not just in the session)

Implementation detail lives in the plan, not in the spec — and the plan
must **survive the session**, because solo on-the-fly work often pauses
mid-spec and resumes in a fresh session where the in-memory task list is
gone. So the plan is two things: a session task list (`TaskCreate`) for
in-flight tracking, and a **durable sidecar on disk** that is the resume
source of truth and verify-spec's coverage input.

- Create tasks with `TaskCreate`, one per right-sized unit of work, in
  build order. **Right-sized** means: maps to **1–3 requirements**,
  produces **one verifiable artifact** (a migration, a route, a test file,
  a UI section), and you can write **one sentence** describing how to
  verify it in isolation. A task mapping to >3 requirements → split it. A
  task mapping to zero requirements → scope creep, drop it.
- Map tasks back to spec requirements: note in each task's description
  *which requirement(s) it satisfies*. If a requirement has no task, you
  missed it.
- Set dependencies (`addBlocks` / `addBlockedBy`) where order matters
  (e.g. a schema migration before the route that reads it).
- Cover the non-obvious: schema/migration steps, the error/empty/loading
  states the spec calls out, and the authorization boundary it says to
  reuse.
- **Persist the plan to `specs/plans/<slug>.md`** (create the dir if
  needed). It is a checklist of tasks, each with its requirement mapping
  and the file(s) it touches, plus status as you complete them. This file
  is what a fresh session resumes from (Step 0) and what verify-spec uses
  to bound the diff and confirm coverage. Keep the spec itself WHAT/WHY-
  only — the sidecar is not the spec.

If the spec is small, the plan may be 3–5 tasks. Don't pad it. If it's
large enough that one plan feels unwieldy, say so and recommend a split
rather than building something bloated.

### 3. Mark the spec in-progress

Set the spec's **Status** to `in-progress` (edit the file). This is the
signal that execution has begun and verify-spec may resume it.

### 4. Implement, one task at a time

Work the task list in order:

- Mark a task `in_progress` when you start it, `completed` the moment it's
  truly done — not "I'll come back to it." Never mark `completed` on a
  guess.
- **Match the surrounding code.** Read the nearest existing equivalent
  before writing: naming, file placement, comment density, error-handling
  idiom, how it talks to the DB/Drizzle, how routes are structured. Your
  code should read like the repo wrote it.
- **Keep every change tied to a requirement.** If you're about to write
  something that satisfies no requirement and isn't a Non-Goal-adjacent
  necessity, stop — it's scope creep.
- **Verify incrementally**, not all at the end. After each task: run
  `npm run typecheck` (TypeScript's `tsc` is whole-project — there's no
  "area" to narrow), and run the unit tests for the file you touched
  (`npm run test:unit -- <path>`, or by name with `-t "..."`). Don't
  accumulate a pile of unverified edits. The full `npm test` run is
  Step 6.
- **Explore before assuming.** When you need to know how an existing
  service behaves or where a pattern lives, spawn an `Explore` subagent
  for read-only codebase lookup rather than guessing. Keep coding in the
  main thread.
- **Respect the Non-Goals.** They fence scope. "No aggregate statistics"
  means don't add them, even if easy.

### 5. Stay honest about the spec

The spec is not yours to rewrite during execution — `brainstorm-spec`
owns WHAT/WHY. If implementation reveals a real problem:

- A requirement is impossible or contradictory as written, or a Non-Goal
  turns out to be a real need → **stop and flag it**. Recommend running
  `brainstorm-spec` to amend (it resets Status to `draft` deliberately).
  Do **not** silently edit requirements to match what you built.
- A cross-spec dependency is missing or broken → flag it in your final
  report; don't paper over it.
- You discovered an edge case the spec doesn't cover → note it as an Open
  Question in your report. Do not invent a requirement to resolve it.
- When you flag a blocker, **report and stop** — do not loop, retry, or
  build speculative workarounds. Leave Status at `in-progress` and hand
  the decision back to the user.

### 6. Self-check (not the same as verify-spec)

Before handing off, do a basic mechanical self-check — this is *not* the
acceptance gate (that's verify-spec), just "I didn't leave the build
broken":

- `npm run typecheck` is clean (whole project) and `npm run build`
  succeeds.
- `npm run lint` is clean.
- `npm test` (the full offline **unit** suite) passes — not just the files
  you touched.
- No leftover debug code, `console.log`, commented-out blocks, or TODOs
  that satisfy no requirement.
- The plan sidecar at `specs/plans/<slug>.md` is up to date — every task
  status current, requirement mappings intact.

### 7. Set status to review and report

When implementation is complete and the self-check is green:

- Set the spec's **Status** to `review`.
- Leave `Completed:` blank — that's filled only on ship, by verify-spec.
  This skill does **not** archive and does **not** mark `done`.
- Report: the task list (what was built, mapped to requirements), what you
  verified incrementally, anything you flagged for `brainstorm-spec`
  (spec problems) or for `verify-spec` (edge cases to probe, scenarios
  you couldn't fully exercise). Recommend running `/verify-spec` next.

If implementation can't be completed (blocked dependency, spec
contradiction the user must resolve), leave Status at `in-progress` and
report the blocker clearly — do not declare `review` on incomplete work.

## Guardrails

- **Plan lives in the sidecar + task list, never in the spec.** The
  durable home is `specs/plans/<slug>.md`; the task list tracks in-flight
  work. Never write files, functions, or library choices into the spec —
  that altitude belongs in the plan, not the spec.
- **The spec is read-only during execution** except for the Status field.
  Anything else is `brainstorm-spec`'s job.
- **One piece at a time.** No "implement everything then check." Small,
  verified increments beat a big-bang handoff.
- **Honest handoff.** `review` means "I believe this meets the spec," not
  "it's done." The done-call belongs to verify-spec, outside this context,
  so it can't be captured by its own work.
- **Reuse over rebuild.** If the spec says reuse a service/adapter/boundary,
  reuse it. Don't fork logic to save a read.
