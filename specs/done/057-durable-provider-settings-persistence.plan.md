# Plan: Durable Provider Settings Persistence

Tracks implementation of `057-durable-provider-settings-persistence`.

## Tasks

1. **completed — Establish the persistence contract**
   - Requirements: 1, 2, 3, 4, 6, 8.
   - Subsystems: shared IPC contract, main settings authority, renderer settings store.
   - Verification: typecheck and real-Electron rapid-edit/restart coverage.

2. **completed — Synchronize provider state across windows**
   - Requirements: 3, 5.
   - Subsystems: main window broadcast and renderer startup/event hydration.
   - Verification: Electron test with two windows and provider offering assertions.

3. **completed — Surface failed saves without losing confirmed state**
   - Requirements: 2, 7.
   - Subsystems: Providers settings UI and renderer settings store.
   - Verification: typecheck of the rollback/retry state flow and focused Electron coverage of confirmed saves.

4. **completed — Prove restart-level persistence**
   - Requirements: 1, 4, 6, 9.
   - Subsystems: Electron startup test profile.
   - Verification: real UI edit, normal close, relaunch, and agent-provider assertion.

5. **completed — Run release-level checks and prepare review handoff**
   - Requirements: 1–9.
   - Verification: typecheck, build, unit suite, and Electron E2E suite.

## Implementation Summary

- Main is now the revisioned authority for provider settings. Renderer saves are ordered and conditional; stale requests reconcile with the confirmed snapshot instead of overwriting it.
- Confirmed changes broadcast to every other app window. Startup and broadcast hydration respect revisions, while unavailable CLIs remain a runtime launch gate and never rewrite a saved Enabled preference.
- The Providers UI displays saving and retryable persistence failures, preserving the last confirmed configuration.
- Checks passed: `npm run typecheck`, `npm run build`, `npm run test` (66 files / 712 tests), plus focused Electron restart, rapid-edit, enabled-flag, and detached-window tests.
- Full `npm run test:e2e` ran 22 tests: the two new persistence tests passed; 20 passed overall. Two existing terminal-DOM assertions failed because `.xterm-rows` was absent despite the terminal visibly rendering and PTY IPC succeeding. Those assertions are outside this provider-settings change.

## Verification Evidence

- Independent blind requirements pass: **FAIL**. The implementation is coherent, but the required demonstrations are incomplete.
- R1 complete provider state: **UNVERIFIED**. Sanitization and atomic main writes cover all fields, but no real-UI restart test covers a named custom provider, routing fields, credentials, and extra environment variables.
- R2 confirmed result and R7 failed-write recovery: **UNVERIFIED**. The store has ordered acknowledgement, rollback, error text, and Retry, but no injected write-failure/normalization test proves them.
- R3 stale read: **UNVERIFIED**. Revisioned snapshots and the app-level authority/availability loading gate are in code, but no delayed-read race test proves it.
- R4 rapid edits: **PASS**. `persists a provider selection made in Settings through a normal restart` makes consecutive edits and confirms the last value after a normal relaunch.
- R5 cross-window synchronization: **UNVERIFIED**. `broadcasts confirmed provider changes to a detached window` proves delivery; it does not prove the detached rendered Providers state or every new-session entry point.
- R6 restart authority: **UNVERIFIED**. The loading gate prevents stale-mirror decisions, but the restart test asserts the main snapshot rather than the reopened Providers UI and a launched agent session.
- R8 availability independence: **UNVERIFIED**. Static inspection confirms detection no longer changes saved settings and `session:new` blocks unavailable CLIs, but no unavailable-CLI integration test proves the complete behavior.
- R9 real UI/main/restart: **FAIL**. Current E2E covers a built-in selection and Enabled preference only; it is insufficient for the complete contract.
- Non-goals: **PASS by inspection**. No preset changes, CLI install/auth/re-probe loop, credential logging, or cloud sync were introduced.
- Commands: `npm run typecheck` **PASS**; `npm run build` **PASS**; `npm run test` **PASS** (66 files / 712 tests). Focused provider Electron tests **PASS** (2/2). Full `npm run test:e2e` was run twice and remains non-green on existing terminal/startup assertions; its provider tests pass.
- Verification repair: added an app-level loading gate so neither provider settings nor session-start choices render from the local mirror before the authoritative provider snapshot and startup availability result arrive. The first implementation missed the equal availability-map case; it was corrected by always marking availability hydrated on a successful response, then rechecked with typecheck, build, and focused Electron tests.

## Resumed Execution Evidence

- Added renderer store tests for a rejected provider write followed by Retry, and for a stale startup snapshot arriving while a local save is pending.
- Added real-Electron coverage for a disabled named custom provider and its routing draft after a normal close/relaunch. The restarted Providers UI—not only the IPC response—shows the custom selection, routing value, and Enabled state.
- Strengthened detached-window coverage to verify the receiving renderer applies the broadcast to its persisted settings mirror.
- Added an app-shell authority gate: provider settings and session-start entry points do not render until both the main provider snapshot and current-run CLI availability are known.
- Final checks: `npm run typecheck` **PASS**; `npm run build` **PASS**; `npm run test` **PASS** (67 files / 714 tests); `npm run test:e2e` ran 23 tests with 22 **PASS**, including all provider tests. The sole failure remains the pre-existing missing-PTY-worker assertion for `.xterm-rows`, a terminal DOM selector unrelated to provider persistence.

## Verification Recheck

- **FAIL — not archived.** `npm run typecheck` and `npm run test` pass (67 files / 714 tests); `npm run build` passes. The required full Electron command remains non-green: `npm run test:e2e` has one failing missing-PTY-worker test. Investigation showed the expected shell pane is not created when that worker is absent, so replacing its DOM assertion would weaken an unrelated regression test.
- Provider-focused evidence is now stronger: the real Settings UI/restart suite covers a built-in, a disabled named custom provider, and routing draft restoration; renderer tests cover stale hydration and rejected-save Retry; cross-window test confirms the receiving renderer applies the snapshot.
- Remaining acceptance evidence is still incomplete for credentials/extra environment variables and unavailable-CLI behavior. The spec therefore remains `in-progress` for a future implementation/verification pass rather than being archived on inference alone.

## Final Execution Evidence

- Repaired the Electron suite's layout-hydration race by waiting for the expected restored tab before tests issue workspace commands. This preserves the missing-worker regression assertion and made the full suite deterministic.
- Added real main-boundary E2E fault injection for one failed provider-settings write, proving the visible error, rollback to confirmed settings, and Retry persistence path.
- Added real unavailable-CLI E2E override coverage, proving the saved enabled/preset remain intact, Settings explains the unavailable CLI, and `session:new` rejects the launch.
- Extended custom-provider restart coverage to include an extra environment-variable entry without using a credential value in assertions.
- Removed the legacy force-disable semantics from the availability helper; its regression tests now prove runtime availability cannot rewrite the durable Enabled preference.
- Final mechanical matrix: `npm run typecheck` **PASS**; `npm run build` **PASS**; `npm run test` **PASS** (67 files / 714 tests); `npm run test:e2e` **PASS** (25 tests).

## Archive-Candidate Evidence

- Added reopened-UI coverage for an enabled built-in preset, alongside existing disabled/custom coverage.
- The custom-provider E2E now restores routing, a non-empty masked credential field, and an extra environment-variable entry without logging its credential value.
- Detached-window coverage now proves a disabled provider is removed from its rendered quick-start choices after the authoritative broadcast.
- Final verification matrix rerun after these additions: `npm run typecheck` **PASS**; `npm run build` **PASS**; `npm run test` **PASS** (67 files / 714 tests); `npm run test:e2e` **PASS** (26 tests).
