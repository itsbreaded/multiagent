---
name: draft-spec
description: Turn a simple or complex product idea into a researched pending spec draft through collaborative discovery. Use when asked to create, explore, scope, or draft a new feature spec from an idea, and for /draft-spec.
---

# draft-spec

Create the initial `draft` spec for an idea, then refine it collaboratively
until it is a sound handoff to `brainstorm-spec`.

## Invocation and boundary

`/draft-spec <idea>`

- Start a new spec only. For an existing pending spec, use `brainstorm-spec`.
- Own idea discovery and the first draft. Do not set `Status: ready`, create
  implementation plans, or begin implementation.
- Keep one independently deliverable concern per spec. Recommend a split when
  the idea contains separable outcomes.

## Discover before drafting

1. Read `specs/TEMPLATE.md`, `docs/writing-specs.md`, and the planning-spec
   rules in `CLAUDE.md`.
2. Inspect relevant repository docs, adjacent code, tests, configuration, and
   completed specs. Establish current behavior, naming conventions, affected
   boundaries, likely dependencies, and constraints. Do not treat prior specs
   as proof; confirm consequential behavior in code.
3. Research the web when the idea depends on current external products, APIs,
   standards, regulations, compatibility, pricing, or user expectations. Use
   authoritative primary sources and distinguish verified facts from inference.
4. Identify the meaningful product and design questions: target users,
   primary workflow, visible behavior, alternatives, failure/empty states,
   privacy/security/cost implications, reversibility, and scope boundaries.

Ask concise, batched questions only for decisions that cannot safely be
learned from the repository or reasonably defaulted. Ask before committing to
a consequential visible, security/privacy, cost, destructive, or
hard-to-reverse choice. For routine details, use the least-surprising,
reversible default and record only consequential choices under `Resolved
Decisions`.

Treat the scope boundary between a named workflow and other workflows that
share its UI or mechanism as a product decision, not a routine technical
detail. If the repository reveals nearby callers and it is plausible to apply
the proposed behavior either only to the named workflow or to all such
callers, ask the user which scope they intend. Do this even when the broader
change is small, reversible, or would improve consistency; those facts inform
the question but do not authorize choosing the scope.

## Create the draft

After enough context exists to describe the problem and intended outcome:

1. Check both `specs/pending/` and `specs/done/` for the next unused global
   three-digit sequence.
2. Create `specs/pending/<number>-<kebab-case-slug>.md` from
   `specs/TEMPLATE.md` with `Status: draft`, today's date, and blank
   `Completed:`.
3. Fill every applicable template section at a WHAT/WHY level. Write precise,
   observable requirements and preliminary Given/When/Then scenarios.
4. Add explicit non-goals and out-of-scope ideas. Keep open product decisions
   as unchecked `Open Questions`; do not disguise assumptions as decisions.
5. Cite related specs by slug only. Mention external research in concise prose
   with source links only where it affects the proposed behavior or scope.

The first version may be incomplete. A useful draft states what is known,
what is proposed, and exactly what still needs agreement.

## Refine collaboratively

Treat each user response as an instruction to revise the same draft:

- incorporate confirmed intent and narrow ambiguous requirements;
- add or adjust scenarios for normal, empty, invalid, error, permission, and
  large-input cases when relevant;
- revisit codebase or web research when an answer changes feasibility or
  constraints;
- record only durable, consequential decisions under `Resolved Decisions`;
- remove resolved questions and surface the next smallest batch of genuine
  decisions.

Show the user a compact summary of each revision: changed intent, remaining
questions, and the draft path. Keep the document as the durable record; do
not create separate discovery logs or implementation plans.

When the user considers the initial draft satisfactory, leave it at `draft`
and direct the handoff to `/brainstorm-spec @specs/pending/<slug>.md`.

## Guardrails

- Use `specs/TEMPLATE.md` for every new draft; preserve its lifecycle fields
  and headings unless a repository convention requires an addition.
- Describe behavior and rationale, never files, functions, libraries, or
  implementation sequencing.
- Do not invent user needs or claim feasibility without investigation.
- Do not resolve a true product decision autonomously when alternatives are
  materially different or irreversible.
- Do not silently broaden or narrow a user's named workflow to adjacent shared
  callers. Present the scoped and shared alternatives when both are plausible.
- Do not mark the draft `ready`; `brainstorm-spec` owns that gate.
