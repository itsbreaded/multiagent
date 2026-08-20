---
name: 004-review-plan
description: Independently review a spec's implementation plan for completeness, correctness, scope discipline, and developer-facing clarity before execution. Use when asked to review, approve, or sign off an implementation plan.
---

# review-plan

Review a detailed plan as an independent, blind pre-execution gate. The
reviewer receives the spec and plan, not the plan author's rationale or a
coding session's implementation context. The goal is to catch an unsafe,
incomplete, stale, or unnecessarily messy plan before code changes begin.

## Proportionality and stop rule

Review the plan as a material-risk gate, not as an exhaustive style or design
audit. Complete one coverage pass and one targeted falsification pass, then
make the gate decision:

- `changes-requested` is for a missing requirement or scenario, materially
  wrong behavior or architecture, an unapproved consequential choice, a path
  that cannot work, or a load-bearing verification gap.
- An important concern may remain as a non-blocking follow-up when it is
  localized, reversible, and cheaper to fix during implementation without
  changing the contract or architecture. Do not bounce the plan back merely
  because a pre-execution fix would be slightly cleaner.
- Editorial concerns, routine implementation choices, exact wording,
  optional hardening, speculative edge cases, and minor test decomposition
  must not cause `changes-requested` when the plan is implementable and
  verifiable.
- If the plan gives an implementer enough information to build and verify the
  specified behavior, approve it even if it could be made more exhaustive.
  Record only follow-ups that are useful; do not manufacture findings to keep
  the review loop going.

## Invocation and gate

`/review-plan @path/to/spec.md`

- Accept a `ready` spec with an adjacent plan whose `Plan Status: review`.
- Refuse `draft`, `review`, and `done` specs, and refuse plans already marked
  `approved`, `in-progress`, or `completed` unless explicitly asked to audit
  an existing plan without changing its gate.
- Never edit source code or the behavioral parts of the spec.
- Append or replace `## Plan Review` in the plan with the verdict, findings,
  and evidence. Use `Plan Status: approved` only when no blocking finding
  remains. Otherwise use `Plan Status: changes-requested` and leave the spec
  `Status: ready`.

## Independent review

1. Read the spec, adjacent plan, `AGENTS.md`, `docs/writing-specs.md`, and
   `docs/writing-plans.md`.
2. If this session also authored the plan, obtain an independent blind pass
   using available delegation, or explicitly record that delegation was
   unavailable. A same-session re-read is a useful fallback, but it is not a
   separate reviewer and must be reported as such. Do not approve from the
   plan author's rationale alone.
3. Do not read implementation diffs, prior agent explanations, or hidden
   planning notes. Inspect repository code and tests only to verify that the
   plan's paths, symbols, boundaries, assumptions, and verification seams are
   real and current.
4. Build a coverage matrix for every requirement, acceptance scenario,
   non-goal, resolved decision, and cited dependency.
5. Try to falsify the load-bearing parts of the plan before approving it: look
   for missing branches, stale file paths, wrong ownership, ordering/race
   hazards, untestable claims, scope creep, duplicated work, and steps that
   leave a developer to make a consequential decision during implementation.
   Do not extend the pass for speculative or routine details.

Do not treat `Plan Status: approved` as user authorization. If the plan still
contains a consequential product, security, privacy, cost, destructive, or
external-side-effect choice that the user or maintainer has not explicitly
authorized, record it as blocking and route it to `brainstorm-spec`.

## Approval criteria

Approve only when the plan:

- preserves the spec's intent and scope without inventing product behavior;
- maps every requirement and scenario to one or more concrete tasks;
- names real files, symbols, boundaries, data flow, and sequencing;
- explains current behavior, intended change, dependencies, invariants, and
  failure/empty/race/large-input handling where applicable;
- provides an isolated, meaningful verification method for each task and a
  complete handoff check matrix;
- identifies risks, migration/rollback needs, manual/runtime limits, and
  unresolved technical uncertainty;
- distinguishes an independent review from a same-session fallback and
  records the limitation;
- is readable enough to execute, non-repetitive, appropriately decomposed,
  and free of speculative or generic checklist work.

Classify findings as `blocking`, `important`, or `editorial`. Blocking
findings include missing requirement coverage, a materially wrong assumption,
an unresolved product choice, an implementation path that cannot work, or a
verification gap for load-bearing behavior. Important findings are concerns
likely to cause material implementation rework, a defect, or operational risk;
request changes when fixing them before execution has better expected value
than fixing them during implementation. Otherwise record them as non-blocking
follow-ups. Editorial findings never justify `changes-requested` and may be
omitted when they add no useful signal.

## Finish

Record:

- verdict: `APPROVED` or `CHANGES REQUESTED`;
- coverage and repository checks performed;
- findings with precise plan section/task references;
- required corrections, if any;
- reviewer limitations and items that remain manual.

If changes are requested, the plan author reruns `plan-spec`, which returns
the plan to `Plan Status: review`; do not approve a plan you changed only by
assertion. If approved, hand off to `execute-spec` without changing the spec
status.
