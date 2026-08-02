# Spec: Automatic Idle Agent Session Suspension and Seamless Resume

<!--
This is a fresh behavioral contract for the idle-session lifecycle. It
deliberately describes observable behavior and does not prescribe an
implementation.
-->

Status: draft
Created: 2026-08-01
Completed:

## Problem

Claude, Codex, and OpenCode sessions can remain alive in tabs that a user has
stopped using. Each live external agent consumes memory and other resources,
so keeping many project tabs open can leave a large collection of unused
processes running until the application or individual panes are closed.

The application must be able to release resources from genuinely idle agent
sessions without losing the pane, session history, or the user's place. The
release must also be safe: a session that is still working, waiting for input,
or otherwise not known to be idle must not be interrupted. When the user
returns, the session should resume as naturally as it does during application
startup rather than appearing to have failed.

## Goal

Provide an opt-in, configurable policy that suspends only truly idle agent
sessions in unfocused tabs, preserves their resumable state, and automatically
restores the exact session when the user returns. The behavior should reduce
resource use while making suspension and resume feel like a normal lifecycle,
not an error.

## Users & Context

Users who keep several project tabs or detached windows open while working on
one task and expect to return to the others later. The policy applies to
Claude, Codex, and OpenCode sessions, whether the session was started by the
application or was detected and linked after being started in a shell pane.
Ordinary shell panes are not agent sessions and are not targets.

## Requirements

1. MUST provide a persisted setting that enables or disables automatic idle
   agent-session suspension. The default for new or missing settings MUST be
   disabled so existing users explicitly opt in.
2. MUST provide a persisted timeout in whole minutes from 1 through 1,440
   minutes. The shipped default MUST be 30 minutes.
3. MUST apply the setting to currently open tabs as well as tabs opened later.
   Enabling the policy, changing its timeout, or re-enabling it MUST take
   effect without requiring the user to restart the application or manually
   close and reopen tabs. When the policy is enabled or its timeout is
   changed, any known inactivity accumulated before that change MUST count
   toward the new timeout; an already-eligible session MAY be suspended at the
   next evaluation rather than waiting for a new full interval. If the
   application's prior focus state is unavailable, it MUST start measuring
   that tab from the change instead of guessing.
4. MUST consider a tab unfocused when it is not the active tab in its owning
   window, or when its owning window is not the operating-system-focused
   window. This MUST include detached windows.
5. MUST measure inactivity independently for each tab. Activity or focus in
   one tab MUST NOT reset the inactivity period of another tab.
6. MUST suspend a connected supported-agent session only when all of the
   following are true:
   - the policy is enabled;
   - the session's tab has remained unfocused for at least the configured
     timeout;
   - the session is explicitly known to be idle; and
   - the application has enough session identity to resume that exact session.
7. MUST protect a session from automatic suspension whenever it is working,
   in progress, waiting for permission or user input, reporting an error, has
   an unknown or missing status, or otherwise cannot be proven idle.
8. MUST base eligibility on the session's current lifecycle state, not merely
   on an old transcript, a quiet terminal, low visible activity, or an absence
   of recent output. A long-running background task MUST remain connected until
   it is explicitly idle.
9. MUST continue evaluating protected sessions after their status changes. If
   a tab has already exceeded the timeout, a session that later becomes
   explicitly idle MUST become eligible without requiring the user to switch
   tabs.
10. Newly started and restored agent panes MUST have a usable initial idle
    state rather than remaining permanently in an unknown state. As soon as
    live lifecycle information reports working, waiting, error, or another
    protected state, that state MUST take precedence and protect the session.
11. When suspension occurs, MUST end the live agent session in a graceful,
    resumable way. The pane MUST remain responsive and capable of starting the
    exact saved session again; ending an external process in a way that leaves
    a frozen, permanently unusable pane does not satisfy this requirement.
12. MUST preserve the tab, pane position and layout, provider, working
    directory, session identity, transcript/history, and any other information
    needed to resume the exact session.
13. MUST not delete the agent session, transcript, tab, or pane as a result of
    automatic suspension.
14. MUST not show a notification, toast, confirmation prompt, or disruptive
    error dialog when an intentional idle suspension occurs.
15. While an agent pane is intentionally suspended, the pane and its status
    presentation MUST use the same normal startup/resuming experience used for
    restoring an agent pane. It MUST not display an “Agent session
    disconnected” message or require the user to click “Resume session.”
16. When the user activates a tab containing an intentionally suspended agent,
    the application MUST automatically resume the exact prior session. The
    same MUST happen when the tab is already active but its owning window
    regains operating-system focus.
17. The application MUST NOT automatically resume an intentionally suspended
    session while its tab or owning window remains unfocused.
18. Repeated focus, activation, or state updates MUST NOT create duplicate
    resume attempts for the same pane while a resume is already in progress.
19. If automatic resume fails, MUST keep the pane and session metadata intact
    and present a recoverable state with the applicable options to retry,
    repair the working directory, start a new session, or close the pane. The
    pane MUST remain usable rather than becoming frozen.
20. A session that exits unexpectedly for a reason other than the idle policy
    MUST retain the existing disconnected-session recovery behavior and MUST
    not be silently treated as an intentional suspension.
21. Disabling the policy MUST prevent future automatic suspensions but MUST
    not reconnect sessions that were already suspended. Already suspended
    panes MUST remain available for normal automatic or explicit resume when
    the user returns.
22. Invalid, missing, non-finite, or out-of-range persisted setting values
    MUST be replaced with safe valid values, and loading them MUST not make the
    application unusable.
23. If a suspension attempt cannot complete, the application MUST leave the
    pane and resumable session intact and MUST not repeatedly retry in a way
    that creates duplicate work or disrupts the user.
24. A pane whose session identity is unavailable MUST remain connected rather
    than being suspended automatically, because the application cannot promise
    exact resume.
25. Agent panes without a live process, including intentionally suspended
    panes and unexpectedly disconnected panes, MUST use a hollow grey circle as
    their disconnected status icon. They MUST NOT use a textual “Offline” or
    “Disconnected” status label in place of that icon.

## Non-Goals

- We will NOT delete sessions, transcripts, history, tabs, or panes.
- We will NOT automatically suspend ordinary shell panes.
- We will NOT interrupt a session based only on memory pressure, terminal
  quietness, transcript age, or process age.
- We will NOT add per-pane scheduling, a memory dashboard, or a separate bulk
  session-management workflow in this iteration.
- We will NOT automatically resume sessions that lack enough identity to
  identify the exact prior session.
- We will NOT add notifications or confirmation prompts for normal automatic
  suspension and resume.
- We will NOT change provider configuration or the existing manual close,
  repair, new-session, or explicit resume workflows beyond what is necessary
  for this lifecycle.

## Scenarios (Acceptance Criteria)

- **Given** the policy is disabled, **when** an idle Claude, Codex, or OpenCode
  session remains in an unfocused tab beyond the configured timeout, **then**
  the session remains connected.

- **Given** the policy is enabled and an explicitly idle linked agent is in an
  unfocused tab, **when** the tab reaches the configured timeout, **then** the
  live session ends gracefully, the pane remains in the same layout, and the
  session remains resumable.

- **Given** an unfocused tab contains idle Claude, Codex, and OpenCode panes,
  **when** the timeout is reached, **then** every eligible pane is suspended
  independently and remains in its original tab.

- **Given** an agent is working or performing a long-running task in an
  unfocused tab, **when** the timeout is reached, **then** the session remains
  connected and the task is not interrupted.

- **Given** an agent is waiting for permission or user input, **when** the
  timeout is reached, **then** the session remains connected.

- **Given** an agent has unknown, missing, or error status, **when** the timeout
  is reached, **then** the session remains connected because the application
  cannot prove that suspension is safe.

- **Given** an agent was protected while working, **when** it later reports an
  explicit idle state in a tab already past the timeout, **then** it becomes
  eligible for suspension without requiring a tab switch.

- **Given** an agent pane has no usable session identity, **when** its tab
  reaches the timeout even though it appears idle, **then** it remains
  connected.

- **Given** a user enables the policy while an eligible idle session is already
  in an unfocused tab, **when** the setting is saved, **then** the current
  timeout policy is applied to that tab without an application restart, and
  any known time already spent unfocused counts toward the timeout.

- **Given** a tab has been unfocused longer than the newly configured timeout,
  **when** the user enables the policy or reduces the timeout, **then** an
  eligible idle session in that tab may be suspended at the next evaluation
  without waiting through another full timeout interval.

- **Given** a tab has been inactive for nearly the full timeout, **when** the
  user focuses it, **then** it is not suspended and a new inactivity period
  begins when it becomes unfocused again.

- **Given** one tab remains active while another tab exceeds the timeout,
  **when** the policy evaluates both tabs, **then** only eligible sessions in
  the inactive tab are suspended.

- **Given** an active tab belongs to a detached window that is not
  OS-focused, **when** the timeout elapses, **then** eligible idle sessions in
  that tab may be suspended.

- **Given** an idle session has been automatically suspended, **when** the
  user returns to its tab, **then** the pane shows the normal startup/resuming
  state, automatically resumes the exact session, and never shows the
  “Agent session disconnected” dialog.

- **Given** an idle session has been suspended in the active tab of an
  unfocused window, **when** that window regains OS focus, **then** the exact
  session resumes automatically.

- **Given** a suspended pane remains in an inactive tab, **when** additional
  timeout checks occur, **then** it remains suspended and no resume attempt is
  made.

- **Given** focus events arrive repeatedly while a suspended pane is resuming,
  **when** each event is processed, **then** only one resume attempt is active
  for that pane.

- **Given** automatic resume fails, **when** the failure is shown, **then** the
  pane remains present and responsive, the exact session metadata is retained,
  and the user can retry, repair, start a new session, or close the pane as
  applicable.

- **Given** an agent process exits unexpectedly rather than through the idle
  policy, **when** the exit is detected, **then** the existing disconnected
  recovery presentation remains available.

- **Given** an agent pane is intentionally suspended or otherwise has no live
  process, **when** its status is shown in the pane header or sidebar, **then**
  it uses a hollow grey circle and does not display an “Offline” or
  “Disconnected” text label.

- **Given** the application is started or a saved agent pane is restored,
  **when** it is initialized before fresh lifecycle events arrive, **then** it
  has an initial idle state and can participate in the configured policy;
  **when** live events report that it is working or waiting, **then** it is
  protected immediately.

- **Given** an actual external agent session is started in the application,
  **when** it becomes idle, is suspended by the policy, and the user returns,
  **then** an end-to-end check can observe that the original live process has
  ended, the pane is still usable, and the exact session starts again. A test
  that only force-kills a process and observes a frozen pane does not satisfy
  this scenario.

## Open Questions

- [ ] When a tab contains several suspended agent panes, should all suspended
  panes resume automatically when the tab returns, or only the focused/visible
  pane? The proposed default is to resume all panes in that tab.
- [ ] If the user leaves the tab while automatic resume is starting, should an
  already-started resume finish, or should it be cancelled before the agent
  process starts? The proposed default is to let an already-started resume
  finish.
- [ ] After application restart, should only the active tab resume immediately
  while suspended sessions in inactive tabs remain suspended until opened? The
  proposed default is to resume only the active tab.
- [ ] Should manually closed or manually disconnected sessions ever be resumed
  automatically, or should automatic resume apply only to sessions suspended
  by this policy? The proposed default is policy-suspended sessions only.
- [ ] Should an unexpected agent crash retain the existing recovery dialog while
  only policy suspensions use seamless resume? The proposed default is yes.
- [ ] If the exact session cannot be resumed because its transcript or working
  directory is missing, should the application offer recovery actions without
  silently starting a replacement session? The proposed default is never to
  silently replace the session.
- [ ] When a restored session has not yet produced a lifecycle event, should it
  be treated as idle immediately, or remain protected until the first status
  event arrives? Treating it as idle enables cleanup; waiting for confirmation
  is safer against interrupting work that began before observation.
- [ ] Should sessions waiting for permission or user input remain protected
  indefinitely, even if they stay in the background for hours? The proposed
  default is yes.
- [ ] Should minimized windows, locked workstations, and switching to another
  desktop count as unfocused and allow idle suspension? The proposed default is
  yes.
- [ ] If many idle sessions become eligible at once, should they all suspend or
  resume together, or should automatic work be staggered to avoid a temporary
  CPU or memory spike? The proposed default is to suspend all eligible sessions
  and limit simultaneous automatic resumes.
- [ ] For the hollow grey circle, should its tooltip say “Suspended” for
  policy-suspended sessions and “Disconnected” for unexpected exits, or should
  both use the same tooltip?
- [ ] Should the first version provide a per-pane “Never suspend this session”
  exemption, or is a single global setting sufficient? The proposed default is
  a global setting only.

## Resolved Decisions

- This is one feature contract covering configurable idle suspension and the
  automatic resume experience; it is not split into separate resource and UI
  specs.
- Supported agent sessions include Claude, Codex, and OpenCode, including
  sessions linked from shell panes. Ordinary shell panes remain excluded.
- Only an explicit idle state is proposed as eligible. Working, waiting, error,
  unknown, missing status, and missing session identity are proposed as
  protected pending confirmation of the open questions above.
- The timeout is measured per tab, and a tab is inactive when either its tab
  is not selected or its owning window is not OS-focused.
- The shipped policy is disabled by default with a 30-minute timeout and a
  valid range of 1 through 1,440 minutes.
- Known inactivity counts when the policy is enabled or its timeout changes;
  this makes an explicitly chosen setting effective immediately for sessions
  that have already exceeded the new threshold. When prior focus state is not
  known, the application starts measuring from the setting change rather than
  making an unsafe assumption.
- Intentional idle suspension is proposed to be visually distinct from an
  unexpected exit: it uses the startup/resume experience and automatically
  resumes on return; unexpected exits retain recovery UI. This remains subject
  to confirmation above.
- Intentional suspension preserves the pane and exact session rather than
  deleting or recreating them.
- The disconnected state uses a hollow grey circle without an Offline or
  Disconnected text label.

## Out-of-Scope Notes

- A future iteration could offer a per-pane “never suspend” control or
  provider-specific exclusions.
- A future iteration could expose manual bulk suspension and resource usage
  summaries.
- A future iteration could add a quieter, explicit “suspended” tooltip or
  history entry if users need to distinguish intentional suspension from an
  unexpected exit without adding a text status label.
