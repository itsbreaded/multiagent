# Writing good specs

Detailed guide for authoring specs in this repo. Read this when you are
drafting or reviewing a spec; you do not need it for routine tasks. The
core workflow (spec → plan → implement → verify → ship), folder
conventions, lifecycle, and Definition of Done live in `CLAUDE.md`.

A copy of `specs/TEMPLATE.md` is the recommended starting point.

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
  implementation, update the spec (or write a follow-up spec) rather than
  letting the code drift from the documented intent.
