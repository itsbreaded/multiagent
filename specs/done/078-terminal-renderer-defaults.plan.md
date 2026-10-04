# Implementation Plan: Make terminal renderer defaults application-owned

Plan Status: completed <!-- review | changes-requested | approved | in-progress | completed -->
Source spec: `specs/pending/078-terminal-renderer-defaults.md` (Status: ready)

## Verified Repository Facts

- The Terminal settings UI is rendered in `SettingsPanel/index.tsx`; search
  results are rendered by `SettingsPanelParts.tsx` using visibility booleans
  derived in the parent.
- `optimizedTerminalRenderer` is a persisted renderer-store field. When true,
  `Terminal/index.tsx` uses `applyBackend`; when false, it uses a legacy direct
  WebGL try/catch path and bypasses the GPU preference.
- `terminalRescaleOverlappingGlyphs` is a persisted renderer-store field passed
  into xterm construction and hot-applied through `xtermRegistry` by its
  setter. Its shipped default is true and it affects WebGL only.
- `terminalGpuAcceleration` remains a separate persisted preference consumed by
  `applyBackend` and tested by `resolveBackend.test.ts`.
- Minimum contrast ratio, scrollback, session-detection settings, and terminal
  key bindings have separate state and UI paths that must remain intact.
- `docs/pty-and-terminals.md` currently describes the optimized master flag as
  a legacy escape hatch; that documentation must describe the renderer registry
  as the sole path after this change.

## Scope and Coverage

| Requirement/scenario | Planned task(s) | Verification |
| --- | --- | --- |
| R1/R2; settings section omits both controls | T2 | Focused component/render inspection and E2E settings check |
| R1/R2; search omits both controls | T2 | Settings search tests and E2E search check |
| R3; optimized backend path is unconditional and GPU preference remains | T1 | Existing resolver tests plus focused source/store tests; typecheck/build |
| R4; glyph rescaling stays enabled | T1 | Focused terminal-option assertions/source test; renderer tests |
| R5; legacy persisted values have no effect | T1 | Settings-store legacy-load/persistence test |
| R6; retained settings stay available and behavior-compatible | T1/T2 | Existing settings tests, scrollback E2E, full unit suite, E2E smoke |
| Non-goals: agent-specific terminal behavior and key bindings unchanged | T1/T2 | Diff inspection and existing terminal/key-binding tests |

## Architecture and Data Flow

Settings are renderer-owned and persisted in the `multiagent:settings`
localStorage record. A terminal reads the current renderer settings while
creating its xterm instance. Backend selection then resolves the retained GPU
preference against renderer capabilities. The change removes two fields and
their setters from this data flow; it does not add IPC or alter main-process
PTY ownership.

The UI has two presentation paths that must be updated together: direct
Terminal-section rendering and cross-section settings search. Removing a
setting from only one path would leave a stale search result or a stale prop
contract.

## Implementation Tasks

### T1 - Make renderer behavior application-owned (completed)

- Dependencies: none.
- Requirements/scenarios: R3, R4, R5, R6; legacy-settings and backend-fallback scenarios.
- Files and symbols:
  - `src/renderer/src/store/settings.ts`: `SettingsState`, `Persisted`,
    `defaultSettings`, `loadSettings`, `saveSettings`, and the two removed
    setters.
  - `src/renderer/src/components/Terminal/index.tsx`: xterm construction and
    backend attachment in `createXterm`.
  - `src/renderer/src/utils/xtermRegistry.ts`: `TerminalDisplayOptions` and
    the obsolete live rescale branch.
  - `src/renderer/src/store/settings.test.ts` and/or a focused terminal test
    seam for legacy settings and canonical persistence.
  - `docs/pty-and-terminals.md`: renderer-selection mechanism description.
- Current behavior: persisted fields control whether the legacy WebGL path is
  used and whether xterm receives the rescale option; old localStorage values
  are read into the live store.
- Implementation change:
  - Remove both fields, defaults, persistence writes, and setters from the
    renderer settings store. Unknown legacy keys must be ignored by the
    existing current-shape loader and omitted by subsequent canonical saves.
  - Make the optimized `applyBackend` registry path the only backend path while
    passing the existing `terminalGpuAcceleration` value unchanged.
  - Pass `rescaleOverlappingGlyphs: true` when creating xterm instances.
    Remove the now-unused setting-driven live update branch without changing
    minimum-contrast or scrollback hot-apply behavior.
  - Update the PTY/terminal mechanism doc to remove the retired master-flag
    escape-hatch description and state that the environment-aware registry is
    the sole renderer-selection path.
- Invariants and edge cases:
  - `auto` must still avoid software-rendered WebGL; `on` and `off` retain
    their current resolver semantics.
  - A legacy false value must not select the old renderer path or disable glyph
    rescaling. Existing unknown localStorage keys may remain until a normal
    settings save, but they must never enter runtime state and canonical saves
    must not write them back.
  - Do not touch `minimumContrastRatio`, `terminalScrollbackLines`,
    `terminalKeyBindings`, agent-specific xterm options, or PTY behavior.
- Verification:
  - Add focused assertions that the current settings state and saved current
    settings shape do not expose/write the removed fields, and that a legacy
    record cannot change the effective renderer defaults.
  - Run the existing `resolveBackend` tests and relevant terminal/settings unit
    tests.
- Completion evidence: removed both fields and setters from the settings store;
  `Terminal/index.tsx` now always uses `applyBackend` and passes literal `true`
  for glyph rescaling; the xterm registry no longer exposes a setting-driven
  rescale update; the PTY/terminal documentation describes the sole registry
  path. Focused settings tests passed (3 tests) and the full suite passed.

### T2 - Remove the two controls from both Settings presentation paths (completed)

- Dependencies: T1's state API removal should land before removing UI imports
  and selectors.
- Requirements/scenarios: R1, R2, R6; Terminal-section and settings-search scenarios.
- Files and symbols:
  - `src/renderer/src/components/SettingsPanel/index.tsx`: imports,
    `showOptimizedRendererSetting`, `showRescaleSetting`, `anyTerminalSetting`,
    direct section rendering, and `SearchResults` props.
  - `src/renderer/src/components/SettingsPanel/SettingsPanelParts.tsx`:
    `SearchResults` imports, props, terminal rendering, and aggregate visibility.
  - Delete the now-unreferenced `settings/OptimizedRendererSetting.tsx` and
    `settings/RescaleGlyphsSetting.tsx`.
  - Add or update focused Settings UI tests and the relevant section/search
    coverage in `e2e/startup.spec.ts`.
- Current behavior: both controls appear under Renderer/Display and can also
  be surfaced by matching search keywords.
- Implementation change: remove only these two controls, their search keywords,
  and their prop plumbing. Keep the Terminal section usable when a query
  matches retained settings, and keep the empty-state behavior correct when it
  does not.
- Invariants and edge cases:
  - The retained GPU, contrast, scrollback, and idle-suspension controls must
    remain reachable both directly and through search.
  - Search text such as `renderer` may still match the retained GPU setting;
    it must not resurrect either removed control.
  - Do not remove the separate terminal key-binding customization surface under
    Hotkeys.
- Verification:
  - Render or exercise Settings and assert neither removed title appears.
  - Search for removed terms and assert the removed rows are absent while
    retained matching settings continue to render.
  - Run the existing scrollback E2E flow to prove the shared Settings surface
    still works.
- Completion evidence: deleted both setting components, removed their direct and
  search presentation plumbing, and added the passing Electron regression test.
  A reference search found no retired implementation references outside the
  intentional migration regression test.

## Cross-Cutting Constraints

- Preserve the Terminal and PTY guardrails in `AGENTS.md`, especially the
  environment-aware renderer decision and the 250,000-line scrollback default.
- Do not add a new IPC channel, alter main-process settings ownership, or
  change agent launch/environment behavior.
- Do not silently remove minimum contrast ratio, GPU acceleration, scrollback,
  session linking, terminal status detection, idle suspension, or terminal key
  bindings.
- Keep persisted settings backward-compatible by ignoring unknown legacy keys
  rather than treating them as errors or changing unrelated defaults.

## Risks, Migration, and Rollback

- Users who explicitly disabled either removed option will receive the shipped
  application defaults after upgrade. This is the intended user-authorized
  behavior change; reverting the application version is the rollback path.
- A stale settings record may contain the old keys until a current settings
  action saves it. Runtime behavior must not depend on those keys, and the next
  canonical save must omit them.
- Removing the legacy path could expose an existing WebGL-specific regression;
  `applyBackend` already has capability-based DOM fallback and context-loss
  demotion, and the existing resolver tests cover the decision matrix.

## Handoff Checklist

- [x] T1 removes state-driven legacy behavior without changing retained settings.
- [x] T2 removes both controls from direct and search UI paths.
- [x] Legacy false values are ignored and canonical saves omit removed keys.
- [x] Existing renderer fallback and glyph-rescaling behavior are tested.
- [x] `npm run typecheck`, `npm run build`, `npm run test`, and applicable
      `npm run test:e2e` evidence is recorded.
- [x] No unrelated settings, terminal behavior, or PTY behavior changed.

## Plan Review

Completed by `review-plan`: **APPROVED**.

- Coverage: all six requirements, six acceptance scenarios, five non-goals,
  and both resolved decisions are mapped to T1/T2 and verification evidence.
- Repository checks: the reviewer confirmed the planned settings-store,
  terminal, xterm-registry, Settings UI/search, test, E2E, and documentation
  paths and confirmed the existing `resolveBackend` decision tests.
- Findings: no blocking or important findings.
- Reviewer limitation: this was a read-only pre-execution review; runtime and
  implementation checks remain for execution/verification.
- Independent reviewer: blind subagent `Dewey` (agent id
  `01a104ad-bd50-7362-ac62-02505e6db1ee`).

## Implementation Summary

- Removed `optimizedTerminalRenderer` and
  `terminalRescaleOverlappingGlyphs` from renderer state, defaults, loading,
  persistence, and setters. Legacy localStorage keys are ignored and omitted
  by canonical saves.
- Made the environment-aware `applyBackend` path unconditional while retaining
  the existing GPU preference and fallback semantics.
- Made xterm glyph rescaling application-owned (`true`) and removed its live
  user-setting update path.
- Removed both controls and their search plumbing/components, updated the
  terminal mechanism documentation, and added unit/E2E regression coverage.
- Checks completed: focused settings/resolver tests (11 tests), focused
  settings persistence tests (3 tests), `npm run typecheck`, `npm run build`,
  `npm run test` (89 files / 950 tests), `npm run test:e2e` (38 tests), and
  `git diff --check`.
- Manual/runtime limitation: no separate visual inspection of WebGL glyph
  rendering was performed; the existing capability/resolver tests and full
  Electron suite passed.

## Verification Evidence

Independent delegation limitation: two fresh blind verifier attempts were
started, but neither returned after repeated bounded waits; both were shut down
without a result. No independent verifier PASS is claimed. The matrix below is
the orchestrator's fallback verification from direct repository inspection and
the concrete checks recorded during execution.

### Requirement and scenario matrix

| Item | Verdict | Evidence |
| --- | --- | --- |
| R1 / scenario 1: remove Optimized renderer control | PASS | Direct and search UI paths no longer import/render it; the new Electron Settings regression test passed as E2E case 11. |
| R2 / scenario 1: remove Rescale overlapping glyphs control | PASS | Direct and search UI paths no longer import/render it; the new Electron Settings regression test passed as E2E case 11. |
| R3 / scenario 3: sole environment-aware backend path and retained GPU preference | PASS | `Terminal/index.tsx` unconditionally calls `applyBackend` with `terminalGpuAcceleration`; existing resolver tests passed in the focused 2-file/11-test run and the full suite. |
| R4 / scenario 4: glyph rescaling remains enabled | PASS | `Terminal/index.tsx` passes `rescaleOverlappingGlyphs: true` at xterm construction; the removed store and registry setter cannot override it. No separate visual glyph inspection was performed. |
| R5 / scenario 5: legacy false values have no effect | PASS | Settings test calls `loadSettings()` against both legacy false keys, asserts neither enters the loaded state, then verifies canonical save omits both keys. |
| R6 / scenario 6: retained settings and behavior preserved | PASS | Retained store/UI paths remain; full unit suite passed (89 files / 950 tests), scrollback Settings E2E passed, and the complete Electron suite passed (38 tests). |
| Non-goals: GPU, contrast, scrollback, session behavior, key bindings, agent-specific terminal behavior | PASS | No changes outside the specified renderer settings/runtime paths; full unit/E2E checks passed and diff inspection found no unrelated implementation references. |
| Resolved decision: remove only the two unambiguous switches | PASS | Spec scope, plan tasks, and final diff contain only the two removals plus their required runtime/docs/tests wiring. |
| Resolved decision: reset legacy values to app defaults | PASS | Removed fields are absent from current state/default/load/save paths; runtime uses the fixed optimized path and glyph-rescaling default. |

### Commands and results

- `npm run test -- --run src/renderer/src/store/settings.test.ts src/renderer/src/terminal/rendering/resolveBackend.test.ts` — PASS, 2 files / 11 tests.
- `npm run test -- --run src/renderer/src/store/settings.test.ts` — PASS, 1 file / 3 tests.
- `npm run typecheck` — PASS.
- `npm run build` — PASS.
- `npm run test` — PASS, 89 files / 950 tests.
- `npm run test:e2e` — PASS, 38 tests.
- `git diff --check` — PASS.
- Retired implementation reference search excluding the intentional migration
  regression fixture — PASS; no implementation/UI/docs references remain.

### Repairs and limitations

- No autonomous repairs were needed during verification.
- The two blind verifier delegations were unavailable after bounded waits; this
  is recorded above as an independence limitation.
- No separate visual inspection of WebGL glyph rendering was performed; the
  xterm option wiring is source-verified and all applicable automated checks
  are green.
