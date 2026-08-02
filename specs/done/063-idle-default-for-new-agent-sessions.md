# Spec: Idle Default for New Agent Sessions

<!--
This spec defines the user-visible lifecycle-state contract for agent sessions.
Repository-specific implementation details belong in the adjacent plan.
-->

Status: done
Created: 2026-08-02
Completed: 2026-08-02

## Problem

Agent sessions can currently appear with `status-unknown` while they are being
created, restored, resumed, or reinitialized. That state does not match the
session model: once an agent session exists, it is idle until it performs work
or reports another lifecycle state. The inconsistency is especially visible
when a pane is restored or a new session replaces an existing pane whose old
status was retained.

## Goal

Every newly created, restored, resumed, or reinitialized agent session starts
in the `idle` lifecycle state. `status-unknown` must not be used as the default
for an agent session merely because its first lifecycle event has not arrived.

## Users & Context

Users see agent lifecycle badges in pane headers and sidebar tabs while opening
the application, creating a session, resuming a saved session, switching tabs,
or retrying a session after a failure. The status should describe the session
that is present in the pane, not stale state from a previous session or a
temporary absence of an event.

## Requirements

1. MUST initialize every newly created agent session with lifecycle status
   `idle`, including sessions created in a new pane or tab.
2. MUST initialize every explicitly resumed agent session with lifecycle
   status `idle`, whether it resumes into an existing pane or a new tab.
3. MUST initialize every automatically resumed agent session with lifecycle
   status `idle` before or while runtime hydration restores it.
4. MUST initialize agent panes restored from saved application layout with
   lifecycle status `idle` when no current session state is available.
5. MUST reset an existing agent pane to `idle` when starting a new session in
   that pane, so the previous session's status cannot carry over.
6. MUST reset an existing agent pane to `idle` when retrying or re-resuming its
   session, so a stale status cannot carry over while the session is restored.
7. MUST ensure every presentation path for an agent pane uses `idle` as the
   initial fallback when no status object is present; an absent initial status
   MUST NOT render `status-unknown`.
8. MUST preserve subsequent lifecycle-event transitions: working, waiting,
   idle, and terminal-error states continue to reflect their corresponding
   fresh events after initialization.
9. MUST preserve the existing terminal-error latch and its defined clearing
   behavior; defaulting a new session to `idle` MUST NOT retain an error from a
   prior session.
10. MUST keep the disconnected visual indicator behavior independent from the
    lifecycle default: an unhydrated or PTY-less agent may display the
    disconnected icon while its underlying initial lifecycle state is `idle`.
11. MUST leave shell-pane status behavior unchanged, including the live-agent
    promotion path that derives its state from an observed agent process.
12. MUST cover every code path that can produce an initial agent pane state,
    including normal creation, saved-layout restore, explicit session-browser
    resume, resume into an existing pane, new-session replacement, hydration,
    and automatic idle-session resume.

## Non-Goals

- We will NOT change the meaning or ordering of lifecycle events after the
  initial state is established.
- We will NOT remove `status-unknown` as a possible diagnostic state when it
  represents a genuinely invalid or unsupported non-initial condition.
- We will NOT change when an agent is considered disconnected or alter the
  disconnected icon's visual precedence.
- We will NOT change shell-pane initialization or shell-to-agent promotion
  semantics.
- We will NOT change idle-session suspension policy beyond preventing an
  incorrectly unknown or stale initial status from being treated as the
  session's current state.

## Scenarios (Acceptance Criteria)

- **Given** the application restores a saved agent pane without a live PTY,
  **when** the layout is loaded before hydration, **then** the pane's lifecycle
  state is `idle` and the disconnected icon may be shown.

- **Given** a user creates a new agent pane, **when** the pane is first
  rendered, **then** its lifecycle state is `idle`, not `status-unknown`.

- **Given** a user resumes a saved session into an existing pane, **when** the
  resume begins, **then** the pane is `idle` and cannot display the previous
  session's working, waiting, or error state as its initial state.

- **Given** a user resumes a saved session in a new tab, **when** the tab and
  pane are created, **then** the pane is `idle` before runtime hydration
  completes.

- **Given** an idle session is automatically resumed after suspension,
  **when** its pane is rehydrated, **then** its initial lifecycle state is
  `idle` and it does not briefly become `status-unknown`.

- **Given** an existing agent pane is used to start a new session, **when** the
  old session is cleared and the new session starts, **then** the pane is
  `idle` rather than retaining the old status.

- **Given** an agent resume or new-session attempt fails, **when** the pane
  presents the retry state, **then** retrying resets the lifecycle state to
  `idle` before the replacement session runs.

- **Given** an initialized agent is `idle`, **when** it emits a fresh working,
  waiting, terminal-error, or idle event, **then** the corresponding status is
  shown and the existing reducer semantics remain intact.

- **Given** a live shell pane is promoted because an agent process is
  observed, **when** promotion occurs, **then** its existing observed-agent
  status remains unchanged by this defaulting rule.

- **Given** an unhydrated agent pane has no PTY, **when** its header and
  sidebar render, **then** the disconnected icon is shown without changing the
  underlying lifecycle state from `idle`.

## Open Questions

None outstanding.

## Resolved Decisions

- Every session-starting or session-restoring path uses `idle` as its initial
  lifecycle state because an existing session is logically idle until fresh
  work is observed.
- A missing initial status in an agent presentation is treated as `idle`, so
  rendering cannot expose an implementation-detail `status-unknown` state.
- The lifecycle state and disconnected icon are separate projections: a pane
  can be logically idle and visually disconnected until hydration attaches its
  runtime.

## Out-of-Scope Notes

If a future provider needs a third state for “not yet launched” that differs
from idle, it should be specified separately rather than reusing the initial
agent-session fallback.
