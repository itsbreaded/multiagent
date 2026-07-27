---
name: brainstorm-spec
description: Turn a draft or in-progress spec into a ready, verifiable implementation contract. Use for requests to brainstorm, flesh out, tighten, resolve open questions in, or prepare a spec for implementation, and for /brainstorm-spec.
---

# brainstorm-spec

Take a pending spec to `ready`: clear behavioral requirements, passable
scenarios, explicit scope, and no unresolved blocking questions.

## Invocation and gate

`/brainstorm-spec @path/to/spec.md`. If omitted, list draft or in-progress
specs in `specs/pending/` and ask which one to prepare.

- Refuse specs in `specs/done/`.
- Stop on `ready`, `review`, or `done`; preserve agreed intent. A meaningful
  change needs an explicit reopen to `draft` or a follow-up spec.
- Edit only `draft` or `in-progress` specs.

## Preflight

1. Read the spec and `specs/TEMPLATE.md` fully.
2. Read `docs/writing-specs.md`; read a relevant architecture or subsystem
   document only when the spec touches it. Do not assume a named document
   exists: locate the relevant repo documentation first.
3. Read every cited cross-spec dependency by slug. Confirm cited behavior in
   code when it affects a requirement.
4. Preserve the target spec's established headings. Recognize `Open Questions`
   and `Resolved Decisions`; do not reformat mature specs merely to match the
   template.

## Audit

Identify concrete issues and classify each as `technical`, `product`, or
`mixed`:

- missing problem, users/context, requirements, non-goals, scenarios, or
  consequential decisions;
- ambiguous, contradictory, or non-verifiable requirements;
- a requirement without an acceptance scenario;
- unresolved questions, missing failure/empty/auth/large-input behavior, or
  invalid cross-spec assumptions;
- scope that belongs in a separate feature.

If no material issue remains, set `Status: ready` and report that it was
already ready-grade.

## Decide autonomously by default

Resolve technical details from the codebase and documentation. Investigate
focused unknowns with available read-only exploration tools when useful.

For product decisions, proceed with the least-surprising, reversible default
when it is consistent with the spec and existing product conventions. Record
only consequential defaults under `Resolved Decisions` (or the spec's
equivalent), with a one-line rationale.

Ask the user only when proceeding would choose product intent, materially
change visible behavior or scope, affect cost/security/privacy, create a
hard-to-reverse consequence, or leave two genuinely plausible outcomes. Batch
independent questions in one available question mechanism; if none exists,
ask concise numbered questions and wait. Do not ask for facts that the repo
can answer.

The decision to extend a behavior from the workflow named in the request to
other workflows sharing the same UI, component, or mechanism is a material
scope and visible-behavior choice. When both the named-only and shared-callers
scope are plausible, ask the user before marking the spec ready. Do not
auto-resolve it because the shared implementation is small, reversible, or
more consistent; explain those tradeoffs in the question instead.

## Edit and finish

- Make surgical edits; retain the spec's voice and WHAT/WHY altitude.
- Replace vague wording with observable behavior and add Given/When/Then
  scenarios. Add clear non-goals.
- Use slugs, never build-order numbers, for spec references.
- Keep `Open Questions` as `None outstanding.` before `ready`. Keep only
  consequential decisions in `Resolved Decisions`; routine implementation
  choices belong in the plan.
- If a choice remains blocked on the user, leave the status below `ready` and
  state the exact decision needed.
- Otherwise set `Status: ready`, leave `Completed:` blank, and report the
  resolved defaults, remaining dependencies, and handoff scope.

## Guardrails

- One concern per spec. Recommend a split rather than quietly expanding it.
- Do not silently broaden or narrow a user's named workflow to adjacent shared
  callers. Obtain explicit scope confirmation when either boundary is plausible.
- Verify code and dependencies before recording assumptions as facts.
- Do not introduce files, functions, libraries, or implementation sequencing
  into the spec; that belongs in the plan.
