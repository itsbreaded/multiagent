---
name: auto-orchestrator-spec
description: Autonomously drive pending specs through brainstorm-spec, plan-spec, review-plan, execute-spec, and verify-spec in a loop until all are done or a stated stopping point is reached, delegating any user-decision moments to a blind subagent. Use for /auto-orchestrator-spec.
---

# auto-orchestrator-spec

Run the project's spec pipeline unattended. For each pending spec, drive
`brainstorm-spec -> plan-spec -> review-plan -> execute-spec -> verify-spec`
to completion, then advance to the next, until every pending spec is archived
to `specs/done/` or a stopping point declared at invocation is reached. Never
hand a question back to the user; resolve decision moments with a blind
subagent.

This skill orchestrates the five existing phase skills; it does not redefine
their behavior. Their gates are the contract:

- `brainstorm-spec`: `draft`/`in-progress` -> `ready`
- `plan-spec`: `ready` -> adjacent plan with `Plan Status: review`
- `review-plan`: plan `review` -> `approved` or `changes-requested`
- `execute-spec`: `ready`/`in-progress` with an approved plan -> `review`
- `verify-spec`: `review`/`in-progress` -> archive to `done`

## Invocation and scope

`/auto-orchestrator-spec [stopping point]`

- **Default**: continue until every spec in `specs/pending/` is archived to
  `specs/done/`.
- A stopping point may be stated at the initial call only:
  - a spec path or slug (`@specs/pending/foo.md` or `foo`) — stop after that
    spec is done;
  - `until-blocked` — stop at the first spec that cannot be completed
    autonomously;
  - `max N` — stop after N specs are archived;
  - `only <slug>` — process exactly one spec, still through all five phases.
- Do not infer a stopping point from silence. The default is "all pending."

## Execution continuity (mandatory)

This is a long-running workflow. A progress update is **not** a terminal
condition. Keep working in the same active turn after every successful tool
call, phase transition, test result, checkpoint update, or archived spec.

- Send concise progress updates only in the commentary/intermediate channel;
  never use a final response to report partial implementation, a passing
  check, or a resumable checkpoint.
- Emit a final response only after one of the terminal conditions below:
  every queued spec is archived; the invocation's declared stopping point is
  reached; a Safety halt occurs; or a retry/attempt/overall cap requires a
  stop.
- Before emitting a final response, mechanically inspect `specs/pending/`,
  the checkpoint, and the active spec status. If any queued spec is still
  `draft`, `ready`, `in-progress`, or `review` without a recorded terminal
  blocker, continue the loop.
- When the Codex surface provides Goal mode or a goal/continuation mechanism,
  use it for this invocation with the outcome “archive all pending specs” and
  the phase gates as completion criteria. Goal mode keeps long-running work
  active; this skill still owns the queue and safety rules.
- If the hosting surface ends a turn outside the agent's control, the next
  invocation MUST read the checkpoint and resume immediately. Do not describe
  the prior partial run as completed.

## Hard limits (prevent infinite loops)

Unbounded feedback paths are the root cause of infinite agentic loops, so
the orchestrator carries its own budgets, independent of phase budgets:

- **Per-spec attempt cap**: at most 5 full passes through the five phases
  per spec. Still not archived after that -> stop on that spec, report.
- **Per-phase retry cap**: if a phase exits three times in a row without
  advancing status for the same blocker, do not retry it a fourth time -> stop, report.
- **Overall cap**: stop after 8 consecutive specs fail to advance, or when a
  phase requests an action in the **Safety halt** set.
- A phase that genuinely cannot advance is a stopping point, not a reason to
  retry harder. Prefer reporting over looping.

## No user handoffs — delegate decisions to a blind subagent

The phase skills normally ask the user at certain points (product intent,
scope, visible behavior, cost/security/privacy, irreversible choices). In
this loop, **do not ask the user**. Delegate the decision to a blind
subagent:

- Spawn a subagent (read-only exploration only) given **only**: the spec
  content, the specific decision or question, the minimal repo context it
  needs, and these rules:
  - Choose the least-surprising option consistent with the spec's intent,
    the repo's existing conventions, and any cross-spec dependencies.
  - Prefer reversible choices over irreversible ones.
  - Do not edit files or spawn further subagents. Return a structured
    decision: `choice`, `one-line rationale`, `assumptions`, `reversibility`
    (reversible/irreversible).
- The subagent is **blind**: it does not receive the orchestrator's loop
  history or prior in-loop decisions beyond what you pass it. Give it the
  spec and the question, not the running narrative.
- Adopt the returned decision, apply it in the current phase, and record it
  where that phase records decisions (`Resolved Decisions` in the spec for
  brainstorm; the adjacent `<slug>.plan.md` for execute; verification
  evidence for verify), attributed as "resolved by auto-orchestrator blind
  subagent."

### Safety halt — stop, do not auto-decide

Some actions are stopping points even with subagent delegation. Stop the
loop and report (do not ask — just stop) when a phase or its blind subagent
proposes any of:

- a destructive or irreversible operation with no rollback (deleting data,
  force-pushing, dropping a database);
- an outward-facing change (sending messages, calling paid external APIs at
  scale, publishing) the spec did not explicitly authorize;
- a security or credential exposure (committing or extracting secrets,
  disabling a safety control);
- a cost commitment beyond what the spec implies.

This rarely triggers during ordinary spec implementation (code edits and
tests are reversible); it is the backstop. Report the proposed action and
its spec as a stopping point.

## Loop procedure

1. **Load phase behavior.** Invoke each phase through its skill (via the
   Skill tool) when you enter it, so you follow its canonical, latest
   behavior rather than paraphrasing it. This skill's rules override the
   phase skills only on user-handoff: where a phase skill says to ask the
   user, use the blind subagent instead.
2. **Build the queue.** List `specs/pending/` and `specs/done/`. Skip
   anything already in `done/`. Read each spec's `Status:` line. Compute a
   dependency order from cross-spec slug references: a spec that cites a
   dependency by slug is processed after that dependency. Independent specs
   may be processed in any order.
3. **Checkpoint.** Maintain a transient state file
   `specs/.auto-orchestrator-state.md` (gitignore it — it is a run artifact,
   not project history). Record per spec: current phase, last status,
   attempt count, blocker. Update it after each phase so an interrupted run
   resumes without redoing completed phases. On resume, read it first, then
   re-confirm status from the spec file itself — the file is source of
   truth; the checkpoint is only a hint.
4. **For each spec in order, within the per-spec attempt cap:**
   1. **brainstorm-spec** if status is `draft` (or `in-progress` with
      unresolved `Open Questions`). Drive to `ready`. Use the blind subagent
      for any "ask the user" moment. If it cannot reach `ready` within the
      per-phase retry cap, stop and report.
   2. **plan-spec** if status is `ready`, or if an `in-progress` spec is being
      recovered with a missing or `changes-requested` plan, or if the plan
      needs substantive revision. Drive the plan to `Plan Status: review`.
      Do not begin implementation.
   3. **review-plan** when the plan has `Plan Status: review`. Obtain the blind
      review and drive it to `approved` or stop on `changes-requested` until
      `plan-spec` repairs it.
   4. **execute-spec** if status is `ready` or `in-progress` and the adjacent
      plan is approved or already in execution. Resume from the adjacent
      plan and drive the spec to `review`. Use the blind subagent for any
      decision the phase would ask the user. On a genuine product/scope/
      irreversible blocker, stop and report.
   5. **verify-spec** if status is `review` (or `in-progress` rescue per
      verify-spec's own rule). Because this session also executed, obtain an
      **independent** pass: spawn a blind verifier subagent given only the
      spec and the plan, ask for the PASS/FAIL/UNVERIFIED matrix, and use its
      result. Give the verifier no implementation rationale. Archive on PASS
      per verify-spec's rules.
   6. After archive, update the checkpoint and advance.
5. **Advance or stop.** After each spec: if the stopping point is reached,
   stop. If the spec failed to advance within its caps, stop and report — do
   not silently skip to the next. If it advanced, continue. When all specs
   are done, report a summary.

## Dependencies and ordering

- Process dependencies before dependents. If a dependency is blocked or
  failed, a dependent spec cannot be completed; record it as blocked and
  continue with independent specs. If the blocked dependency is on the
  critical path to the stated stopping point, stop instead.
- When a spec's `Open Questions` cite another spec by slug that is not yet
  done, treat that as a dependency to complete first.

## Verification independence

The verify phase is the loop's external anchor — its value comes from not
sharing the implementer's blind spots. Always run verification through a
fresh, blind subagent that sees only the spec, the plan, and the repo (not
the orchestrator's reasoning or the implementer's rationale). A spec passes
only on mechanical evidence (tests, typecheck, build, observable behavior),
never because the code looks plausible. If independent verification is
genuinely unavailable, state that explicitly in the evidence before
proceeding.

## Best-practice guidance for the loop

- **Gate on correctness, not taste.** A spec advances only on mechanical
  evidence, not because an artifact looks good.
- **Cap retries; surface repeated failure.** Repeated non-advancement is a
  stop, not a reason to retry harder.
- **External anchors over self-reflection.** Prefer a runnable check over a
  model's opinion; verify-spec's matrix is the anchor.
- **Keep the main context lean.** Use subagents for the blind verification
  pass and for guidance decisions; keep the orchestrator context dominated
  by status, not file dumps.
- **Sequential by default.** Process one spec at a time. Parallel fan-out of
  independent specs is allowed only when their subsystems are disjoint and
  you use isolated worktrees; the default is sequential, because a solo loop
  with real verification usually beats a swarm.
- **Idempotent resume.** Re-running after an interruption must not redo
  archived specs or re-ask resolved decisions. Spec status and the
  checkpoint are the resume source of truth.
- **Trace decisions.** Record every blind-subagent decision and every stop
  (in the spec/plan/evidence and the checkpoint) so a later run or human can
  reconstruct what was decided and why.

## Guardrails

- Do not edit requirements, scenarios, non-goals, or resolved decisions to
  make a spec pass; that is `brainstorm-spec`'s job, and only with a recorded
  decision.
- Do not skip phases. A spec is done only after `verify-spec` archives it.
- Do not broaden a spec's scope to satisfy a dependency; resolve the
  dependency first or stop.
- Do not commit or push; that is requested outside this skill.
- Do not run indefinitely. Every loop has the caps above; reaching a cap is
  a valid, expected stop.
