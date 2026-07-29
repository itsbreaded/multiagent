# Spec: Simplify Provider Settings Persistence

Status: done
Created: 2026-07-29
Completed: 2026-07-29

## Problem

Provider settings did not reliably survive closing and reopening the
application. The prior repair added a separate persistence protocol with
visible save-state feedback, retry handling, cross-window conflict detection,
and synchronization. That behavior is inconsistent with the established
persistence behavior for the rest of Settings and introduces UI noise for an
ordinary preference change.

The underlying issue is narrower: the renderer has a stale local mirror of
provider settings while the application process also holds the settings used to
launch agents. A stale mirror must not replace the value the user last chose.

## Goal

Provider settings behave like ordinary application settings: every committed
provider change is immediate and visually quiet, then is restored and used
after a normal application restart.

## Users & Context

Developers configure Claude Code, Codex, or OpenCode in Settings before
starting a new agent pane. They expect every committed choice, including the
selected provider, Enabled preference, credentials, routing fields, named
custom providers, and environment entries, to remain unchanged when Settings
is closed or the application is restarted.

## Requirements

1. Provider preferences MUST use the established application Settings
   persistence behavior, rather than a provider-specific save protocol.
2. The durable provider preference used after startup MUST be the same value
   last saved through that established Settings behavior; a stale startup or
   Settings-open value MUST NOT replace it.
3. Every committed change to provider settings MUST update the Providers
   screen immediately and MUST persist the resulting complete provider
   configuration for a normal close and relaunch. Committed changes include
   selection, toggles, and edits that the existing Providers UI commits; an
   in-progress text draft is not a saved setting until that UI commits it.
4. A normal successful provider change MUST NOT show saving, saved, loading,
   retry, conflict, toast, or other transient persistence UI.
5. Every new-session entry point MUST offer only providers that are both
   enabled in the saved settings and available for the current application
   run. A launched provider MUST use the same complete saved configuration
   shown in Settings. Runtime CLI availability MUST NOT alter that saved
   configuration.
6. When several changes are made in quick succession in one application
   window, the most recent complete change MUST be the one restored after a
   normal relaunch.
7. If provider data cannot be read at startup, the application MUST use safe
   default provider settings without crashing or showing malformed data.
8. Automated verification MUST exercise changing selection, Enabled,
   representative routing or credential fields, a named custom provider, and
   an environment entry through the Providers UI, closing the application, and
   reopening it with the same profile.

## Non-Goals

- We will NOT add save-progress, success, conflict, retry, or rollback UI for
  normal provider changes.
- We will NOT synchronize a provider edit live to other open application
  windows in this iteration.
- We will NOT introduce a provider-only persistence mechanism where the
  established Settings mechanism already applies.
- We will NOT alter the meaning or available set of provider presets, provider
  fields, credentials, routing fields, custom providers, or CLI installation
  detection.
- We will NOT change the persistence behavior of unrelated application
  settings.

## Scenarios (Acceptance Criteria)

- **Given** a user selects a non-default provider, enables it, and commits
  routing or credential fields, **When** they close and reopen the application
  with the same profile, **Then** the complete configuration remains unchanged
  without a transient save-status UI.
- **Given** a user creates or edits a named custom provider and commits an
  environment entry, **When** they close and reopen the application with the
  same profile, **Then** the custom provider and environment entry are restored
  exactly as committed.
- **Given** a user disables a provider, **When** they close and reopen the
  application with the same profile, **Then** it remains disabled and is not
  offered for a new agent session.
- **Given** a user changes provider settings several times before closing the
  application, **When** they reopen it, **Then** the last complete choice is
  restored.
- **Given** a user commits a provider change and immediately closes the
  application normally, **When** they reopen it with the same profile,
  **Then** that committed change is restored.
- **Given** a provider CLI is unavailable at startup, **When** the user opens
  Settings, **Then** the saved provider selection and Enabled preference are
  unchanged and that provider is not offered by any new-session entry point.
- **Given** a provider is enabled and its CLI is available, **When** the user
  opens any new-session entry point, **Then** that provider is offered and a
  new pane uses its saved configuration.
- **Given** stored provider data is missing or invalid, **When** the
  application starts, **Then** the Providers screen shows safe defaults and
  remains usable.

## Open Questions

None outstanding.

## Resolved Decisions

- Normal successful setting changes are silent. Persistence feedback is not a
  user-facing feature of this work.
- The provider-specific persistence protocol will be removed in favor of the
  established Settings persistence behavior. Its correction will preserve the
  published release version and historical release record.
- The persistence contract covers the complete provider configuration, not
  only the selected provider and Enabled preference.
- Provider preferences are application settings, but matching the established
  Settings behavior does not add live synchronization UI or conflict handling
  between already-open windows. A normal relaunch restores the last committed
  settings consistently.
- This replaces the over-broad approach documented in
  `durable-provider-settings-persistence` with a focused provider-preference
  contract.

## Out-of-Scope Notes

- A future settings-wide persistence design can establish a consistent policy
  for unusual write failures and simultaneous edits across windows. It is not
  needed to make ordinary provider preferences persist reliably.
