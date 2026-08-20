---
name: 005-execute-spec
description: Implement a ready spec with a durable adjacent plan, incremental checks, and a review-ready handoff. Use for requests to implement, build, execute, or work on a spec, and for /execute-spec.
---

# execute-spec

Implement a `ready` spec with an independently approved implementation plan
and leave it at `review` for independent verification. This is the coding leg
of `brainstorm-spec -> plan-spec -> review-plan -> execute-spec ->
verify-spec`; it does not archive the spec.

## Invocation and gate

`/execute-spec @path/to/spec.md`. If omitted, list `ready` or `in-progress`
specs in `specs/pending/`.

- Refuse specs in `specs/done/`.
- Stop on `draft`; send it to `brainstorm-spec`.
- Stop on `review`; it is awaiting `verify-spec`.
- Accept `ready` only when its adjacent `<slug>.plan.md` exists and has
  `Plan Status: approved`. If it is missing, stale, or marked
  `review`/`changes-requested`, stop and send it to `plan-spec` or
  `review-plan`.
- Accept `in-progress` with an adjacent plan marked `approved`,
  `in-progress`, or `completed`. For existing work, also recognize the
  legacy `specs/plans/<slug>.md` location and migrate it beside its spec when
  next updating it; a legacy or unreviewed plan must be reviewed before new
  implementation changes.

## Preflight

1. Read the spec, relevant repository guidance, and cited dependencies.
2. Locate only the docs relevant to the affected subsystem; do not assume
   generic architecture/data-source documents exist.
3. Inspect the code paths the spec relies on to validate the approved plan
   before implementing.
4. Read `package.json` and use only scripts that actually exist. The baseline
   checks are `typecheck`, `build`, and `test`; use `test:e2e` when the spec
   changes user-visible Electron behavior, IPC, startup, or browser automation.
5. Confirm that any consequential product, security, privacy, cost,
   destructive, or external-side-effect choice is explicitly authorized by
   the user or maintainer; technical plan approval alone is insufficient.

## Consume one durable plan

Use `specs/pending/<slug>.plan.md` beside the spec as the sole required resume
and audit artifact. Do not create a replacement plan during execution. Use
transient task tooling only if it helps the current session.

Before changing code, read the complete plan and confirm it has:

- verified repository facts, architecture/data flow, and explicit sequencing;
- requirement/scenario coverage for every task;
- exact files/symbols, current behavior, implementation changes, invariants,
  edge cases, and isolated verification;
- risks, non-goals, manual limits, and a handoff checklist.

Every requirement needs a task. A task with no requirement is scope creep;
split tasks that cover more than three requirements unless their coupling is
explicit. Set the plan `Plan Status: in-progress` and the spec
`Status: in-progress` when implementation starts. Update task status and
evidence as work completes.

## Implement

- Work in dependency order and match surrounding conventions.
- Keep each change tied to a requirement or an essential implementation need.
- Run focused tests after each coherent change. Run project-wide typecheck
  after shared type/API changes and at handoff; do not repeat it mechanically
  after every small task.
- Respect non-goals and reuse existing services or boundaries where specified.
- Resolve ordinary technical details autonomously using the least-surprising,
  idiomatic approach.
- If implementation discovers a scope, requirement, invariant, sequencing, or
  verification change, stop and return the plan to `plan-spec`/`review-plan`
  before continuing. Do not silently edit around an approved plan.

If the spec is impossible, contradictory, or requires a genuine product,
scope, security/privacy, cost, or irreversible decision, stop and report it
for `brainstorm-spec`. Do not silently alter the spec's meaning. For a missing
or stale dependency, verify the required behavior in code; block only when it
is unavailable or ambiguous.

## Self-check and handoff

Before `review`:

1. Run `npm run typecheck`, `npm run build`, and `npm run test` when present.
2. Run `npm run test:e2e` when required by the preflight impact rule; otherwise
   state why it was not applicable.
3. Run `git diff --check`, remove debug code, and update every plan task with
   the exact evidence and any manual/runtime limitation.
4. Set the plan `Plan Status: completed` and add a short
   `## Implementation Summary` to the plan: requirements covered, checks run,
   and known manual/runtime limits.

On success, set `Status: review` and leave `Completed:` blank. Report the
implemented requirements, executed evidence, and any risks for verification.
On a genuine blocker, leave `in-progress` and report the precise decision or
missing behavior; do not speculate around it.

## Guardrails

- The spec is read-only during execution except for `Status:`.
- Keep implementation detail in the adjacent plan, not the spec.
- `review` means implemented and mechanically checked, not archived or done.
