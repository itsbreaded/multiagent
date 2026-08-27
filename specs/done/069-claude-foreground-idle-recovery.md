# Spec: Recover Claude Foreground Idle Status After Missed Completion

Status: done <!-- draft | ready | in-progress | review | done -->
Created: 2026-08-27
Completed: 2026-08-27

## Problem

MultiAgent marks a Claude pane as `working` when a prompt or tool event begins.
It normally returns the pane to `idle` only after Claude provides a complete,
current-session confirmation that no active or scheduled work remains.

Claude can nevertheless return control to the user without producing a normal
completion event. In particular, a silent stop after a tool result can leave
the user at the input prompt without invoking `Stop`; Claude also documents
that `Stop` does not run for a user interrupt. The current delayed
`idle_prompt` recovery is restricted to a matching Escape marker, so an
ordinary missed completion can leave the pane showing `working` indefinitely.

This is a status correctness problem and can also keep a pane protected from
idle suspension after its foreground turn has ended. Current repository
guardrails intentionally reject terminal quietness, elapsed time, process age,
and generic terminal text as proof of idle. The product therefore needs an
explicit policy for ambiguous Claude turns rather than an ad hoc timeout.

Claude's current hook reference exposes additional lifecycle and notification
events, but the provider has known gaps and inconsistencies around silent
stops and background teammates. Comparable status monitors layer lifecycle
hooks with delayed recovery and a separately represented stalled or stale
condition, rather than treating every quiet process as idle. Relevant sources:
[Claude hooks reference](https://code.claude.com/docs/en/hooks), [silent tool
stop issue #29881](https://github.com/anthropics/claude-code/issues/29881), and
[a layered hook/watchdog monitor](https://github.com/CHOCH2R/claude-agent-notify).

## Goal

A Claude pane must converge to an accurate visible foreground status after a
turn ends, including when the normal completion event is missed, without
reporting foreground `idle` while Claude is continuing or awaiting a decision.
Automatic suspension must remain conservative when background-work evidence
is incomplete.

## Users & Context

Users running Claude panes in MultiAgent who switch tabs or windows while a
turn is executing, especially after tool calls or an Escape interrupt. The
initial scope is Claude foreground-turn status. Background subagent and team
accounting is related to, but separately tracked by,
`pane-active-while-subagent-runs`.

## Requirements

1. MUST represent a Claude pane as `working` while its current foreground turn
   is still active.
2. MUST transition the visible Claude foreground status to `idle` when a
   current-session provider signal establishes that the foreground turn has
   ended and no known active or scheduled background work remains.
3. MUST use Claude's delayed `idle_prompt` notification as an eventual
   recovery path when Claude has returned control to the user but the normal
   completion event was not delivered, provided the notification carries the
   current session and turn identity.
4. MUST NOT transition to `idle` solely because terminal output is quiet, a
   fixed amount of time elapsed, a process still exists, or generic text was
   observed in the terminal.
5. MUST keep the pane protected from automatic idle suspension while complete
   empty-work evidence is unavailable, the foreground state is ambiguous, or
   active or scheduled work remains. Visible `idle` and suspension eligibility
   MUST be allowed to differ for this protection case.
6. MUST preserve `waiting` for permission or user-input conditions and
   `error` for terminal/provider failures; a recovery signal MUST NOT erase
   either state without a newer event that establishes recovery.
7. MUST reject recovery evidence from another session, another turn, or an
   unverified identity, and MUST remain safe under duplicate, delayed, or
   out-of-order events.
8. MUST handle malformed, incomplete, missing, and provider-version-drifted
   status payloads without crashing or claiming false idle.
9. MUST behave consistently for supported Claude panes on Windows, macOS, and
   Linux.
10. MUST leave Codex and OpenCode status semantics unchanged unless a separate
    approved scope decision expands this work.

## Non-Goals

- We will NOT redesign background subagent, named teammate, task, or scheduled
  work accounting; that belongs to `pane-active-while-subagent-runs`.
- We will NOT add generic terminal-output keyword scraping or a second badge
  state writer.
- We will NOT automatically send `continue`, retry prompts, or otherwise alter
  Claude's conversation as part of status recovery.
- We will NOT change Claude's user or project configuration outside the existing
  managed-hook boundary.
- We will NOT change session indexing, transcript search, session linking, or
  PTY ownership behavior except where required to observe this status contract.

## Scenarios (Acceptance Criteria)

- **Given** a Claude turn ends with a current-session, complete empty-work
  confirmation, **when** the completion event is received, **then** the pane is
  `idle` and is eligible for normal idle-suspension rules.

- **Given** a Claude tool result is the last observed turn activity and Claude
  returns to the input prompt without delivering the normal completion event,
  **when** the current-session `idle_prompt` notification becomes available,
  **then** the visible foreground status becomes `idle` if no known active or
  scheduled work is present, while automatic suspension remains blocked unless
  complete empty-work evidence is available.

- **Given** the user presses Escape during a Claude turn, **when** the matching
  provider idle notification carries the current session and turn identity,
  **then** the interrupt recovery produces `idle` exactly once for that
  session and turn.

- **Given** an `idle_prompt` notification lacks turn identity or carries only a
  session id, **when** it arrives after any current turn has started, **then**
  it does not recover the pane to `idle` and the pane remains protected.

- **Given** Claude has active background work or a scheduled wakeup, **when**
  the foreground turn ends, **then** the pane remains `working` and is not
  eligible for automatic suspension.

- **Given** Claude has no known active work but complete empty-work evidence
  is unavailable, **when** a valid current-turn `idle_prompt` arrives, **then**
  the visible foreground status is `idle` but the pane is not eligible for
  automatic suspension.

- **Given** a recovery signal reports incomplete, malformed, missing, stale, or
  conflicting identity/work evidence, **when** it is received, **then** the
  pane does not become `idle` and remains protected.

- **Given** a Stop hook is continuing the turn, **when** its status event is
  received, **then** the pane does not become `idle` until a later event proves
  that continuation has ended.

- **Given** the pane is `waiting` for permission or user input, **when** a
  delayed recovery signal arrives, **then** it remains `waiting` until the
  decision state is resolved.

- **Given** the pane is latched in `error`, **when** a delayed completion-like
  signal arrives, **then** it remains `error` until a new prompt or session
  lifecycle event establishes recovery.

- **Given** duplicate, delayed, or out-of-order events from an older turn,
  **when** they arrive after a newer turn has started, **then** they do not
  downgrade the newer foreground status.

- **Given** an `idle_prompt` notification from the previous turn is delayed
  until after a newer Claude prompt has been submitted, **when** that
  notification arrives, **then** it does not transition the newer turn to
  `idle`.

- **Given** Claude emits a newer or partially different payload shape,
  **when** the managed status path receives it, **then** the pane remains
  stable and fail-closed rather than crashing or claiming idle.

## Open Questions

None outstanding.

## Resolved Decisions

- The initial draft covers Claude foreground-turn recovery only. Background
  subagent/team tracking remains with `pane-active-while-subagent-runs`.
- Missed normal completions recover their visible foreground status through
  Claude's delayed `idle_prompt` notification, with an expected provider-bound
  latency of approximately one minute; no shorter recovery target is promised.
  Resolved by the auto-orchestrator blind subagent.
- Recovery remains hook-only for this iteration. A structured transcript
  observer, a new `stalled` presentation, and broader provider coverage remain
  follow-up options. Resolved by the auto-orchestrator blind subagent.
- Every idle_prompt recovery requires a matching current session and turn
  identity. A session-only or identity-missing idle_prompt is ignored for
  recovery, including after Escape, because it cannot be distinguished from a
  delayed notification from an older turn. Older provider versions therefore
  fail closed. Resolved by the auto-orchestrator blind subagent.
- Complete empty-work evidence is required for automatic suspension. When that
  evidence is missing or incomplete, a valid current-turn `idle_prompt` may
  clear the visible foreground `working` badge, but the pane remains protected.
  Resolved by the auto-orchestrator blind subagent.
- Visible foreground status and automatic suspension eligibility are separate
  dimensions for this recovery case: a recovered `idle` badge without complete
  empty-work evidence is not suspension-eligible. Resolved by the
  auto-orchestrator blind subagent.
- Active or known scheduled work keeps the visible status `working`; incomplete
  or ambiguous work evidence keeps suspension protected.
- The status must not use generic terminal quietness, fixed timers, process age,
  or keyword scraping as standalone proof of idle.

## Out-of-Scope Notes

The current Claude provider can leave hook consumers without a definitive
turn-complete event. This iteration accepts delayed visible foreground recovery
through `idle_prompt` while keeping automatic suspension gated by complete
empty-work evidence. A future fast recovery path or visible `stalled`/`unknown`
state would require a new contract decision.
