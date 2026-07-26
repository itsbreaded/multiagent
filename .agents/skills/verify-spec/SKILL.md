---
name: verify-spec
description: Adversarially verify a spec's implementation against its requirements and acceptance scenarios, autonomously close mechanical/implementation gaps it finds, and archive on success. Triggers on natural-language requests to "verify", "check", "accept", "sign off", "did this meet the spec", "finish/close spec X", and on /verify-spec slash command. The model independently probes each requirement and Given/When/Then scenario, runs the test suite, typecheck, and build. When a gap is a mechanical/implementation issue (broken build, failing test, lint error, missing wiring, a requirement not actually hooked up end-to-end), it FIXES it directly and re-verifies rather than handing the work back. Only spec-level problems (a requirement that's impossible or contradictory, a user-facing or design decision with no clear answer in the spec) are escalated to the user. On full green, marks the spec done and moves it from specs/pending/ to specs/done/ with a Completed date.
---

# verify-spec

Decide whether a spec's implementation is actually **done** — by the
spec's own bar, not by how the code looks — and on success archive it.
This is the gate at the end of `brainstorm-spec → execute-spec →
verify-spec`.

The whole point of this skill is that the verdict comes from **outside**
the context that wrote the code. execute-spec believes its work meets
the spec; verify-spec has to *prove* it, adversarially, and is willing
to say no.

## The contract with the user

The expected workflow is: the user runs `/execute-spec` **once**, then
`/verify-spec` **once**, and is left with a complete, non-broken build
and an archived spec — with as little intervention as possible. This
skill is **autonomous by default**:

- **The verdict must be written to disk.** Deciding is not enough — this
  skill also performs the file edits that record the outcome (Step 5):
  flip `Status` to `done` + set `Completed` + move the file to
  `specs/done/` on a PASS, or flip `Status` to `in-progress` on a FAIL so
  the loop re-opens cleanly. A verdict left only in chat leaves the spec
  stuck at its prior Status and forces the user to hand-edit the file,
  which defeats the point of an agentic workflow. Do the bookkeeping
  yourself; do not hand it back to the user.
- **Mechanical/implementation gaps are fixed in this skill, not handed
  back.** A broken build, a failing test, a lint error, a missing
  import, a half-wired route, a requirement the code defines but never
  calls end-to-end — these are implementation gaps, not spec problems.
  Fix them directly and re-run the mechanical checks. Do **not** flip
  Status to `in-progress` and tell the user to re-run `/execute-spec`
  for a one-line import fix; that is exactly the manual round-trip this
  skill exists to eliminate. (Step 4.5 governs this loop.)
- **Only escalate to the user for spec-level or user-facing/design
  decisions.** A requirement that is impossible or self-contradictory,
  an ambiguity in the spec that has no determinable answer, a choice
  between two valid user-facing behaviors, a design decision with no
  clear modern-practice default — these are not yours to silently
  resolve. Use the `question` tool to ask, with the recommended option
  first. Technical/implementation details you resolve yourself as long
  as the choice is sound modern practice and doesn't over-engineer or
  paint the project into a corner.
- **Never escalate a fix you could make.** If a gap has an obvious,
  idiomatic, in-spec fix, make it. Escalation is for genuine ambiguity,
  not for "I'd like permission."

In short: the user hands you a spec that execute-spec believes is done.
You return either an archived, fully-green spec, or a precise escalation
question. You do not return "please re-run execute-spec for this one-line
fix."

## Invocation

`/verify-spec @path/to/spec.md` — usually a file in `specs/pending/`.
Accept a bare path or an `@`-mention. If no spec is given, ask which
implemented spec to verify (list `specs/pending/`, filtered to Status
`in-progress` or `review`).

## Step 0: Gate on independence and status (read first)

This skill operates on specs that have been implemented. Before anything:

**Independence (the whole point of this skill):**
- If you ran `/execute-spec` on this spec in the *current* session, you
  still hold the implementer's reasoning in working memory — independence
  is voided and this becomes a self-review. To keep the verdict honest,
  **delegate the verification matrix (Steps 2–4) to a subagent** (`Agent`
  tool — `Explore` for read-only probing, `general-purpose` to run
  commands) whose prompt contains only the spec path and the plan
  sidecar path, not execute-spec's reasoning. Or tell the user to re-run
  `/verify-spec` in a fresh session. Do **not** proceed same-session
  without one of these — a captured verifier is worse than no verifier.

**Status:**
- If the path is under `specs/done/` → **refuse**. It's already shipped
  history. (If something regressed, start a follow-up spec in `pending/`.)
- If Status is `draft` or `ready` → **stop**. Nothing has been built yet.
  Point the user at `execute-spec`.
- `in-progress` and `review` are fair game. `review` is the expected
  handoff from execute-spec; `in-progress` means verifying partial work,
  which is fine — you'll just likely find gaps and refuse to archive.

## Workflow

### 1. Load the spec and the implementation

- Read the target spec in full. The **Requirements**, **Scenarios**, and
  **Non-Goals** are your checklist; everything else is context.
- Read `docs/writing-specs.md` only if you need to re-ground on what
  "verifiable" means here.
- Identify the code that implements it. **Prefer the plan sidecar at
  `specs/plans/<slug>.md`** as the authoritative list of touched files and
  requirement mappings (execute-spec wrote it). If the sidecar is missing,
  fall back to `git diff` / `git log`, but then enumerate every file
  you're verifying and state why it belongs to *this* spec — multiple
  specs can touch overlapping files, and verifying the union is a false
  green. If you can't tell whether a change belongs to this spec or a
  sibling, do **not** verify it as part of this spec — flag it. Don't
  verify against a guess of what was built.

### 2. Build the verification matrix

For a verdict to mean anything, it has to be exhaustive against the spec.
Lay out, up front:

- Every numbered **Requirement** → how you will demonstrate it's met (a
  test, a manual check with concrete steps, a code path you trace). A
  requirement with no demonstration is a gap by default.
- Every **Given/When/Then scenario** → the test or check that exercises
  it. These double as test cases per the TEMPLATE; prefer an automated
  test as the evidence.
- Every **Non-Goal** → confirm it wasn't quietly implemented (scope creep
  in disguise).
- **Open Questions** → the section must read `None outstanding.` (per
  CLAUDE.md's Definition of Done). Any unresolved item is a refuse-to-
  archive gap, full stop — do not archive over an open question.
- **Cross-spec dependencies** (specs cited by slug) → for each, confirm
  the referenced spec is `done` **and** that the function/behavior/route
  it cites still matches the assumption recorded in this spec. A
  dependency that drifted since this spec was written = FAIL, with a
  pointer to the changed dependency.

If the count of items you plan to verify doesn't match the spec's
requirements + scenarios, you missed or invented one. Reconcile first.

### 3. Verify adversarially, one item at a time

For each item in the matrix, try to make it **fail** before accepting it:

- Run the relevant tests. Read them critically — a passing test that
  doesn't actually assert the requirement is worthless. If a scenario has
  no automated test, exercise it manually (run the app via the `run` skill
  if needed, or craft a targeted check) and record the concrete steps and
  result.
- Probe the edge cases the spec calls out explicitly: empty input, zero,
  fetch failure, auth boundary, large-N. The spec's Scenarios usually name
  these — they are not optional decoration.
- Trace the code path for each requirement to confirm it's actually wired
  up end to end, not half-built. "The function exists" is not "the route
  calls it."
- For each item, record a verdict: **PASS** (with the evidence — test name
  or steps), **FAIL** (with the concrete input/state that breaks it), or
  **UNVERIFIED** (you couldn't exercise it — treat as not-done).

### 4. Run the mechanical checks

Across the whole change, not just happy paths:

- `npm run typecheck` is clean and `npm run build` succeeds.
- `npm test` (the full offline **unit** suite) passes. This is the default
  and the bar — run it in full. The only acceptable narrower run is when
  the full suite is documented as impractical in `CLAUDE.md`/README (not
  merely "feels slow"), and even then you must name the exact files you
  ran **plus** at least one test per `Scenario` in the spec. Default to
  the full suite; in doubt, run it.
- `npm run test:integration` makes **real live API calls** and is opt-in
  (`RUN_INTEGRATION=1`). State explicitly whether you ran it; never imply
  integration coverage you didn't execute.
- `npm run lint` is clean.
- No leftover debug code, `console.log`, commented-out blocks, or TODOs
  that satisfy no requirement.

A broken build or failing test is an automatic **refuse to archive**,
regardless of how the requirements look — but see Step 4.5 before you
decide what to do about it.

### 4.5 Close mechanical/implementation gaps autonomously

This is the difference between a pure gate and an autonomous closer.
When Step 3 or Step 4 surfaces a gap, **classify** it before doing
anything else, because the classification decides who fixes it:

#### Fix it yourself (the default) — mechanical / implementation gaps

A gap is yours to fix when **all** of these hold:

- The spec is unambiguous about the intended behavior (the requirement or
  scenario says what the code should do; the code just doesn't do it, or
  doesn't do it end-to-end, or breaks a mechanical check while trying).
- The fix has a single obvious, idiomatic shape, or a small number of
  shapes all consistent with existing codebase conventions. No genuine
  design fork.
- The fix does not change any user-facing behavior beyond what the spec
  already specifies. No new UI states, no new wording, no new defaults
  the user would notice, no change to a scenario's observable outcome.

Examples that are **always** in this bucket:
- Build / typecheck / lint failures with an obvious cause (a bad import
  path, a missing module, an incompatible client-bundle pull, an
  `fs`/node-only module leaking into a client component).
- A failing test where the test is correct and the code is wrong.
- A function/route/component that exists but isn't actually called, or
  isn't wired end-to-end as the spec requires — "the function exists" is
  not "the route calls it."
- A missing test for a scenario the spec explicitly names, where the
  behavior is already implemented and the test is straightforward to add.
- Leftover debug code, `console.log`, commented-out blocks, TODOs that
  satisfy no requirement.

When fixing in this bucket:
1. Make the minimal change that satisfies the requirement / turns the
   check green. Match existing conventions; do not refactor beyond the
   fix.
2. Re-run the specific mechanical check you broke (typecheck / build /
   lint / the failing test) to confirm the fix worked.
3. Re-run the full `npm test` unit suite afterward — a fix that turns a
   red check green can mask another failure, so always re-run the full
   suite, not just the one test.
4. Loop back to Step 3 for any requirement whose verdict changes because
   of the fix (e.g. a previously-UNVERIFIED scenario that the fix now
   makes testable). Do **not** skip this — fixes can flip verdicts.
5. Cap the loop: if the **same** gap recurs after three fix attempts, or
   the "fix" keeps growing into a redesign, stop — that's a sign you've
   crossed into the escalate bucket. Flip Status to `in-progress` and
   report, rather than spiraling.

Do **not** flip Status to `in-progress` and hand the user back to
`/execute-spec` for a gap in this bucket. That is the manual round-trip
this skill exists to eliminate. Fix it, re-verify, and only then decide
archive vs. escalate.

#### Escalate to the user — spec-level / design / user-facing gaps

A gap is a genuine escalation when **any** of these hold:

- The spec itself is broken: a requirement is impossible to satisfy as
  written, two requirements contradict each other, or a scenario's
  Given/When/Then doesn't match any reasonable reading of the goal.
  → This is a `brainstorm-spec` amendment, not a fix you make silently.
- A gap that can only be closed by a **user-facing or design decision**
  the spec doesn't already answer: choosing between two valid UI
  behaviors, picking a default the user would actually notice, wording
  a new error message, deciding whether a feature should exist at all.
  → Use the `question` tool. Put the recommended option first (the one
  that matches the spec's existing spirit / modern practice), and offer
  the realistic alternatives. Do not offer a catch-all "Other" — the
  tool already adds a "Type your own answer" option.
- A technical choice where the options have materially different
  long-term consequences (e.g. "introduce a new dependency" vs. "hand-
  roll it", "add a DB column" vs. "denormalize") and the spec gives no
  guidance. → Also a `question`. Pick the least-surprising modern
  default as the recommended option; only ask if a reasonable engineer
  would disagree.

When escalating:
1. Use `question` with a tight, specific prompt. State the gap, the
   options, and why each is viable. One question at a time — don't
   bundle three unrelated escalations into one prompt.
2. After the user answers, apply the answer as a fix (it's now in the
   "fix it yourself" bucket) and continue the loop. Do **not** mark the
   spec `done` until the fix is in and re-verified.
3. If the answer reveals the spec itself needs to change, that's a
   `brainstorm-spec` amendment — flip Status to `in-progress`, report
   it, and stop. The user re-runs `/brainstorm-spec`.

#### The boundary, stated plainly

You are trusted to make any technical/implementation decision that a
reasonable modern engineer would make without asking, as long as it
doesn't over-engineer, paint the project into a corner, or change what
the user sees beyond what the spec already specifies. You are **not**
trusted to silently resolve a genuine design fork or contradict the
spec. When in doubt, the test is: *"Would a reasonable engineer reviewing
this PR be surprised by the choice, or argue it should have been
discussed?"* If yes, escalate. If no, fix it and move on.

### 5. Decide: done, or not — then make the edits

This step is not just "render a verdict." It is **the verdict plus the
file edits that record it.** A verdict that isn't written to disk is an
incomplete verification — the spec gets stuck at its prior Status and the
next skill in the loop can't pick it up cleanly. In an agentic workflow
the model does the bookkeeping, not the user, so perform the edits below
as part of deciding; do not hand the user a "you should now edit the
spec" instruction.

The **only** fields you may edit on the spec file are **`Status`** and
**`Completed`**, plus the file's location on archive (do **not** edit
requirements, scenarios, non-goals, or open questions to make them pass —
that is a `brainstorm-spec` amendment).

#### PASS branch — archive it

If every requirement and scenario is PASS **and** the mechanical checks
are green (after Step 4.5 has closed any fixable gaps), perform **all**
of these, in order, as real edits (not a list of suggestions):

1. Edit the spec file: change the `Status:` line to `done`.
2. Edit the spec file: fill in `Completed:` with today's date
   (YYYY-MM-DD).
3. Move the spec file from `specs/pending/` to `specs/done/` (keep its
   filename stable so the slug reference never breaks).
4. If a plan sidecar exists at `specs/plans/<slug>.md`, move it into
   `specs/done/` next to the spec (keep its filename stable) so the plan
   and spec stay together as history.
5. Report the verification matrix (each item → verdict + evidence),
   confirm Non-Goals were respected, and state plainly that the spec is
   done and archived. Note any edge cases you couldn't fully automate,
   for future test coverage. If Step 4.5 made fixes, summarize them
   briefly so the user knows what changed beyond execute-spec's work.

#### FAIL branch — escalate or hand back, then write Status

By the time you reach Step 5, you have already attempted to close gaps
autonomously in Step 4.5. A FAIL here means either (a) you hit the
3-attempt cap on a mechanical gap, (b) a genuine escalation question is
unanswered, or (c) the spec itself is broken. Act accordingly:

1. Do **not** mark `done`. Do **not** archive. Do **not** move the file.
2. **Edit the spec file: change the `Status:` line to `in-progress`** —
   never `review`. `review` is reserved exclusively for "execute-spec
   believes it's done." On a failed verify, `in-progress` is the state
   both downstream skills accept (`execute-spec` resumes from it;
   `brainstorm-spec` will re-amend from it), so the loop re-opens
   cleanly without a manual edit. **Leaving it at `review` would stall:
   `execute-spec` refuses `review`, and re-running verify-spec would
   just re-fail the same way.** This edit is mandatory — a verdict of
   "not done" without flipping the Status leaves the spec stuck at
   `review` and forces the user to hand-edit the file, which defeats the
   purpose of an agentic loop.
3. If you hit the 3-attempt cap on a mechanical gap, report what you
   tried and where it keeps breaking, with a pointer to the file/line.
   This is still an implementation gap — the user re-runs `/execute-spec`
   on it.
4. If you escalated via `question` and the answer revealed the spec
   itself needs to change, report it as a `brainstorm-spec` amendment;
   the user re-runs `/brainstorm-spec`. Otherwise (the answer just needs
   a fix you haven't applied yet), you shouldn't be in the FAIL branch
   — go back to Step 4.5 and apply the answer.
5. If the spec itself is broken (a requirement is impossible/
   contradictory), report it as a `brainstorm-spec` amendment; the user
   re-runs `/brainstorm-spec`. Do **not** attempt to fix a broken spec
   by editing its meaning.
6. Do **not** soften a FAIL into "mostly works." A gap is a gap.

#### Closing self-check (both branches)

Before returning, **re-read the spec file** and confirm the `Status:`
line actually reflects what you decided:

- PASS branch → `Status: done` and the file is under `specs/done/`.
- FAIL branch → `Status: in-progress` and the file is still under
  `specs/pending/`.

If the file's state does not match the verdict, the verification is
incomplete — fix the file before reporting. Do not report a verdict the
file does not record.

## Guardrails

- **Outside the execution context.** The value is independence. Don't
  rationalize a requirement away because the code "almost" meets it — if
  it doesn't pass the spec's bar, it doesn't pass. (This is about the
  *verdict*, not the fixes — Step 4.5 explicitly authorizes you to fix
  implementation gaps. Independence means you don't inherit execute-
  spec's belief that the work is done; it does not mean you refuse to
  edit the code at all.)
- **Evidence, not opinion.** Every PASS cites a test or concrete steps. No
  "looks right."
- **Honest refusal is success.** Refusing to archive a not-done spec is
  this skill doing its job. Marking done to close the loop is its
  failure.
- **Don't edit the spec's meaning to make it pass.** If a requirement is
  wrong, that's a `brainstorm-spec` amendment — not a silent edit here to
  force a green. The only fields you edit on the spec file are `Status`
  and `Completed`, plus the file's location on archive. (Code edits to
  close implementation gaps are not "editing the spec's meaning" — they
  are the fix loop, and are expected.)
- **No partial archives.** A spec ships whole or not at all. Don't archive
  with "only requirement 3 left" — that's exactly the case this gate
  exists to catch.
- **Prefer the fix loop over the handback.** The autonomous contract is
  one `/execute-spec`, one `/verify-spec`, a green build, an archived
  spec. Step 4.5 is what makes that possible; use it before reaching
  for the FAIL branch. The FAIL branch is for genuine dead-ends and
  spec problems, not for one-line fixes.
