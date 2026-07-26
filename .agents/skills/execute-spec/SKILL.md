---
name: execute-spec
description: Implement a ready spec with a durable adjacent plan, incremental checks, and a review-ready handoff. Use for requests to implement, build, execute, or work on a spec, and for /execute-spec.
---

# execute-spec

Implement a `ready` spec and leave it at `review` for independent
verification. This is the coding leg of `brainstorm-spec -> execute-spec ->
verify-spec`; it does not archive the spec.

## Invocation and gate

`/execute-spec @path/to/spec.md`. If omitted, list `ready` or `in-progress`
specs in `specs/pending/`.

- Refuse specs in `specs/done/`.
- Stop on `draft`; send it to `brainstorm-spec`.
- Stop on `review`; it is awaiting `verify-spec`.
- Accept `ready` and `in-progress`. Resume an in-progress spec from its
  adjacent `<slug>.plan.md`; for existing work, also recognize the legacy
  `specs/plans/<slug>.md` location. Migrate a legacy plan beside its spec when
  next updating it. If no plan exists, reconstruct a minimal plan from the
  spec and relevant diff before changing code.

## Preflight

1. Read the spec, relevant repository guidance, and cited dependencies.
2. Locate only the docs relevant to the affected subsystem; do not assume
   generic architecture/data-source documents exist.
3. Inspect the code paths the spec relies on before planning.
4. Read `package.json` and use only scripts that actually exist. The baseline
   checks are `typecheck`, `build`, and `test`; use `test:e2e` when the spec
   changes user-visible Electron behavior, IPC, startup, or browser automation.

## Create one durable plan

Create `specs/pending/<slug>.plan.md` beside the spec. It is the sole required
resume and audit artifact; use transient task tooling only if it helps the
current session.

Keep it short. For each right-sized task record:

- status (`pending`, `in_progress`, `completed`);
- requirement/scenario mapping;
- likely files or subsystem;
- one isolated verification method.

Every requirement needs a task. A task with no requirement is scope creep;
split tasks that cover more than three requirements. Update the plan as work
completes. Set the spec `Status: in-progress` once the plan exists.

## Implement

- Work in dependency order and match surrounding conventions.
- Keep each change tied to a requirement or an essential implementation need.
- Run focused tests after each coherent change. Run project-wide typecheck
  after shared type/API changes and at handoff; do not repeat it mechanically
  after every small task.
- Respect non-goals and reuse existing services or boundaries where specified.
- Resolve ordinary technical details autonomously using the least-surprising,
  idiomatic approach.

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
3. Remove debug code and update every plan task.
4. Add a short `## Implementation Summary` to the plan: requirements covered,
   checks run, and known manual/runtime limits.

On success, set `Status: review` and leave `Completed:` blank. Report the
implemented requirements, executed evidence, and any risks for verification.
On a genuine blocker, leave `in-progress` and report the precise decision or
missing behavior; do not speculate around it.

## Guardrails

- The spec is read-only during execution except for `Status:`.
- Keep implementation detail in the adjacent plan, not the spec.
- `review` means implemented and mechanically checked, not archived or done.
