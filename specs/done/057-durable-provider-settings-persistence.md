# Spec: Durable Provider Settings Persistence

Status: done
Created: 2026-07-29
Completed: 2026-07-29

## Problem

Provider Settings do not reliably retain the user's selection and enabled state
after the application is closed and reopened. The current experience can show a
change immediately, then later restore an older provider configuration. This
makes credentials and routing choices feel unsafe to configure and makes the
Enabled control unreliable as a user preference.

Investigation confirms that provider configuration currently has more than one
persisted representation, with asynchronous saves and more than one
authoritative-state hydration opportunity. A stale read can therefore replace a
newer in-memory change, and there is no end-to-end restart test that proves the
saved result is the state shown after relaunch. The earlier
`provider-cli-availability` behavior also conflicts with the desired contract
when it changes a user's saved Enabled preference in response to temporary CLI
availability.

## Goal

Every user-visible provider setting has one durable, authoritative saved result.
After a confirmed edit and normal application restart, the Providers screen and
new agent sessions use exactly the provider selection, enabled preference, and
provider-specific configuration that the user last saved.

## Users & Context

Developers configure Claude Code, Codex, and OpenCode before starting sessions.
They may switch among built-in or named custom providers, enable or disable an
agent, edit routing fields and credentials, then close or restart MultiAgent.

## Requirements

1. MultiAgent MUST persist, as one coherent provider-settings state, the active
   provider selection, Enabled preference, built-in provider drafts, named
   custom providers, credentials, routing fields, and extra environment-variable
   entries for Claude Code, Codex, and OpenCode.
2. A provider edit MUST not be reported or treated as saved until its durable,
   authoritative result is known. The UI MUST reconcile to that result rather
   than retaining an optimistic value that was rejected, normalized, or failed
   to save.
3. A delayed or stale read of provider settings MUST NOT overwrite a change
   made after that read began, whether the read occurs during application
   startup, while opening Settings, or in another application window.
4. When several provider edits are made in succession, the final saved state
   MUST reflect the user's most recent complete edit; an earlier asynchronous
   save MUST NOT overwrite it later.
5. When provider settings change in one application window, every open
   application window MUST receive and use the authoritative state without a
   Settings reopen or application restart, for its Providers screen and every
   new-session choice. A provider is offered only when it is both enabled in
   the saved settings and installed for the current application run.
6. After a normal close and relaunch using the same application profile, the
   Providers screen MUST show the authoritative saved state before the user can
   make a decision based on a stale mirror. New agent sessions MUST use that
   same state.
7. If durable persistence fails, the application MUST keep the last confirmed
   provider settings intact, clearly tell the user that the latest change was
   not saved, and provide a safe retry path. It MUST NOT silently claim the
   failed change will survive a restart.
8. CLI availability MAY prevent an agent session from launching for the current
   run, but it MUST NOT silently change the user's saved provider selection or
   Enabled preference. Availability feedback and launch eligibility MUST remain
   understandable alongside the saved preference.
9. The persistence contract MUST be verified through automated tests that use
   the real provider-settings UI and main-process persistence boundary, then
   close and relaunch the application with the same isolated profile. Unit-only
   validation of configuration shape is not sufficient.

## Non-Goals

- We will NOT change the available built-in presets or the meaning of any
  provider's routing fields.
- We will NOT install, authenticate, or repeatedly probe provider CLIs.
- We will NOT expose stored credentials in UI notifications, logs, tests, or
  diagnostics.
- We will NOT add cloud sync or cross-device provider-configuration sharing.

## Scenarios (Acceptance Criteria)

- **Given** a user selects a non-native built-in provider and enables it,
  **When** the application is normally closed and reopened, **Then** the same
  provider remains selected and enabled.
- **Given** a user disables a provider and selects another built-in or named
  custom provider, **When** the application is normally closed and reopened,
  **Then** the disabled preference and selected provider both remain unchanged.
- **Given** a user edits routing fields, credentials, or extra environment
  variables for a provider, **When** they switch away, restart the application,
  and switch back, **Then** the saved draft is restored without exposing a
  credential value unnecessarily.
- **Given** the Providers screen starts loading saved settings, **When** the
  user changes a provider before that load completes, **Then** the delayed
  response cannot replace the user's newer change.
- **Given** a user makes two provider changes in rapid succession, **When**
  both persistence operations complete in either order, **Then** the later user
  change is the state that survives restart.
- **Given** two MultiAgent windows are open, **When** a user changes a provider
  setting in one window, **Then** the other window reflects the same saved
  state without reopening Settings or restarting, and offers only providers
  that are both installed and enabled.
- **Given** a provider CLI is unavailable at startup while the user previously
  enabled and selected a provider, **When** the user restarts the application,
  **Then** the saved selection and Enabled preference remain intact, the
  unavailable state is explained, and a new session cannot launch until the
  CLI is available.
- **Given** provider settings cannot be written, **When** a user changes a
  setting, **Then** they see that the change was not saved, the prior confirmed
  state is retained, and retrying can save the change without re-entering
  unrelated provider data.

## Open Questions

None outstanding.

## Resolved Decisions

- This covers the complete Provider Settings state for all three supported
  agents, not only the currently reported preset and Enabled controls. A
  partial fix would leave other provider edits subject to the same persistence
  race.
- The user's saved Enabled preference is distinct from current CLI
  availability. Availability still blocks an unlaunchable session but must not
  rewrite the preference on disk.
- Provider changes synchronize across every open application window. This
  ensures that all session-start entry points consistently offer only providers
  that are both installed and enabled, and prevents a stale window from later
  overwriting a newer choice.
- Related prior behavior is documented in `agent-provider-config`,
  `extended-provider-presets-and-multi-custom`, `durable-persistence-and-safe-config-loading`,
  and `provider-cli-availability`.

## Out-of-Scope Notes

- A future settings-wide persistence framework could apply this acknowledgement
  and stale-read contract to settings beyond providers. This spec is limited to
  provider settings because they contain credentials and directly affect agent
  launch behavior.
