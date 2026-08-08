# Spec: Recoverable terminal-host failures and stale PTY state

Status: done
Created: 2026-08-07
Completed: 2026-08-07

## Problem

All shell and agent panes share one terminal-host process. When that process
fails, the live PTYs disappear together. The existing crash path can mark
already-spawned agent PTYs as exited, but it does not provide one consistent
failure contract for every affected pane.

In particular, a deferred or post-failure shell/agent launch can return a PTY
identifier even though no terminal process exists. The failure is then printed
as terminal text while the renderer keeps the dead identifier. Shell panes can
also retain stale identifiers after a host crash. These panes appear connected
or remain stuck without a retry action, and an attempted resume can consume the
only visible recovery affordance.

The incident disconnects live terminal processes; it does not by itself mean
that agent transcript files were deleted. However, stale runtime state and
phantom launch metadata can prevent the application from offering a reliable
resume path.

This is a follow-up to `pty-lifecycle-leaks-and-worker-crash-surfacing`, which
introduced crash fan-out but intentionally stopped short of end-to-end failed
spawn handling.

## Goal

Make terminal-host failure fail closed while recovering automatically when
possible: no pane may claim a live PTY after the host is unavailable, every
failed launch must be represented as a recoverable failure, and known agent
session identity must survive so the user can resume without restarting the
application unless recovery itself fails.

## Users & Context

Users may have several shell, Claude, Codex, or OpenCode panes across primary
and detached windows when the terminal host fails during startup, while a
deferred agent is waiting for its first size, during an active session, or
after the host has already become unavailable.

The behavior applies to all terminal creation and resume workflows that use
the shared terminal host. Ordinary per-process exits and clean application
shutdown are separate lifecycle events and must not be treated as host-wide
failure.

## Requirements

1. MUST classify an unexpected terminal-host exit or startup failure once per
   host failure, while excluding the normal application-shutdown path, and
   MUST attempt at most one automatic host recovery for that incident.
2. MUST transition every pane whose PTY was affected by the host failure to a
   no-live-process state. The pane MUST NOT retain or use the affected PTY
   identifier for input, resize, routing, or future persistence.
3. MUST apply the same fail-closed behavior to deferred launches and to launch
   requests made after the host is unavailable. A shell creation, new agent
   launch, or agent resume MUST NOT resolve as a successful live launch when no
   PTY was created.
4. MUST preserve an existing agent pane's `agentKind`, working directory, and
   known `sessionId` when its PTY is lost. After successful host recovery, the
   pane MUST automatically resume that known session exactly once.
5. MUST keep shell panes as shell panes after a host failure. After successful
   host recovery, affected shells MUST automatically recreate a shell at the
   saved working directory exactly once.
6. MUST prevent a failed new-agent launch from persisting a phantom session
   identity or an unfinished detection marker as though a new resumable agent
   process had successfully started.
7. MUST make recovery and retry behavior idempotent. Repeated host-failure
   notifications or repeated user retries MUST not create duplicate live PTYs,
   overwrite a newer PTY assignment, or erase an existing agent session
   identity.
8. MUST persist restart-safe pane state. After application restart, saved
   runtime PTY identifiers MUST not be treated as live; known agent sessions
   remain eligible for normal resume, and shell panes remain eligible for
   normal shell creation.
9. MUST show one global recovery status while automatic recovery is in progress
   and a clear per-pane no-live-process state. If automatic recovery fails, the
   global status MUST offer an explicit application-restart action while
   preserving all recoverable pane metadata.
10. MUST show a clear, actionable failure for an agent resume attempted while
   the host remains unavailable. The action MUST remain available for a known
   session and MUST NOT turn a failed resume into an apparently connected pane.
11. MUST keep host-failure handling consistent across primary and detached
   windows. A pane MUST have one authoritative connectivity state regardless
   of which window owns its renderer.
12. MUST record the host failure and its exit/startup code once per incident
   for local troubleshooting, without recording terminal contents, transcript
   text, credentials, or environment values.
13. MUST leave normal single-PTY exits unchanged: an ordinary agent exit
    affects only its pane, and a clean application shutdown MUST NOT surface as
    an unexpected host failure.

## Non-Goals

- We will NOT reattach an existing shell or agent process to a replacement PTY
  after its terminal host has died.
- We will NOT retry host recreation more than once automatically for the same
  incident.
- We will NOT change transcript formats, agent session indexing, session repair,
  or provider-specific session-linking semantics.
- We will NOT change the deferred first-size launch contract, terminal resize
  behavior, output flow-control policy, PATH construction, or agent launch
  commands.
- We will NOT mutate user or project agent configuration files.
- We will NOT infer a missing agent session ID from arbitrary terminal output.
- We will NOT add a second lifecycle/status source for agent badges.

## Scenarios (Acceptance Criteria)

- **Given** a shell pane and multiple agent panes have live PTYs, **when** the
  shared terminal host exits unexpectedly, **then** every affected pane loses
  its live PTY state, routes are released, agent panes retain their known
  session identities, no pane remains apparently connected, and the
  application begins one automatic host-recovery attempt.

- **Given** automatic host recovery succeeds, **when** recovery completes,
  **then** affected shell panes each receive one fresh shell at their saved
  directories, affected agents with known session IDs each receive one fresh
  resume PTY, and no old PTY identifier is reused.

- **Given** automatic host recovery fails, **when** the recovery attempt ends,
  **then** no pane remains in a connecting state, the global recovery status
  offers an application-restart action, and pane/session metadata remains
  available for restart recovery.

- **Given** the terminal host fails while an agent launch is waiting for its
  initial pane size, **when** the launch failure is delivered, **then** the
  pane does not receive a usable PTY identifier, does not remain in a permanent
  connecting state, and shows its supported recovery action.

- **Given** the terminal host has already failed, **when** the user starts a
  shell or requests a new agent session, **then** the request is visibly
  rejected as host-unavailable or held behind the active recovery state, no
  dead PTY identifier is assigned, and a subsequent retry after recovery does
  not create a phantom pane runtime.

- **Given** a new agent launch has not yet received a session ID when the host
  fails, **when** the layout is saved or the application restarts, **then** the
  pane is not matched to an unrelated session by cwd, time, or terminal text;
  it remains an explicit recovery placeholder with the existing start-new
  action.

- **Given** an agent pane has a known session ID and its PTY is lost, **when**
  the user selects resume, **then** the pane keeps the same session identity;
  if the host is unavailable the pane remains visibly recoverable rather than
  appearing connected or losing the resume action.

- **Given** a new agent launch fails before a resumable process is established,
  **when** the layout is saved and the application restarts, **then** startup
  does not attempt to resume a phantom new session or claim that launch
  succeeded.

- **Given** an agent pane's PTY is lost during a host failure, **when** the
  layout is saved or the application is restarted, **then** its existing
  `agentKind`, working directory, and known session ID remain available for
  normal recovery, subject to the existing session validation rules.

- **Given** a normal single PTY exits while the host remains healthy, **when**
  the exit is delivered, **then** only that pane enters its existing exit or
  disconnected state and unrelated panes remain live.

- **Given** the application is shutting down normally, **when** the terminal
  host exits as part of shutdown, **then** no unexpected-host-failure state or
  incident diagnostic is emitted.

- **Given** the same host failure is reported through more than one process
  event, **when** duplicate notifications arrive, **then** each affected pane
  transitions once and no duplicate recovery prompt or duplicate cleanup is
  produced.

- **Given** a pane is owned by a detached window, **when** the shared host
  fails, **then** the detached renderer and the primary renderer converge on
  the same no-live-process state without creating competing recovery attempts.

## Open Questions

None outstanding.

## Resolved Decisions

- This spec extends `pty-lifecycle-leaks-and-worker-crash-surfacing`; it does
  not replace its existing crash fan-out, clean-shutdown, or process-isolation
  invariants.
- The recovery contract covers all shared-host callers: shell creation, new
  agent launch, and agent resume. The host failure is global, so limiting the
  fix to agent panes would leave ordinary terminals in the same broken state.
- The application makes one automatic in-process host-recovery attempt. It
  recreates shell runtimes and resumes agents with known session IDs, but never
  reattaches to the dead PTYs. If that attempt fails, the user is explicitly
  directed to restart the application.
- A new-agent session identity or detection marker that cannot be shown to
  represent an established process is discarded rather than preserved as a
  phantom resumable session.
- The fix must fail closed rather than allowing a dead PTY identifier to be
  used as if it were live.
- Existing known agent session identity is valuable recovery data and must not
  be erased merely because its live PTY disappeared.
- Recovery must be represented in durable pane state and user-visible UI; a
  red error string in terminal scrollback alone is insufficient.

## Out-of-Scope Notes

- A future spec may define repeated or user-configurable terminal-host recovery
  attempts beyond the single automatic attempt in this spec.
- A future spec may add richer incident diagnostics or an application-level
  host-health indicator shared by all panes.
