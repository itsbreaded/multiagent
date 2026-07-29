# Implementation Plan: Simplify Provider Settings Persistence

## Tasks

1. **completed** — Requirements 1, 2, 7: removed the provider-only durable file and revision protocol; retained a safe sanitizing runtime mirror in main. Files: `src/main/ipc/handlers.ts`, `src/shared/types.ts`. Verify with main/shared tests and typecheck.
2. **completed** — Requirements 1, 3, 4, 6: made the renderer Settings store the single durable provider preference and silently mirror each committed complete change to main. Files: `src/renderer/src/store/settings.ts`, `src/renderer/src/App.tsx`. Verify with store tests.
3. **completed** — Requirements 4, 5: removed provider persistence feedback and cross-window synchronization UI while preserving enabled-and-available session gating. Files: `src/renderer/src/components/SettingsPanel/AgentProvidersSection.tsx`, provider offering consumers. Verify with component/unit tests.
4. **completed** — Requirement 8 and restart scenarios: revised Electron verification to restart with the same profile and cover selected/enabled, routing/credential, custom provider, and environment entry restoration. Files: `e2e/startup.spec.ts`. Verified with `npm run test:e2e` (24 passed).
5. **completed** — All requirements: ran project checks and updated this plan’s evidence. Verified with `npm run typecheck`, `npm run build`, and `npm run test` (67 files / 713 tests passed).

## Implementation Summary

- Provider preferences now persist exclusively through the renderer's ordinary Settings state; the separate file, save queue, revisions, retry UI, and cross-window synchronization were removed.
- Main receives a sanitized, silent runtime mirror before provider session entry points become available. Saved enabled preferences remain independent of runtime CLI availability.
- Checks run: focused provider tests (19 passed), `npm run typecheck`, `npm run build`, `npm run test` (67 files / 713 tests), and `npm run test:e2e` (24 tests).
- Manual/runtime limit: independently opened windows intentionally do not receive live provider-edit synchronization; each normal relaunch restores its Settings state.

## Verification Evidence

- Requirements 1-4 and 6 — **PASS**: `src/renderer/src/store/settings.test.ts` proves each committed complete configuration is written immediately through the ordinary persisted Settings store and silently mirrored to main; code inspection confirms the provider-only file/revision/save queue and loading, saving, retry, conflict, and success UI were removed. Electron tests `persists a provider selection made in Settings through a normal restart` and `shows an enabled built-in provider selection in the reopened Settings UI` exercise the real UI and same-profile restart.
- Requirement 5 — **PASS**: code inspection confirms every session launch is gated by the intersection of saved Enabled preferences and startup CLI availability, while main receives the complete sanitized saved configuration. Electron test `keeps saved preferences when a provider CLI is unavailable and blocks launches` confirms unavailable runtime CLIs neither rewrite saved selection/Enabled state nor remain launchable.
- Requirement 7 — **PASS**: startup hydration sanitizes persisted provider data and falls back to `defaultAgentProviderSettings`; unit coverage and the successful cold-start Electron suite confirm malformed/missing settings do not crash startup.
- Requirement 8 and all restart scenarios — **PASS**: Electron tests changed selection and Enabled state, committed representative routing/credential values, created a named custom provider, committed an environment entry, closed Electron normally, and reopened the same profile. `restores a custom provider and its routing draft through the real Settings UI` verified exact restoration. Rapid successive edits and immediate normal close are covered by the synchronous Zustand persistence path and restart tests.
- Non-goals — **PASS**: diff inspection found no provider save-state/conflict/retry/rollback UI, no live cross-window provider synchronization, no provider-only durable mechanism, no preset/field/CLI-detection semantic expansion, and no unrelated Settings persistence changes.
- Resolved decisions and dependencies — **PASS**: the established Zustand `persist` Settings mechanism is the sole durable store; main's runtime mirror is sanitized and availability is advisory only. No open questions remain.
- Mechanical checks — **PASS**: `npm run typecheck`; `npm run build`; `npm run test` (67 files, 713 tests); `npm run test:e2e` (24 tests).
- Manual/runtime limits: live synchronization between already-open windows was deliberately excluded by the spec. No autonomous repairs were required during verification.
