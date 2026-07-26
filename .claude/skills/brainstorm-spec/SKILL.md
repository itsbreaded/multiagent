---
name: brainstorm-spec
description: Flesh out a pending spec until it is ready for a clean developer handoff. Triggers on natural-language requests to "fill in", "tighten", "flesh out", "resolve open questions in", or "get a spec ready", and on the /brainstorm-spec slash command. The model audits the spec for ambiguities and gaps, resolves technical/implementation issues itself (or via an advisor subagent), and poses only feature/design/user-facing decisions to the user.
---

# brainstorm-spec

Take a pending spec from draft-ish to **ready**: every requirement
verifiable, every acceptance scenario passable, no Open Questions left,
and a clean handoff for whoever implements it next.

## Invocation

`/brainstorm-spec @path/to/spec.md` — usually a file in
`specs/pending/`. Accept a bare path or an `@`-mention. If no spec is
given, ask which pending spec to work on (list `specs/pending/`).

## Step 0: Gate on status (read first)

This skill operates on specs that are **not yet** `ready`. Before anything else:

- If the path is under `specs/done/` → **refuse**. Done specs are immutable
  history. Suggest a new spec in `pending/` instead.
- If Status is `ready`, `review`, or `done` → **stop, don't edit**. Report
  what you found. To act on it, the user should either start a follow-up
  spec (per `docs/writing-specs.md` → "Keep it stable once ready") or
  explicitly override — in which case reset Status to `draft` first, so the
  re-open is deliberate, not silent.
- Only `draft` / `in-progress` specs are fair game to edit in place.

## The core division of labor

This is the heart of the skill. Sort every issue you find into one of
two buckets and treat them differently:

- **Technical / implementation** — libraries, data shapes, schema,
  adapter reuse, where a number comes from, how a state degrades,
  existing-service calls, performance tradeoffs, cross-spec data
  dependencies. **Resolve these yourself** — decide, then write the
  decision into the spec. Spin up an advisor subagent (see step 3) when
  the answer isn't obvious from the codebase. Do NOT pose these to the
  user.
- **Feature / design / user-facing** — what the feature *does* for a
  person, scope boundaries, defaults the user would feel, UX choices,
  naming users see, what's in vs. out, priorities, taste calls.
  **Pose these to the user** via `AskUserQuestion`. Never silently
  decide them.
- **Both buckets** — decisions with a real perf/implementation tradeoff
  *and* a UX footprint the user feels (pagination vs infinite scroll,
  default page size, lazy vs eager load, debounce thresholds, "Top N").
  **Pose to the user** via `AskUserQuestion`, framing options by their
  UX feel; you may put your tech recommendation in the option
  descriptions, but the user picks. Don't let "it's technical" hide a
  choice the user will live with.

When you genuinely cannot tell which bucket an issue is in, it's
feature/design — ask.

## Workflow

### 1. Load the spec and its context

- Read the target spec in full.
- Read `specs/TEMPLATE.md` (the required sections) and
  `docs/writing-specs.md` (the principles).
- Read the architecture and data-sources docs
  (`docs/architecture.md`, `docs/data-sources.md`) **only if the spec
  touches** integrations, the stack, or data the docs cover.
- Read any **cross-referenced specs** the target depends on (specs are
  linked by slug, e.g. "spec `library-display-and-filtering`"). Fetch
  their actuals so you don't assume a dependency that doesn't exist or
  miss one that does.

### 2. Audit the spec

Run the spec against this checklist. Don't just summarize — produce a
concrete list of *issues*, each tagged **tech**, **design**, or **both**:

- **Missing sections**: confirm every section from `specs/TEMPLATE.md` is
  present. A missing `Problem`/`Users & Context` is a `design` issue
  (you need the user to ground them); a missing `Scenarios`/`Non-Goals`
  is a `tech` issue you can draft and have the user react to.
- **Missing WHY**: Problem section doesn't make the pain concrete.
- **Unverifiable requirements**: anything with "fast", "nice",
  "good", "scalable", "responsive" without a measurable definition.
- **Ambiguous requirements**: two reasonable implementers could build
  different things and both claim compliance.
- **Open Questions** present and unresolved, or items that *should* be
  open questions but were silently decided.
- **Missing acceptance scenarios**: a requirement with no
  Given/When/Then that proves it.
- **Missing or weak Non-Goals**: nothing explicitly fenced out of scope
  (scope creep risk).
- **Numbered cross-references**: any `spec 02` / `spec 03`-style ref
  that should be a slug (`spec library-display-and-filtering`). The slug
  is the stable identity; numbers are renumbered freely. Convert on
  edit — including in existing prose, not just new writing.
- **Cross-spec assumptions**: the spec references another spec's
  data/service/behavior — does it actually exist and work as assumed?
  If the referenced spec isn't `done` yet, that's a sequencing risk to
  flag, not silently degrade around.
- **Contradictions**: requirement A and B (or a Non-Goal) conflict.
- **Unstated edge cases**: empty input, failure, zero, auth boundary,
  large-N behavior.

If the audit turns up **nothing material**, set Status to `ready`,
report "no changes needed — already ready-grade," and stop. Don't
invent edits to justify the run.

### 3. Resolve technical issues (your job)

For each **tech** issue:

- If the answer is in the codebase/docs: decide it.
- If it needs real investigation (schema lookup, tracing an adapter,
  checking what a service returns, comparing approaches): **spawn an
  advisor subagent** (`Agent` tool — `Explore` for read-only codebase
  lookups; `Plan` only if you need an implementation-strategy
  comparison) with a focused question and the relevant file paths. One
  subagent can answer several bundled tech questions. Use the conclusion
  to decide — don't parrot the advisor's report at the user.
- Write the resolution into the spec (see Editing below).
- If a resolution depends on another spec that isn't `done` yet, record
  the dependency in the spec *and* flag it in the final report so work
  can be sequenced.

### 4. Pose design issues to the user (their job)

Collect all **design** (and **both-bucket**) issues, then ask them in
**one `AskUserQuestion` call** (up to 4 questions per call — batch, do
another round if there are more). For each:

- Give a clear `question`.
- Offer 2–4 concrete `options`, each with a one-line `description` of
  the tradeoff. Put the option you'd recommend first and mark it
  "(Recommended)".
- If a question needs the user to see a layout/wording tradeoff, use the
  `preview` field (if available).
- If a user's answer invalidates a later question, drop the now-moot
  question and ask the follow-up it raises in the next round.

Do not ask questions you could answer from the code or from existing
spec/Non-Goal decisions already on record. Do not ask "is the spec
good?" — ask specific, decision-shaped questions.

If `AskUserQuestion` is not available, fall back to posting the same
questions as plain numbered text with your recommended option marked,
and wait for replies before editing.

### 5. Edit the spec in place

Apply all resolutions — yours and the user's — directly to the spec
file (`Edit`):

- Sharpen unverifiable/ambiguous requirements **in place** — replace the
  vague words with the agreed measurable definition; don't restructure
  the requirement or rewrite surrounding prose to get there.
- Add missing Given/When/Then scenarios; tighten weak ones.
- Fill in Non-Goals for anything now explicitly out of scope.
- **Every resolved decision** goes under `## Open Questions` using this
  repo's convention — change the section to `None outstanding.` then a
  `**Resolved:**` bullet list, each entry recording *the decision and
  the one-line why* (see `specs/pending/06` and `07` for the pattern).
  Cite cross-spec dependencies by **slug**, never by the build-order
  number.
- Keep the spec at WHAT/WHY altitude — no files, functions, or library
  names beyond what the spec style already permits. Implementation
  detail belongs in the plan, not here. If a tech resolution is purely
  "use library X", record the *behavioral* outcome in the spec and leave
  the library choice for the plan.

### 6. Decide readiness and report

When no design questions remain outstanding and no tech issue is
unresolved:

- Set the spec's **Status** to `ready`.
- Leave `Completed:` blank — that's filled only on ship (move to
  `specs/done/`). This skill does **not** archive.
- Report a tight summary: what you resolved (tech), what you asked the
  user (design) and their answers, what scenarios/non-goals you added,
  and the final status. Flag anything you intentionally left for the
  plan.

If the user declines to answer a design question, record it as an
unresolved Open Question and leave Status below `ready` — do not guess
to force closure.

## Guardrails

- **One concern stays one concern.** If fleshing out reveals a genuinely
  separate feature, say so and recommend a split rather than bloating
  this spec.
- **Don't rewrite the spec's voice.** Preserve its structure and tone;
  edit surgically.
- **Stable once ready.** Per `docs/writing-specs.md`, once a spec is
  agreed, prefer a follow-up spec over silent edits. This skill operates
  only on specs not yet `ready` (see Step 0's gate), so in-place editing
  is expected — but once you've set `ready`, stop.
- **Verify, don't assume.** If a resolution depends on a function,
  column, or behavior existing, confirm it in the code before writing
  the spec around it.
