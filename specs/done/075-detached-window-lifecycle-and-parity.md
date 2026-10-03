# Spec: Detached-window lifecycle and parity hardening

Status: done
Created: 2026-10-03
Completed: 2026-10-03

## Problem

Detached windows currently have the sidebar-first tab model, but their close
path is not a complete owner teardown boundary for live agent sessions. A
Codex tab can be torn into a detached window, the window can be closed, and a
later resume of the same transcript can be rejected by Codex as still active
in another window. This indicates that one or more of the detached window's
PTY, provider observer, process, connection, or ownership records can outlive
the native window or race the next resume.

The detached renderer also does not provide full window-local parity. In
particular, command-palette keyboard dispatch can run in a detached renderer
without producing a visible palette, and detached chrome hides controls that
are otherwise window-local. Other sidebar, pane, terminal, session, overlay,
IPC, and transfer behavior needs an evidence-based audit so intentional
main-window-only behavior is documented separately from broken behavior.

Initial lifecycle investigation found:

- native `BrowserWindow` close flows through `WindowManager` ownership and
  route cleanup, then asynchronously asks the session/provider layer to
  dispose observer state and the PTY;
- detached tabs are removed from the primary renderer through a close
  notification, while transcript files and session-index history are retained;
- Codex App Server observers subscribe/resume a thread and dispose by
  unsubscribing, closing the JSONL transport, and killing the sidecar, but the
  current cleanup has no session-level barrier for a later resume;
- detached chrome and several overlays are explicitly gated to the primary
  renderer even where the workflow can be window-local.

These observations are hypotheses to verify against executable tests and the
runtime reproduction; they are not a substitute for verification.

## Goal

Make detached-window close a complete, idempotent, race-safe lifecycle boundary
for every tab it owns, including Codex provider/runtime ownership, while
preserving transcript history for later resume. Bring confirmed window-local
functionality gaps to parity without restoring the top tab strip or changing
the sidebar-first detached-window model.

## Users & Context

Users who run live Claude, Codex, OpenCode, and shell panes in multiple
sidebar-owned windows. They may close a detached window directly, move or
return tabs between windows, and later resume a preserved session from the
primary window or Session Browser.

## Requirements

1. MUST close every tab owned by a detached window when that native window
   closes. Closing the window must not return, recreate, or leave those tabs
   visible in the primary sidebar.
2. MUST terminate every live shell/agent PTY and its child process owned by the
   closing detached window, including PTYs in a pending transfer or fitted
   destination state when that transfer is canceled by close.
3. MUST dispose every Codex observer/app-server transport, provider connection,
   active-session ownership record, lock/registration, and pending provider
   cleanup associated with the closed panes before a later resume of the same
   session is allowed to claim it.
4. MUST make detached-window cleanup idempotent and race-safe. Repeated native
   close/unregister notifications, late transfer acknowledgements, stale sync,
   provider callbacks, and concurrent close/resume requests must not resurrect
   ownership, reroute a dead PTY, duplicate a tab, or delete a newer owner.
5. MUST fail closed when required provider/PTY cleanup cannot be positively
   confirmed within its bounded cleanup policy: a later resume may wait for
   the cleanup barrier or return a recoverable error, but must not start a
   second live owner against an uncleared session.
6. MUST preserve transcript files, session-index history, session identity, and
   provider resumability. Cleanup must not fake completion, delete history, or
   mark a live conversation complete merely because its UI window closed.
7. MUST keep explicit transfer semantics distinct from close semantics:
   explicit move/return/absorb operations retain their existing ownership,
   PTY-routing, destination-commit, rollback, and generation safeguards;
   closing a detached window terminates its owned tabs instead of returning
   them.
8. MUST make Ctrl+Shift+P (or the configured command-palette shortcut) open a
   visible, focusable command palette in a detached window, and command
   execution must dispatch against that window's active tab and focused pane.
9. MUST audit window-local keyboard shortcuts and command dispatch in detached
   windows. A behavior is supported when it works in the detached renderer,
   intentionally main-window-only only when its global ownership/security
   requires the primary, and broken when the detached workflow is expected but
   fails; every classification must be recorded durably.
10. MUST audit and preserve or repair detached sidebar navigation, selection,
   reorder, close, move, return, pane focus, pane drag/drop, and pane/grid
   resizing without adding a top tab strip.
11. MUST audit and preserve or repair terminal input, resize, clipboard,
    context menu, title/CWD behavior, agent launch, status updates, session
    close, session refresh, and session resume in detached windows.
12. MUST audit settings, dialogs, and overlays for ownership and focus. Keep
    intentionally primary-owned settings/session-browser/Jira credential flows
    main-window-only, but repair any confirmed window-local overlay gap such as
    the command palette or directory picker.
13. MUST audit IPC listeners, event subscriptions, focus notifications, and
    renderer store cleanup. A closed detached window must not retain an active
    listener, connection registration, ownership row, focus target, sync claim,
    or cleanup callback that can affect a later session.
14. MUST preserve session indexing and resume validation behavior: closing a
    detached window may refresh/reconcile summaries, but must not remove the
    transcript or make a valid `(agentKind, sessionId, cwd)` resume invalid.
15. MUST add regression coverage for detached Codex close followed by a
    successful resume with no "active in another window" error; no orphaned
    Codex process/app-server connection/PTY route/stale renderer ownership;
    repeated cleanup; detached command-palette opening; representative sidebar
    navigation/tab movement; existing detached-close semantics; and terminal
    behavior.
16. MUST run and report `npm run typecheck`, `npm run test`, `npm run build`,
    `npm run test:e2e`, relevant focused tests, and git diff/status checks. The
    original failure must be reproduced or deterministically simulated against
    the pre-fix behavior, and the same regression scenario must be verified
    after the fix before claiming runtime success.

## Non-Goals

- We will NOT restore or add a top tab strip.
- We will NOT change the sidebar-first ownership rule: each window shows only
  its owned tabs and detached windows retain a sidebar.
- We will NOT make detached-window close return tabs to the primary window;
  explicit return remains a separate user action.
- We will NOT delete transcript/session history, mutate provider configuration,
  or fake provider completion to hide a close.
- We will NOT redesign the product around global cross-window settings,
  session-browser, or credential ownership; intentional main-only behavior may
  remain main-only when documented and verified.
- We will NOT replace the existing transfer infrastructure with a second tab
  movement protocol.
- We will NOT broaden the work to unrelated provider features, packaging,
  release, or external publishing.

## Scenarios (Acceptance Criteria)

- **Given** a Codex session is running in a tab owned by a detached window,
  **when** the detached native window is closed, **then** its tab, PTY, direct
  Codex process, observer/app-server connection, route, and ownership records
  are cleaned up, the primary has no stale row, and the transcript remains
  resumable.

- **Given** the detached Codex window close cleanup is invoked twice or races a
  late transfer/sync callback, **when** the callbacks complete, **then** only
  one cleanup occurs, no newer route/owner is overwritten, and no orphaned
  provider or PTY state remains.

- **Given** provider or PTY cleanup fails or exceeds its bounded policy,
  **when** the user attempts to resume the affected session, **then** resume
  waits for confirmed cleanup or returns a recoverable error and never creates
  a second live owner.

- **Given** the closed Codex transcript is still present and valid, **when** the
  user resumes it later from the primary window or Session Browser, **then**
  Codex starts normally without reporting that the conversation is active in
  another window.

- **Given** a detached window owns shell and agent tabs, **when** the native
  window closes, **then** all owned tabs close, all live child processes stop,
  no tab returns to the primary sidebar, and existing shell/terminal close
  semantics remain intact.

- **Given** a detached window is focused, **when** the user presses Ctrl+Shift+P
  or its configured equivalent, **then** a visible command palette opens in that
  window, receives focus, and commands act on that window's active tab/pane.

- **Given** a detached window has multiple owned tabs, **when** the user selects,
  reorders, closes, moves, or explicitly returns a tab from its sidebar,
  **then** the visible order and ownership change only through the existing
  guarded actions, with no duplicate or stale entry in either window.

- **Given** a pane is focused in a detached window, **when** the user types,
  resizes the pane, selects/copies text, opens its context menu, drags/splits it,
  or changes its title/CWD, **then** the behavior matches the primary window
  and output remains routed to the owning renderer.

- **Given** a detached agent pane launches, reports status, closes, refreshes
  sessions, or resumes, **when** each operation completes, **then** the pane
  state, status badge, session summary, and resume validation remain coherent
  and no primary-only assumption breaks the operation.

- **Given** settings, session-browser, Jira, directory-picker, or other overlay
  actions are invoked from a detached window, **when** the action is executed,
  **then** it either works as a window-local flow or is visibly and durably
  classified as intentionally main-window-only with a safe focus/return path.

- **Given** a detached window closes while IPC listeners, focus subscriptions,
  transfer tokens, sync timers, or renderer state are active, **when** a later
  window or session starts, **then** no closed-window event mutates the new
  owner or session.

## Open Questions

None outstanding.

Any routine implementation detail that cannot be learned from the repository
must use the least-surprising reversible default and be recorded in the plan;
the fail-closed cleanup-barrier decision above is the only consequential
decision resolved during brainstorming.

## Resolved Decisions

- Detached close is terminal for the window's owned tabs; explicit move/return
  remains distinct, preserving the decisions in `sidebar-first-tab-navigation`
  and `sidebar-tab-detach-and-cross-window-transfer`.
- Provider cleanup must preserve resumability and use the provider's supported
  disconnect/unsubscribe/abort/close path rather than fabricating completion.
- Cleanup failure is fail-closed: a resume barrier may delay or reject the
  next launch until ownership is unambiguous, resolved by the auto-orchestrator
  blind subagent because it prevents a second live provider owner and is
  reversible.
- The audit must classify every requested parity area as supported/working,
  intentionally main-window-only, or broken/repaired; the classification and
  remaining main-only behavior belong in the adjacent plan/evidence.

## Out-of-Scope Notes

This is a follow-up to the archived sidebar-first and detached-transfer work.
Do not rewrite archived spec 072 or alter its historical requirements.
