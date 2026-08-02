---
name: plan-spec
description: Turn a ready spec into a detailed, implementation-ready adjacent plan for independent review before execution. Use when asked to plan a spec, write an implementation plan, or prepare a ready spec for execute-spec.
---

# plan-spec

Create the developer-facing implementation plan for a `ready` spec. The plan
is the HOW document between the behavioral contract and the coding agent; it
must be specific enough that another developer can implement it without
re-discovering the architecture.

## Invocation and gate

`/plan-spec @path/to/spec.md`

- Accept `ready` specs. Refuse `draft`, `review`, and `done` specs.
- For `in-progress`, update an existing plan only when recovering planning
  work; do not rewrite implementation history or change the spec's intent.
- Create or update `specs/pending/<slug>.plan.md` beside the spec.
- Leave the spec `Status: ready` and set the plan `Plan Status: review`.
  `review-plan` owns the next gate; this skill does not approve its own plan.
- Do not edit the spec. The spec remains the WHAT/WHY contract;
  implementation detail belongs in the plan.
- If an approved plan needs a substantive change to scope, requirements,
  sequencing, invariants, or verification, return it to `Plan Status: review`
  and require `review-plan` again. Do not preserve approval by assertion.

## Preflight

1. Read the entire spec, `AGENTS.md`, `docs/writing-specs.md`, and
   `docs/writing-plans.md`.
2. Read only repository docs relevant to the affected subsystem.
3. Inspect the actual code, tests, configuration, and package scripts behind
   every proposed change. Confirm names, boundaries, current behavior, and
   existing test seams; do not copy paths from an old spec as fact.
4. Read cited dependencies and inspect their implementation when the plan
   relies on their behavior.
5. Resolve technical details autonomously. Surface a product, security,
   privacy, cost, or irreversible choice to `brainstorm-spec` instead of
   hiding it in the plan.

## Write the plan

Use the structure in `docs/writing-plans.md`. At minimum include:

- source spec and lifecycle metadata;
- verified repository facts and constraints;
- scope and requirement/scenario coverage map;
- architecture/data-flow and state/lifecycle notes where relevant;
- ordered, right-sized implementation tasks;
- tests and isolated verification for every task;
- cross-cutting invariants, failure/empty/race/large-input behavior, and
  non-goals that implementation must preserve;
- risks, migration/rollback notes, and unresolved technical limitations;
- a handoff checklist for the blind reviewer.

Every task must name:

- its objective and dependency position;
- the exact files and symbols or code boundaries to inspect/change;
- the current behavior and the intended implementation change;
- requirement and scenario IDs covered;
- relevant invariants and edge cases;
- the test fixture/assertion or reproducible check that proves it;
- what completion looks like.

Keep tasks independently reviewable. Split work when a task mixes unrelated
subsystems, hides a sequencing dependency, or covers more than three
requirements unless the coupling is explicit and justified. Do not list
speculative files, generic actions such as "update the UI," or a test command
without saying what it demonstrates.

## Finish

- Re-read the plan as an implementer: it should answer what changes, where,
  why there, in what order, and how each behavior will be proven.
- Re-read it as a reviewer: every requirement, scenario, non-goal, decision,
  dependency, and known risk must have an explicit treatment.
- Set `Plan Status: review`, record the plan path in the handoff message, and
  state any user/maintainer decision that must be explicit before execution.
- Do not begin implementation, mark the plan approved, or set the spec
  `Status: in-progress`.

## Guardrails

- Preserve the spec's behavior, scope, non-goals, and resolved decisions.
- Do not turn routine technical choices into new product decisions.
- Do not claim a file, symbol, test, or dependency exists without checking it.
- Do not include implementation rationale from a prior coding attempt when
  preparing a fresh plan; the plan must stand on repository evidence.
