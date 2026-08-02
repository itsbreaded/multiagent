# Writing good specs

Detailed guide for authoring specs in this repo. Read this when you are
drafting or reviewing a spec; you do not need it for routine tasks. The
workflow is `draft-spec → brainstorm-spec → plan-spec → review-plan →
execute-spec → verify-spec`; the plan contract is in
[`docs/writing-plans.md`](writing-plans.md). Repository-wide rules and the
docs map live in [`AGENTS.md`](../AGENTS.md).

A copy of `specs/TEMPLATE.md` is the recommended starting point.

Implementation plans are separate adjacent artifacts. Keep this document and
the spec focused on WHAT/WHY; use [`docs/writing-plans.md`](writing-plans.md)
for repository-specific HOW, sequencing, task detail, and pre-execution review.

## Principles

Specs are the contract between intent and implementation. They are what
keeps an autonomous agent building *the right thing* rather than a
plausible-looking thing. Write them to minimize ambiguity.

- **Describe behavior, not implementation.** Say what the system must do
  and why, not how to code it. "Persist games between sessions" is a
  requirement; "use SQLite" is a decision that belongs in the plan.
- **One concern per spec.** If a spec covers two unrelated features, split
  it. Small specs are easier to review, implement, and verify.
- **Make requirements verifiable.** Every requirement should be answerable
  with a clear yes/no or a passing/failing test. Avoid words like "fast",
  "nice", "good" without a measurable definition.
- **State Non-Goals explicitly.** Saying what is *out of scope* is as
  valuable as saying what is in scope. It keeps the agent focused and
  prevents gold-plating.
- **Write acceptance scenarios as tests.** Given/When/Then scenarios double
  as your test cases. If you can't write a scenario for a requirement, the
  requirement is probably too vague.
- **Capture the WHY.** A future reader (human or agent) needs to know the
  problem, not just the solution. Without the why, good-faith "improvements"
  quietly drift from intent.
- **Resolve Open Questions before implementing.** Ambiguity resolved during
  planning is far cheaper than ambiguity resolved during implementation.
- **Keep it stable once "ready".** After a spec is agreed, prefer adding a
  new spec over silently editing this one — so the history of intent stays
  legible.
- **Keep specs and code honest.** If reality diverges from the spec during
  implementation, stop and route a product or scope change through
  `brainstorm-spec`; do not silently edit a ready contract or let code drift
  from the documented intent.

## Definition of done

A feature is not done because code exists or a broad test command is green.
The adjacent plan must be approved before implementation, implementation
tasks must record concrete checks, and `verify-spec` must map every
requirement, scenario, non-goal, decision, and dependency to `PASS`, `FAIL`,
or `UNVERIFIED` evidence. Only a complete `PASS` matrix with green applicable
checks may move the whole spec and plan to `specs/done/`.

User-visible, destructive, external-side-effect, security, privacy, or costly
choices still require explicit user or maintainer authorization. A technical
plan approval is not a substitute for that product decision.
