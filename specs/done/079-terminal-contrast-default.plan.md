# Implementation Plan: Make terminal contrast ratio an application default

Plan Status: completed
Source spec: `specs/pending/079-terminal-contrast-default.md` (Status: ready)

## Verified Repository Facts

- `src/renderer/src/store/settings.ts` currently owns the persisted
  `terminalMinimumContrastRatio` field, its `1..21` normalizer, and the live
  setter that calls `xtermRegistry.applyTerminalOptions`.
- `src/renderer/src/components/Terminal/index.tsx` passes that store value to
  xterm as `minimumContrastRatio`; the current default is `1`.
- `src/renderer/src/utils/xtermRegistry.ts` contains no other display option
  than the contrast live-update path, while scrollback has its own setter.
- The settings panel has a dedicated `ContrastRatioSetting`, search keyword
  matching, and a display-row rendering path in both direct and search views.
- `src/renderer/src/store/settings.test.ts` already proves retired settings
  are ignored and omitted from canonical saves. The settings component test
  currently proves contrast input normalization. `e2e/startup.spec.ts` has a
  Terminal settings smoke test for removed renderer switches and a real
  scrollback interaction.
- No terminal subsystem documentation currently defines contrast as a
  supported user preference; the renderer documentation covers the broader
  backend and scrollback behavior.

## Scope and Coverage

| Requirement/scenario | Planned task(s) | Verification |
| --- | --- | --- |
| R1; settings panel/search does not expose contrast | T2, T4 | settings component search/direct assertions and E2E search assertion |
| R2; fixed no-adjustment default remains on new terminals | T1 | source-level option assertion and type/build checks |
| R3; legacy value ignored and omitted on save | T1, T3 | `loadSettings`/canonical persistence test |
| R4; dead state/action/normalizer/UI removed | T1, T2, T3 | repository reference search, typecheck, unit tests |
| R5; remaining settings preserved | T1, T2, T4 | existing settings tests, scrollback E2E, full unit/E2E suites |
| Scenario: direct/search UI | T2, T4 | focused component and startup E2E tests |
| Scenario: terminal initialization | T1 | code-path inspection plus build/typecheck |
| Scenario: legacy storage migration | T1, T3 | persistence regression test |
| Scenario: GPU/scrollback remain independent | T1, T4 | existing GPU/scrollback checks and full suites |

## Architecture and Data Flow

The renderer settings store hydrates a typed persisted payload from
`localStorage`, exposes actions to the settings UI, and saves a canonical
subset after mutations. Terminal creation reads store state in
`Terminal/index.tsx`; xterm instances are registered in `xtermRegistry` so
live-safe options can be applied to all panes.

The contrast value will leave that settings data flow entirely. Terminal
creation will pass the existing fixed value `1` directly as the application
default. The registry will retain its independent scrollback live-update
operation but no longer expose an empty/general display-options API. Unknown
legacy localStorage keys will continue to be ignored by the typed loader, and
the next canonical settings save will omit them.

## Implementation Tasks

### T1 - Remove contrast from settings state and fix terminal default (completed)

- Dependencies: none.
- Requirements/scenarios: R2, R3, R4, R5; terminal initialization and legacy-storage scenarios.
- Files and symbols:
  - `src/renderer/src/store/settings.ts`: `SettingsState`, `Persisted`,
    defaults, `loadSettings`, `saveSettings`, and the contrast setter/helpers.
  - `src/renderer/src/components/Terminal/index.tsx`: xterm options in the
    terminal factory.
  - `src/renderer/src/utils/xtermRegistry.ts`: contrast option interface and
    `applyTerminalOptions`.
- Current behavior: contrast is hydrated, persisted, mutable, and applied to
  all live xterms; terminal creation reads the stored value.
- Implementation change: remove the contrast state, action, persistence
  field, constants, normalizer, and live-update call; pass the explicit
  no-adjustment value `1` at terminal creation; remove the now-unused registry
  API while preserving `setScrollbackLines` and backend ownership.
- Invariants and edge cases: legacy `terminalMinimumContrastRatio` values must
  be harmless unknown payload keys; GPU and scrollback fields must remain in
  the canonical payload and continue to work.
- Verification: focused settings persistence test, renderer reference search,
  `npm run typecheck`, and `npm run build`.
- Completion evidence: Removed contrast from the persisted/state shapes,
  defaults, loader, saver, normalizer, and setter; removed the contrast live
  update API; and set xterm creation to `minimumContrastRatio: 1`. Focused
  settings tests, typecheck, and build passed.

### T2 - Remove the contrast settings UI and component test (completed)

- Dependencies: T1 for the removed store API.
- Requirements/scenarios: R1, R4, R5; direct/search UI scenario.
- Files and symbols:
  - `src/renderer/src/components/SettingsPanel/index.tsx`: imports, query
    matching, terminal-setting aggregation, and direct rendering.
  - `src/renderer/src/components/SettingsPanel/SettingsPanelParts.tsx`:
    search-result props and rendering.
  - `src/renderer/src/components/SettingsPanel/settings/ContrastRatioSetting.tsx`:
    remove the unreachable setting component.
  - `src/renderer/src/components/SettingsPanel/settings/settings.test.tsx`:
    remove the test that edits the deleted control while retaining the other
    setting tests.
- Current behavior: contrast appears in the Display section and in searches
  matching contrast/color-accuracy terms.
- Implementation change: remove the UI and all search/prop plumbing for it;
  preserve the remaining Display, Session detection, GPU, scrollback, and
  unrelated settings paths.
- Invariants and edge cases: searching for `contrast` must resolve to the
  existing empty-settings result rather than a stale or blank Terminal group.
- Verification: focused settings component tests and E2E assertions for both
  the direct Terminal panel and a contrast search.
- Completion evidence: Removed the dedicated component and all direct/search
  settings-panel plumbing. The focused settings component suite passed.

### T3 - Add migration regression coverage (completed)

- Dependencies: T1.
- Requirements/scenarios: R3 and legacy-storage scenario.
- Files and symbols:
  - `src/renderer/src/store/settings.test.ts`: extend the existing retired
    terminal-renderer persistence test with a legacy contrast value and assert
    that loading and the next canonical save omit it while retaining GPU
    state.
- Current behavior: the test covers the two previously retired renderer
  switches but not the contrast preference being retired in this follow-up.
- Implementation change: cover ignored legacy contrast input and canonical
  save cleanup without introducing a second migration mechanism.
- Invariants and edge cases: unrelated persisted settings remain intact; the
  test must not depend on a hidden UI control.
- Verification: focused `settings.test.ts` run, then the full unit suite.
- Completion evidence: Extended `settings.test.ts` with a legacy contrast
  value and assertions that loading, state, and canonical saves omit it while
  preserving GPU settings. The focused store test passed.

### T4 - Extend user-visible startup coverage and clean references (completed)

- Dependencies: T2 and T3.
- Requirements/scenarios: R1 and R5; direct/search and remaining-settings scenarios.
- Files and symbols:
  - `e2e/startup.spec.ts`: extend the existing Terminal settings smoke test
    to assert that direct and `contrast` searches show no contrast setting,
    while the existing scrollback interaction remains intact.
  - repository-wide renderer/docs reference search: confirm only intentional
    historical/spec references remain.
- Current behavior: E2E proves the two earlier implementation switches are
  absent but does not cover contrast removal.
- Implementation change: add the contrast absence assertion and remove stale
  implementation references introduced by the deleted path; do not alter
  unrelated terminal docs or prior spec history.
- Invariants and edge cases: the Terminal section must still render remaining
  settings, and the E2E fixture must remain isolated from persisted state.
- Verification: `npm run test:e2e`, `git diff --check`, and final targeted
  `rg` search.
- Completion evidence: Extended startup case 11 to cover direct and searched
  contrast absence, removed the stale command keyword, and passed all 38 E2E
  tests. `git diff --check` passed; only normal line-ending warnings were
  emitted.

## Cross-Cutting Constraints

- Do not change GPU backend selection, scrollback limits, session linking,
  terminal-error detection, idle suspension, terminal key bindings, or
  terminal color/theme behavior.
- Do not preserve a hidden contrast preference or add an alternate migration
  setting; the fixed default is the product decision.
- Keep the application default explicit at `1`, matching the previous default
  and the previous no-adjustment behavior.
- Do not edit completed spec 078; this is an explicit follow-up to its
  previously conservative contrast decision.

## Risks, Migration, and Rollback

- Risk: an old persisted contrast value could leak back into the runtime if a
  parser or save path still references it. Mitigation: remove it from the
  persisted type and canonical save object, and add a regression test.
- Risk: removing the only contrast option from `xtermRegistry` could
  accidentally remove scrollback hot-apply behavior. Mitigation: preserve and
  test `setScrollbackLines` separately.
- Migration: no destructive storage rewrite is needed; unknown legacy keys are
  ignored and disappear on the next normal settings mutation.
- Rollback: revert this follow-up's source/UI/test changes; the previous
  application default remains `1`.

## Handoff Checklist

- [x] All requirements and scenarios map to completed tasks.
- [x] Contrast is absent from settings state, persistence, live updates, and UI.
- [x] New terminals still use explicit `minimumContrastRatio: 1`.
- [x] Legacy storage is ignored and omitted from canonical saves.
- [x] Remaining Terminal settings and regression coverage pass.
- [x] `npm run typecheck`, `npm run build`, `npm run test`, `npm run test:e2e`,
  and `git diff --check` are recorded before handoff.

## Plan Review

Completed by `review-plan`: verdict APPROVED. The plan covers every
requirement and acceptance scenario with concrete source paths and checks,
preserves the remaining Terminal settings, and treats legacy storage as an
unknown key that is removed on the next canonical save. The orchestrator
requested an independent blind review, but the reviewer did not return after
bounded waits and was shut down; this is an explicit reviewer-independence
limitation. Same-session fallback review confirmed the plan is implementable,
scope-disciplined, and contains no unauthorized product choice. Manual visual
inspection of rendered glyph contrast remains a verification limitation; the
fixed value and existing behavior are covered structurally and by build/tests.

## Implementation Summary

Implemented the explicit product decision to remove terminal contrast
customization. The renderer now uses `minimumContrastRatio: 1` directly at
terminal creation. Contrast state, persistence, normalization, live updates,
settings UI/search plumbing, command keyword, and dedicated component test
were removed. Legacy localStorage values are ignored and disappear on the
next canonical save. GPU acceleration and scrollback remain persisted and
functional.

Checks: focused settings tests (2 files, 6 tests), `npm run typecheck`,
`npm run build`, `npm run test` (89 files, 949 tests), `npm run test:e2e` (38
tests), and `git diff --check` all passed.

Limits: no separate visual glyph-rendering inspection was performed. The
requested blind plan reviewer and later blind verifier are separate workflow
steps; the plan reviewer did not return after bounded waits, so that review
limitation is recorded above.

## Verification Evidence

| Requirement / scenario | Verdict | Evidence |
| --- | --- | --- |
| R1: contrast control absent from Terminal settings and search | PASS | `e2e/startup.spec.ts` case 11 passed; it checks direct Terminal settings and `contrast` search for no `Minimum contrast ratio` row. |
| R2: fixed no-adjustment default | PASS | `Terminal/index.tsx` passes explicit `minimumContrastRatio: 1`; `npm run build` and `npm run typecheck` passed. No separate visual glyph inspection was performed. |
| R3: legacy value ignored and omitted from saves | PASS | `settings.test.ts` covers a legacy value in `loadSettings`, store state, and canonical save; focused test passed. |
| R4: dead state/action/normalizer/UI removed | PASS | Targeted `rg` found only intentional migration assertions and the fixed xterm option; focused tests, typecheck, and build passed. |
| R5: remaining Terminal behavior preserved | PASS | GPU/scrollback paths remain in the store and UI; focused tests, full unit suite (89 files / 949 tests), and E2E suite (38 tests) passed. |
| Direct/search UI scenario | PASS | E2E case 11 passed for direct display and `contrast` search. |
| Terminal initialization scenario | PASS | Fixed xterm option is present in the terminal factory; production build passed. |
| Legacy storage scenario | PASS | Store regression test passed with legacy contrast plus unrelated GPU state. |
| GPU/scrollback independence scenario | PASS | Existing scrollback E2E interaction passed; GPU persistence fixture paths remained covered by the full suites. |
| Non-goals and resolved decision | PASS | Diff/reference inspection found no changes to remaining settings or terminal color behavior; explicit default remains `1` per the user's decision. |

Commands run: focused settings tests (2 files, 6 tests), `npm run typecheck`,
`npm run build`, `npm run test` (89 files, 949 tests), `npm run test:e2e` (38
tests), and `git diff --check`; all passed. `git diff --check` reported only
normal LF/CRLF conversion warnings.

Independent verification limitation: the fresh blind verifier was requested,
waited on twice, asked to return a bounded result, and then shut down after no
result. No independent verifier verdict is claimed; the matrix above is the
direct mechanical fallback. No source implementation repair was needed during
verification.
