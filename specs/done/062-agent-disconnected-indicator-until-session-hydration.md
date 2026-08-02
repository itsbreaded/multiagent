# Spec: Show Agent Disconnected State Until Session Hydration

<!--
This follow-up closes the visual gap found after automatic idle suspension was
implemented. It describes observable status presentation, not implementation.
Related spec: automatic-idle-agent-session-suspension-and-seamless-resume.
-->

Status: done
Created: 2026-08-02
Completed: 2026-08-02

## Problem

Agent panes restored during application startup do not all receive a live PTY
immediately. Inactive tabs are intentionally hydrated later, but their Claude,
Codex, or OpenCode panes can currently display the seeded `idle` status while
their session is not connected or has not yet loaded. This makes an unloaded
session appear healthy and differs from the disconnected presentation used
after an unexpected exit or intentional suspension.

The application already needs an initial in-memory idle state for lifecycle
policy evaluation. That lifecycle default must not be confused with visual
connectivity: a pane without a live process should communicate that it is not
currently connected until hydration or resume establishes one.

## Goal

Make every supported agent pane without a live process show the shared hollow
grey disconnected indicator while it is disconnected or awaiting hydration,
including agent panes in inactive tabs during startup. Once a live session is
attached, restore the normal lifecycle status indicator without changing the
existing idle-state, hydration, recovery, or resume behavior.

## Users & Context

Users returning to an application with multiple project tabs, especially users
who leave Claude, Codex, or OpenCode sessions in inactive tabs while startup
restoration is still pending. Ordinary shell panes are not agent sessions and
are outside this behavior.

## Requirements

1. MUST show a supported agent pane's hollow grey disconnected circle in both
   the pane header and sidebar whenever that pane has no live process, including
   an agent pane restored during startup before its tab has been hydrated.
2. MUST use the shared `Disconnected` tooltip for this state and MUST NOT
   replace the icon with an `Offline` or `Disconnected` text label.
3. MUST preserve the existing in-memory initial `idle` lifecycle state needed
   by the automatic idle policy. The visual disconnected indicator MUST take
   precedence over the idle color while the pane has no live process, without
   making the no-PTY pane eligible for suspension.
4. MUST change back to the normal lifecycle status indicator as soon as the
   pane has a live PTY and lifecycle status, whether that PTY is created by
   startup hydration, tab activation, explicit resume, or a new session.
5. MUST keep a pane visually disconnected when hydration or resume cannot
   establish a live process, while retaining the existing recoverable error or
   disconnected-session actions. The visual state MUST NOT itself open a
   disruptive dialog or trigger an automatic resume.
6. MUST apply the same presentation to unexpectedly disconnected and
   intentionally policy-suspended agent panes; the distinction remains in the
   existing lifecycle/recovery state rather than a different icon.
7. MUST NOT change status presentation or hydration behavior for ordinary shell
   panes.
8. MUST cover inactive-tab startup restoration: an agent pane in an inactive
   tab that has not loaded MUST show disconnected until its tab is activated and
   its session is attached.

## Non-Goals

- We will NOT change the automatic idle suspension policy, timeout, or resume
  rules.
- We will NOT remove or delay the initial in-memory idle state.
- We will NOT make inactive tabs hydrate earlier solely to change the icon.
- We will NOT add a new user-facing status label, notification, or dialog.
- We will NOT change ordinary shell-pane icons or lifecycle behavior.
- We will NOT delete, recreate, or alter the saved agent session as part of
  changing its presentation.

## Scenarios (Acceptance Criteria)

- **Given** the application restores an agent pane in an inactive tab,
  **when** that tab has not yet hydrated and the pane has no live PTY,
  **then** the pane header and sidebar show the hollow grey circle with the
  `Disconnected` tooltip instead of the normal idle-colored dot.

- **Given** a restored agent pane has the initial in-memory `idle` lifecycle
  state but no live PTY, **when** its status is rendered, **then** it retains
  that lifecycle state for later use while its visual status is disconnected
  and it is not eligible for suspension until a live PTY exists.

- **Given** an inactive-tab agent is later activated, **when** hydration creates
  and attaches its PTY, **then** the disconnected icon is replaced by the
  normal lifecycle status indicator.

- **Given** hydration or resume fails, **when** the pane is displayed, **then**
  it continues to show the disconnected icon, retains its metadata and
  recoverable actions, and does not show a new disruptive dialog solely because
  it was not loaded.

- **Given** an agent exits unexpectedly or is intentionally policy-suspended,
  **when** its pane is shown in the header or sidebar, **then** both use the
  same hollow grey circle and `Disconnected` tooltip as an unhydrated pane.

- **Given** a shell pane has no live PTY, **when** its pane is shown, **then**
  its existing shell presentation is unchanged.

- **Given** a saved layout contains agent panes across active and inactive
  tabs, **when** application startup restoration is in progress, **then** all
  no-PTY agent panes show disconnected until their own live session is
  attached, without forcing inactive tabs to hydrate early.

## Open Questions

None outstanding.

## Resolved Decisions

- Visual connectivity is determined separately from lifecycle status: the
  initial `idle` value remains an in-memory policy default, while a missing live
  PTY renders as disconnected.
- The scope is all supported agent panes in both shared visual surfaces—the
  pane header and sidebar—including startup-unhydrated, unexpectedly
  disconnected, and intentionally suspended panes. Ordinary shells remain
  excluded.
- Existing hydration, resume, recovery, and automatic-suspension behavior is
  unchanged; this spec changes only the status presentation and its tests.
- The shared hollow-grey circle and `Disconnected` tooltip remain the sole
  presentation for no-live-process agent panes; no additional status label is
  introduced.

## Out-of-Scope Notes

- A future iteration could add a distinct tooltip explaining `Loading` versus
  `Disconnected`, but this iteration intentionally keeps one shared visual
  treatment.
