# Spec: Keep a Claude Pane Active While a Background Subagent Runs

Status: review <!-- draft | ready | in-progress | review | done -->
Created: 2026-08-10
Completed: <!-- date when moved to specs/done/ -->

## Problem

When a Claude agent pane spawns a **background** subagent (the Agent tool with
`run_in_background`), the parent agent's turn ends and returns control to the
user. The managed lifecycle hook therefore fires `Stop`, and the lifecycle
reducer (`eventToState`, spec 032) sets the pane's status to `idle` — even though
the background subagent is still running inside the same Claude process.

Two consequences follow, both wrong:

1. **Misleading badge.** The pane header and sidebar show an idle-colored dot
   while a background subagent is actively working. The status no longer
   describes the session that is present in the pane.

2. **Unsafe suspension.** The automatic idle-agent-suspension policy (spec 061)
   keys eligibility off `agentStatus.status === 'idle'`
   (`isIdleAgentSuspensionEligible`). A pane that is *actually* running a
   long-lived background subagent can therefore be suspended (the live session
   ended gracefully) after the configured timeout in an unfocused tab. Ending
   that session kills the still-running background subagent. This directly
   violates spec 061 requirement 8: "A long-running background task MUST remain
   connected until it is explicitly idle."

The root cause is a gap in the v1 lifecycle state machine: subagent events were
deliberately excluded (`agentSessionReportServer.ts` — "NO subagent_* (out of
scope for v1)"), and the `Notification` hook is subscribed only for the
`permission_prompt` matcher, so no signal currently distinguishes "idle, no
work pending" from "idle, a background subagent is still running."

Claude Code does expose subagent lifecycle hooks (`SubagentStop`, plus the
`Notification` `agent_completed` matcher) and a background-launch indicator
(`PostToolUse` on the Agent tool with `status: "async_launched"`), but their
firing for *background* subagents is version-dependent and has had upstream
inconsistencies (`SubagentStart` does not fire for background
[#44075](https://github.com/anthropics/claude-code/issues/44075); the parent
`Stop` can incorrectly fire on background completion
[#24421](https://github.com/anthropics/claude-code/issues/24421)). The
implementation must therefore spike-verify the chosen signal (see Requirements)
and, by design, fail safe in the over-protective direction when a signal is
missed.

Foreground subagents are **not** affected: the parent's turn stays open (it
blocks on the Agent tool call), so no `Stop` fires and the pane correctly
remains `working` until the subagent returns. Codex is also not affected: it
already reports idle only once its subagent has finished.

## Goal

A Claude pane that has one or more active background subagents must not be
reported as `idle` and must not be eligible for automatic idle suspension. It
must remain in the existing `working` lifecycle state until every background
subagent has finished, then revert to the normal lifecycle flow.

## Users & Context

Users who spawn background subagents (long-running searches, reviews, waits)
and switch tabs or windows while they run, expecting the parent pane to remain
alive and the subagent to complete. The behavior applies to **Claude** agent
panes only. Foreground subagents, shell panes, Codex, and OpenCode are outside
this spec.

## Requirements

1. MUST NOT report a Claude pane as `idle` while it has one or more active
   background subagents.
2. MUST treat such a pane as `working` for both the status badge and idle-
   suspension eligibility, so the pane is protected from automatic suspension
   while a background subagent runs.
3. MUST revert to the normal lifecycle state once every background subagent has
   finished (no active subagents remain), following the existing `Stop` →
   `idle` semantics and subsequent lifecycle events.
4. MUST base active-background-subagent detection on fresh lifecycle signals
   attributed to the pane's session — not on terminal quietness, an absence of
   recent output, transcript age, or process age.
5. MUST preserve the existing reducer precedence: an active background
   subagent overrides `idle`, but a higher-signal state (`error`, the
   `terminal_error` latch, `waiting`/permission) still takes precedence per the
   current `eventToState` rules. When that higher-signal state clears and a
   background subagent is still active, the pane MUST return to `working`.
6. MUST count active background subagents per pane. Multiple concurrent
   background subagents MUST keep the pane `working` until **all** have
   finished; a single completion MUST NOT flip the pane to `idle` while others
   remain active.
7. MUST clear the in-memory active-subagent count on process/PTY exit
   (`demote`) and on a fresh `session_start`, so a dead or restarted session
   cannot remain permanently `working`. A `user_prompt_submit` (a new turn)
   MUST NOT clear the count, so background subagents still running across
   turns keep the pane protected.
8. MUST fail safe in the over-protective direction: if a subagent-completion
   signal is not delivered, the pane MUST remain `working` (and thus protected
   from suspension) until the agent process exits or a new session starts,
   rather than risk a false `idle` that could trigger suspension. A stuck
   `working` badge is the acceptable failure mode, consistent with spec 032; a
   false `idle` that suspends a busy pane is not.
9. Before relying on a subagent-completion signal, MUST verify against the
   target Claude Code version that it fires for background subagents in our
   embedded-PTY context. If it does not fire reliably, the over-protective
   fallback (requirement 8) applies; the pane MUST NOT be declared `idle`
   while a background subagent's completion is unconfirmed.
10. MUST keep active-subagent tracking in memory only; it MUST NOT be persisted
    to layout or settings. On application restart, a pane has no carried-over
    active subagents and initializes per the existing idle-default (spec 063).
11. MUST NOT change behavior for foreground subagents (the parent turn already
    stays open and the pane already reads `working`).
12. MUST NOT change Codex or OpenCode status or suspension behavior.
13. MUST NOT introduce a new user-facing status label, badge shape, dialog, or
    notification for this state; it reuses the existing `working` presentation.
    The tooltip detail MAY indicate a subagent is running, but no new status
    category is added.
14. MUST preserve all existing lifecycle-event transitions, the terminal-error
    latch and its clearing behavior, and the disconnected-icon precedence
    (spec 062).

## Non-Goals

- We will NOT add a distinct "subagent running" badge, label, or color.
- We will NOT change the idle-suspension policy timeout, default, resume rules,
  or the `idle` default for new sessions (spec 063).
- We will NOT change foreground-subagent handling.
- We will NOT change Codex or OpenCode status/suspension behavior.
- We will NOT track or surface subagent internals (which tools a subagent
  calls, its progress, token use, or identity) in the UI.
- We will NOT add per-pane or per-subagent scheduling, dashboards, or bulk
  controls.

## Scenarios (Acceptance Criteria)

- **Given** a Claude pane has spawned one background subagent and returned
  control to the user, **when** the pane's status is rendered, **then** it
  shows `working` (not `idle`) and is not eligible for idle suspension.

- **Given** a Claude pane has an active background subagent and its tab is
  unfocused past the configured timeout, **when** the idle policy evaluates the
  pane, **then** the pane remains connected and is not suspended.

- **Given** a background subagent finishes, **when** its completion signal is
  processed, **then** the pane returns to the normal `idle` state (per the
  existing `Stop` semantics) and becomes eligible for suspension again only
  under the normal rules.

- **Given** a pane has multiple concurrent background subagents, **when** one
  finishes but others remain active, **then** the pane stays `working` until
  the last background subagent finishes.

- **Given** a pane has an active background subagent and a `permission_request`
  arrives (a background subagent surfaced a permission prompt in the main
  session), **when** it is processed, **then** `waiting` takes precedence and is
  shown; **when** the prompt is resolved while a subagent is still active,
  **then** the pane returns to `working`.

- **Given** a pane has an active background subagent and a `terminal_error` is
  latched, **when** the latch is in effect, **then** the error state takes
  precedence and is shown per the existing latch rules; the active-subagent
  override resumes only after a legitimate clear (`user_prompt_submit` /
  `session_start` / `demote`) if a subagent is still active.

- **Given** a completion signal is never delivered for a background subagent,
  **when** the pane is evaluated, **then** it remains `working` (protected
  from suspension) rather than dropping to `idle`; **when** the agent process
  later exits (`demote`) or a fresh `session_start` arrives, **then** the
  active-subagent state is cleared. A new `user_prompt_submit` does NOT clear
  the count while a subagent is still active.

- **Given** the available completion signal is empirically unreliable on the
  target Claude Code version, **when** a background subagent finishes without
  a delivered signal, **then** the pane stays `working` until the process
  exits or a new session starts (over-protective), and is never suspended on a
  false `idle`.

- **Given** the application restarts with a pane that had an active background
  subagent before shutdown, **when** the pane is restored, **then** it has no
  carried-over active-subagent state and initializes per the existing
  idle-default (spec 063), with the disconnected icon until hydration (spec
  062).

- **Given** a Claude pane spawns a **foreground** subagent, **when** the
  subagent runs and returns, **then** the pane's status is unchanged from
  today (it stays `working` because the parent turn never ended).

- **Given** a Codex or OpenCode pane spawns a subagent, **when** it runs and
  finishes, **then** its status and suspension behavior are unchanged.

## Open Questions

None outstanding.


## Resolved Decisions

- **Scope is Claude only.** Codex already reports idle only when its subagent
  finishes (no bug observed); OpenCode's subagent hook surface is unknown.
  Foreground subagents are out of scope because the parent turn stays open and
  the pane is already `working`. (User-confirmed.)
- **Presentation reuses the existing `working` state.** No new badge, label,
  color, or dialog is added; a subagent tooltip detail is optional.
  (User-confirmed.)
- **One cohesive concern.** Badge display and suspension-eligibility both flow
  from the lifecycle state, so a single spec governs both. The suspension
  protection is a consequence of the pane not being `idle`, not a separate
  rule.
- **Active-subagent detection sources the agent's own lifecycle signals.** A
  background launch is indicated by the subagent tool's launch-completion event
  (`PostToolUse` on the Agent/Task tool reporting an async/background launch),
  and completion by the subagent-completion hook (`SubagentStop`) and/or the
  `Notification` `agent_completed` matcher. `SubagentStart` is NOT used (it
  does not fire for background subagents,
  [#44075](https://github.com/anthropics/claude-code/issues/44075)). The exact
  signal set is confirmed by a plan spike against the target Claude Code
  version; the design fails safe (over-protective) if a completion signal is
  missed.
- **Events attribute to the parent pane.** Subagent lifecycle hooks and
  `Notification` events fire in the parent Claude process and inherit the
  pane's `MULTIAGENT_*` env from spec 047, so they report the parent pane's
  `ptyId`. The plan spike confirms this holds for background subagents.
- **No new trust UX for Claude.** Claude has no hook trust gate (unlike
  Codex), so adding subagent/`Notification` matchers extends the existing
  managed-hook marked-block install in `~/.claude/settings.json` (spec
  032/047) with no new trust step.
- **Fail-safe direction is over-protection.** A stuck `working` badge (missed
  completion signal) is the acceptable failure mode, consistent with spec 032; a
  false `idle` that suspends a busy pane is not. This mirrors spec 061's
  "cannot be proven idle → protected" principle.
- **Active-subagent tracking is in memory only.** Nothing is persisted; a
  restarted pane starts with no active subagents, so no stuck-`working` state
  can survive a restart. Process exit / fresh session start clear the count.
- **Higher-signal states still win.** An active background subagent overrides
  `idle` only; `error`, the `terminal_error` latch, and `waiting` keep their
  existing precedence and re-arm `working` when they clear.

## Out-of-Scope Notes

- A future iteration could add a distinct "subagent running" tooltip or badge
  if users need to distinguish it from ordinary `working` activity.
- A future iteration could extend this to Codex/OpenCode if/when their
  subagent hook surfaces exist.
- A future iteration could surface the count or identity of active background
  subagents in the UI.
