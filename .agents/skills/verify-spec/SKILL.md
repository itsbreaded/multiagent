---
name: verify-spec
description: Independently verify a spec against its requirements and scenarios, autonomously repair unambiguous implementation gaps, record durable evidence, and archive a passing spec. Use for requests to verify, check, accept, sign off, finish, or close a spec, and for /verify-spec.
---

# verify-spec

Independently decide whether a spec is done. A passing verification is
archived immediately: `brainstorm-spec -> execute-spec -> verify-spec` ends
with a complete, mechanically sound, durable record.

## Invocation and gate

`/verify-spec @path/to/spec.md`. If omitted, list `review` and `in-progress`
specs in `specs/pending/`.

- Refuse a spec already under `specs/done/`.
- Stop on `draft` or `ready`; send it to `execute-spec`.
- `review` is the normal handoff.
- `in-progress` is rescue verification: continue only if its adjacent plan
  shows every requirement task complete. Otherwise report the missing work and
  leave it in progress. This avoids needless handoffs after an interrupted
  execution without treating partial work as ready.

## Preflight and independence

1. Read the spec and its adjacent `specs/pending/<slug>.plan.md`; for existing
   work, also recognize the legacy `specs/plans/<slug>.md` location and
   migrate it beside the spec when next updating it. If no plan is present,
   establish the relevant changed files from version control and record the
   limitation.
2. Read only applicable repository guidance. Discover runnable checks from
   `package.json`; never assume scripts exist.
3. If this session also implemented the spec, obtain an independent blind
   requirements/scenario pass using available delegation, or explicitly state
   that independence is unavailable before proceeding. Do not provide the
   verifier with implementation rationale; give it only the spec and plan.
4. Treat dependency status as advisory. Confirm each behavior the spec relies
   on in code; fail only if it is unavailable or ambiguous.

## Build and run the verification matrix

For every requirement, acceptance scenario, non-goal, consequential resolved
decision, and dependency, record one of `PASS`, `FAIL`, or `UNVERIFIED` and
the concrete evidence: test name, command result, or reproducible manual/code
path check. Try to falsify each item before accepting it.

An unresolved `Open Questions` entry is a failure. A missing demonstration
for a requirement or scenario is `UNVERIFIED`, not a pass. Confirm non-goals
were not quietly implemented.

Run these checks when present:

- `npm run typecheck`
- `npm run build`
- `npm run test`
- `npm run test:e2e` when the changed surface includes user-visible Electron
  behavior, IPC, startup, or browser automation; otherwise record why it was
  not applicable.

Also inspect the change for debug code, commented-out dead code, and TODOs
that pretend to satisfy a requirement.

## Repair loop

Fix an issue autonomously when the spec unambiguously defines the expected
behavior and the repair is minimal, idiomatic, and does not create a new
visible product choice. This includes mechanical failures, missing wiring,
missing straightforward tests, and stale debug code.

After each repair, run the affected check, then the full unit suite, and
re-evaluate every matrix item it could affect. Continue while each attempt
adds evidence or narrows the issue. Stop when work repeats without new
evidence, grows into a redesign, changes product intent, or needs a material
scope, cost, security/privacy, or irreversible decision.

For that boundary, leave `Status: in-progress` and report the exact issue for
`brainstorm-spec`. Do not ask the user to re-run `execute-spec` for an obvious
implementation repair.

## Record and decide

Append a compact `## Verification Evidence` section to the adjacent plan:

- requirement/scenario -> verdict and evidence;
- non-goal/dependency checks;
- commands run and results;
- deliberate exclusions or manual/runtime limits;
- autonomous repairs made during verification.

### PASS: archive

Only when every matrix item passes and mechanical checks are green:

1. Change the spec to `Status: done` and set `Completed:` to today's date.
2. Move the spec and its adjacent `<slug>.plan.md` from `specs/pending/` to
   `specs/done/`, preserving filenames.
3. Re-read the archived spec to confirm its status and location.
4. Report the evidence summary, repairs, and any stated manual/runtime limits.

### FAIL: reopen

If a non-repairable gap remains, do not archive. Set `Status: in-progress`,
leave the plan and evidence in `specs/pending/`, re-read the status, and state
the exact blocking decision or missing behavior.

## Guardrails

- Evidence, not opinion: no requirement passes merely because the code looks
  plausible.
- Do not edit requirements, scenarios, non-goals, or decisions to make a spec
  pass. Amend those through `brainstorm-spec`.
- Archive whole specs only. A partial archive is a failure, not a shortcut.
