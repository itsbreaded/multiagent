# Spec: Provider CLI availability for new sessions

Status: done
Created: 2026-07-27
Completed: 2026-07-27

## Problem

MultiAgent offers its supported coding-agent CLIs (Claude Code, Codex,
OpenCode) when a user starts a new agent session, even if the corresponding
CLI executable is not installed or is unavailable on the application's PATH.
Choosing such an option creates a session that cannot launch. The existing
per-provider `Enabled` checkbox is saved and controls the provider
configuration card (and the routing env injected into that provider's panes),
but it does not control whether that provider can be selected to start a new
session. Today's entry points are also inconsistent about which providers they
surface: the spawn/split menu and the command palette list all three, while
the empty-workspace quick-start lists only Claude Code and Codex.

## Goal

Only providers that are both available on startup and enabled by the user can
be offered for new agent sessions. Settings must clearly explain when a CLI is
unavailable and prevent an unavailable provider from being enabled, without
silently re-enabling a provider later.

## Users & Context

Developers who use MultiAgent with some, but not necessarily all, of its
supported coding-agent CLIs installed. They configure providers in Settings
and start new agent panes from the application's session-start controls.

## Requirements

1. On each application startup, MultiAgent MUST determine whether each
   supported provider CLI (Claude Code, Codex, and OpenCode) is resolvable on
   the PATH available to app-launched sessions.
2. If a provider CLI is not detected at startup, MultiAgent MUST set that
   provider's saved `Enabled` setting to disabled and MUST NOT offer it as a
   choice for starting a new agent session during that app run, through any
   entry point.
3. The startup availability check MUST only disable providers. A later startup
   that detects an installed CLI MUST NOT automatically enable a provider that
   was previously disabled, whether by the user or by an earlier failed
   detection.
4. A provider that is detected but manually disabled by the user MUST remain
   hidden from new-session choices. Users MAY disable an available provider by
   clearing its `Enabled` checkbox.
5. A provider that is detected and enabled MUST remain available to start new
   agent sessions, with its existing provider configuration behavior unchanged.
6. The enabled-and-detected rule MUST be applied consistently to every
   new-agent entry point: the command palette; shared spawn/split menus in
   the pane header and project sidebar; the empty-workspace quick-start and
   directory-picker actions; and any future UI or programmatic session-start
   path. Every new-agent entry point MUST derive the providers it offers from
   one shared detected-and-enabled set, rather than a per-entry-point hardcoded
   list, so no provider is silently offered where it cannot launch or silently
   omitted where it can. No entry point may create a new agent session for a
   provider that is disabled or unavailable.
7. Settings MUST show an inline red availability warning beside the name of
   every provider whose CLI was not detected. The warning MUST make clear that
   the CLI was not found on PATH and that the provider cannot be enabled until
   it is available; it MUST NOT be a modal or pop-up.
8. Settings MUST prevent a user from enabling a provider while its CLI is not
   detected. The disabled state and warning MUST remain understandable without
   requiring the user to attempt a launch.
9. Existing running or restored agent panes MUST NOT be stopped, hidden, or
   otherwise altered by the availability check. The behavior applies to
   starting new sessions.

## Non-Goals

- We will NOT install, update, authenticate, or configure any provider CLI.
- We will NOT repeatedly poll for executable availability or automatically
  re-enable a provider when its CLI later becomes available.
- We will NOT change provider presets, credentials, or routing configuration.
- We will NOT add a launch-time retry or a separate error UI for a CLI removed
  after startup.

## Scenarios (Acceptance Criteria)

- **Given** Codex is absent from the app's PATH at startup and its setting was
  enabled, **When** startup finishes, **Then** Codex is saved as disabled,
  omitted from new-session choices, and Settings shows an inline red warning
  that Codex was not found on PATH and cannot be enabled.
- **Given** Claude Code is detected at startup but the user has disabled it,
  **When** the user opens the command palette, a pane-header or sidebar spawn
  menu, or an empty-workspace quick-start/directory-picker action, **Then**
  Claude Code is not offered or actionable and its setting remains disabled.
- **Given** OpenCode was disabled because it was absent on a prior startup,
  **When** it is detected on a later startup, **Then** OpenCode remains
  disabled until the user explicitly enables it in Settings.
- **Given** a provider is not detected, **When** the user views its Settings
  card, **Then** its `Enabled` control cannot be turned on and the inline
  warning explains why.
- **Given** a provider is detected and enabled, **When** the user starts a
  new session through the command palette, a shared spawn menu, or the
  empty-workspace quick-start/directory-picker actions, **Then** the provider
  is offered and can be selected as it is today.
- **Given** OpenCode is detected at startup and enabled, **When** the user
  opens the empty-workspace quick-start, **Then** OpenCode is offered
  alongside Claude Code and Codex, and any provider that is disabled or
  unavailable is not offered there.
- **Given** an entry point is added later that can create an agent session,
  **When** it is used with an unavailable or disabled provider, **Then** it
  cannot create that session.
- **Given** a restored or already running pane belongs to a provider that is
  no longer detected, **When** startup availability is evaluated, **Then** the
  existing pane is left intact.

## Open Questions

None outstanding.

## Resolved Decisions

- Availability is evaluated at application startup, using the PATH visible to
  sessions launched by MultiAgent (the app's inherited PATH, per the existing
  no-PATH-rewrite guardrail — sessions and the detection check see the same
  PATH).
- Detection is one-way: it may turn `Enabled` off, but never turns it on.
- The provider's existing `Enabled` flag (introduced in `agent-provider-config`)
  gains a second role: it also gates whether the provider is offered for new
  sessions. Unchecking it no longer merely scrubs that provider's routing env —
  it also hides the provider from every new-session entry point until it is
  re-checked. This deliberately overloads one control rather than adding a
  separate visibility toggle the user would have to reconcile.
- All new-agent entry points — command palette, spawn/split menus, sidebar
  spawn, empty-workspace quick-start, and directory-picker — share one
  detected-and-enabled provider set. The empty-workspace quick-start is
  normalized to offer OpenCode when available (it currently lists only Claude
  Code and Codex), rather than keeping a per-entry-point hardcoded list.
- Availability feedback is inline red text beside the provider name, not a
  pop-up. Proposed wording: "CLI not found on PATH — install it to enable this
  provider."
- The set of providers covered is the three supported agent kinds in
  `opencode-agent-support` / `agent-provider-config`: Claude Code, Codex, and
  OpenCode.

## Out-of-Scope Notes

- A future enhancement could provide a manual re-check action without changing
  the one-way automatic-enable rule.
- Detection sees only the PATH the app inherited at launch. A user who adds a
  CLI to PATH only in their interactive shell profile (e.g. launching
  MultiAgent from a desktop shortcut with a leaner PATH) will see that
  provider reported unavailable until the app is restarted from an environment
  that has the binary on PATH. We do not re-read shell profiles or poll.
