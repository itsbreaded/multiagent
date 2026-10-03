# Implementation Plan: Detached-window control parity

Plan Status: completed
Source spec: `specs/done/076-detached-window-control-parity.md` (Status: done)

## Verified Repository Facts

- `src/renderer/src/App.tsx` mounts `Sidebar` and `PaneGrid` in every renderer,
  but currently mounts `SessionBrowser`, `SettingsPanel`, and the top-level
  directory picker only when `!isDetachedWindow`. `CommandPalette` is already
  mounted in both modes from the existing dirty implementation.
- `src/renderer/src/components/TabBar/index.tsx` renders the primary four-button
  `ChromeButtonCluster` but replaces it with palette-only chrome for detached
  windows. The existing cluster already uses the requested image assets and
  window-local store actions.
- `usePanesStore.toggleSidebar()` currently returns the unchanged state for a
  detached renderer, although `sidebarOpen` is renderer-local and
  `Sidebar` already renders based on it. `initDetached()` starts the local
  sidebar open.
- `src/renderer/src/commands/registry.ts` filters Settings and Session Browser
  commands with `!ctx.isDetachedWindow`. `CommandPalette` already builds its
  context from the current renderer's active tab/focused pane.
- `useGlobalKeyboard()` in `App.tsx` dispatches the configured sidebar and
  palette shortcuts in every renderer, but suppresses Session Browser in a
  detached renderer. Escape closes the shared local overlay state.
- `SessionBrowser` uses renderer-local `usePanesStore` resume/repair actions and
  `useSessionsStore` data fed by the broadcast `sessions:updated` event. Its
  repair dialog is nested in the component, so mounting the component is
  sufficient for its local dialog path.
- `SettingsPanel` uses renderer-local settings UI and existing main IPC-backed
  settings stores. Jira settings retrieve/save credentials through main-owned
  IPC; `App.tsx` intentionally gates Jira project synchronization and status
  lookup to the primary renderer.
- The sidebar-first docs and archived specs require detached sidebars and forbid
  restoring the old top tab strip. Archived 014/075 intentionally hid Settings
  and Session Browser in detached windows, but current code provides no
  ownership/security boundary that requires that UI gate; this follow-up
  supersedes that narrow parity decision without rewriting archived history.
- A real Electron pre-change reproduction after `npm run build` created a
  detached window and observed button-title counts: collapse/open `0`, Settings
  `0`, Session Browser `0`, command palette `1`; the same detached window still
  rendered its owned sidebar and tab.

## Scope and Coverage

| Requirement/scenario | Planned task(s) | Verification |
| --- | --- | --- |
| R1-R5; four controls, local collapse, overlays, palette | T1, T2 | component/store tests and detached Electron test |
| R6; main-owned settings/Jira boundaries | T2, T3 | targeted Settings/Jira tests, source audit, E2E no duplicate lookup assertion |
| R7-R8; sidebar, pane, terminal, lifecycle preservation | T3 | existing focused suites plus detached E2E regression matrix |
| R9; regression coverage and mandated checks | T3, T4 | targeted tests, full unit/typecheck/build/E2E/diff/status |
| R10; durable classification/evidence | T4 | this plan's final parity matrix and verification evidence |
| Non-goals and resolved ownership decisions | T1-T4 | source audit and E2E assertions for no tab strip/transfer semantics |

## Architecture and Data Flow

The detached renderer remains a normal App instance with `isDetachedWindow`
set by `initDetached()`. `TabBar`, `App`, the command registry, and the panes
store should share the same local action surfaces in both renderer modes. Main
continues to own cross-window PTY routing, tab ownership, provider cleanup,
Jira persistence/status network access, and session indexing. Overlay open,
focus, query state, dialog state, and Escape handling stay in the renderer that
opened the overlay.

The only special detached behavior retained is Jira lookup suppression in
`App.tsx`. Hydrating Jira settings in a detached renderer is allowed so the
Settings → Jira form is truthful; `syncJiraProjects` remains primary-only.
Settings changes continue to invoke the existing main-owned persistence path.

## Detached Parity Audit Matrix

| Behavior | Classification | Evidence/action |
| --- | --- | --- |
| Sidebar collapse/expand control and shortcut | broken/repaired | current no-op and missing icon; T1 enables local state and tests click/shortcut |
| Sidebar navigation and selection | supported and working | shared `Sidebar`/`TabSections`; T3 preserves detached owned-tab assertions |
| Sidebar reorder, close, explicit move, and return | supported and working | existing transfer protocol/tests; T3 reruns representative detached movement |
| Command palette button, shortcut, focus, Escape | broken/repaired | current button/overlay already partly repaired; T1/T2 add parity assertions |
| Settings button, command, overlay, search, section navigation, Escape | broken/repaired | current detached guards; T2 removes guards and tests focus/reopen |
| Session Browser button, command, search, repair, resume, Escape | broken/repaired | current detached guards; T2 removes guards and tests local resume/repair seams |
| Directory picker from detached command/sidebar flow | broken/repaired | App-level guard currently hides it; T2 mounts it in detached renderer |
| Jira persistence/credential decryption | supported and working, main-owned | existing Jira IPC/store; T2 only hydrates detached form, no renderer persistence |
| Jira sidebar status network lookup/polling | intentionally main-window-only | existing `App.tsx` primary-only sync remains; document and assert no detached lookup |
| Pane focus, drag/drop, split/swap, grid resize | supported and working | existing per-window store/IPC paths; T3 focused/E2E regression |
| Terminal input/output, resize, clipboard, context menu, title/CWD | supported and working | existing PTY routing/xterm paths; T3 real detached terminal output check |
| Agent launch/status/session close/refresh/resume | supported and working | existing provider/session paths; T3 preserves close/transfer/resume tests |
| IPC listeners and ownership/transfer cleanup on close | supported and working | existing 075 lifecycle changes; T3 reruns native close/transfer cases |
| Top tab strip | intentionally absent | archived sidebar-first design and existing E2E `.tab-strip` absence checks |

## Implementation Tasks

### T1 - Share full chrome and enable local detached sidebar state (completed)

- Dependencies: none.
- Requirements/scenarios: R1-R2, palette control portion of R5.
- Files and symbols:
  - `src/renderer/src/components/TabBar/index.tsx`: `ChromeButtonCluster`,
    `leftChromeWidth`, `TabBar`.
  - `src/renderer/src/store/panes.ts`: `toggleSidebar`, detached initial state.
  - `src/renderer/src/components/TabBar/index.test.tsx` and a focused panes
    store test if the current test seam supports detached state setup.
- Current behavior: detached chrome has one palette button and detached
  `toggleSidebar` is a no-op.
- Implementation change: render the same four image-icon controls in both
  windows, size the detached chrome from the same sidebar/control-width rule,
  and make `toggleSidebar` operate on local `sidebarOpen` in detached windows.
  Preserve `initDetached()` open state and no tab-strip rendering.
- Invariants and edge cases: click targets remain `no-drag`; collapsed chrome
  still exposes the reopen control; no layout save or ownership transfer is
  introduced; active tab/focus is unchanged.
- Verification: component assertions for all four titles in detached mode and
  store assertions that detached toggles change only `sidebarOpen`.
- Completion evidence: `TabBar` renders the shared four-button image-icon
  cluster in both renderer modes and `toggleSidebar` changes only local
  `sidebarOpen`. `npx vitest run ...` passed the TabBar and panes assertions.

### T2 - Mount and dispatch detached overlays through existing local paths (completed)

- Dependencies: T1.
- Requirements/scenarios: R3-R6 and Settings/Session Browser acceptance cases.
- Files and symbols:
  - `src/renderer/src/App.tsx`: `useGlobalKeyboard`, overlay render guards,
    Jira hydration/sync effects.
  - `src/renderer/src/commands/registry.ts`: Settings/Session Browser enabled
    predicates.
  - `src/renderer/src/components/CommandPalette/index.tsx`: current command
    context only if shared parity assertions expose a gap.
  - `src/renderer/src/components/SessionBrowser/index.tsx` and
    `SettingsPanel/index.tsx` only for focus/role hooks or confirmed defects.
  - relevant component tests under `src/renderer/src/components/**`.
- Current behavior: detached App suppresses Settings, Session Browser, and
  top-level directory picker; keyboard/registry paths suppress Session Browser
  and all Settings commands.
- Implementation change: remove only the detached UI/command gates for flows
  proven window-local. Keep Jira project sync/status lookup primary-only; allow
  detached Jira Settings to hydrate through the existing read-only main IPC so
  the form does not show a false default. Do not add a second dispatch path.
- Invariants and edge cases: overlays are mutually exclusive through existing
  store actions; first text input receives focus; Escape closes only the local
  overlay; Settings and Session Browser reopening remounts clean local state;
  session resume uses the invoking renderer's active tab/pane; Jira tokens
  remain transient and never enter renderer persistence.
- Verification: component tests cover command availability in detached context,
  focus/close/reopen, and Session Browser/Settings render seams. Existing Jira
  tests and source checks confirm encrypted main-owned calls remain unchanged.
- Completion evidence: detached registry includes Settings and Session Browser,
  App mounts all supported overlays in either renderer, and detached Jira
  hydration remains separate from primary-only status synchronization. Focused
  renderer tests passed 5 files / 72 tests.

### T3 - Extend real Electron parity regression coverage (completed)

- Dependencies: T1-T2.
- Requirements/scenarios: R5-R9 and all lifecycle/terminal/sidebar scenarios.
- Files and symbols:
  - `e2e/startup.spec.ts`: add a test near the existing detached palette and
    transfer tests using `tearOffTab`.
  - Existing `WindowManager`, panes, transfer, terminal, SessionBrowser,
    CommandPalette, Settings, and TabBar tests as applicable; do not weaken
    current close/transfer assertions.
- Current behavior: E2E covers detached palette, transfers, PTY output, and
  close, but not the three missing controls or their overlay interactions.
- Implementation change: assert detached four-control rendering, collapse and
  reopen while preserving the owned tab, Settings open/focus/Escape/reopen,
  Session Browser open/focus/Escape/reopen, Ctrl+Shift+P, representative tab
  movement/return, terminal output, and native close. Assert primary controls
  and no `.tab-strip` regression. Use fixture data already created by the
  suite; avoid credential-bearing or external Jira calls.
- Invariants and edge cases: close detached windows in test cleanup; tolerate
  auto-close after last tab removal; distinguish explicit return from native
  close; avoid asserting detached Jira network traffic beyond the existing
  primary-owned boundary.
- Verification: targeted Playwright test with the real Electron app, plus
  existing detached tests.
- Completion evidence: the pre-change real Electron reproduction recorded
  collapse/open `0`, Settings `0`, Session Browser `0`, palette `1`. The new
  detached-controls test passed in a real Electron run and verified four
  controls, no tab strip, click and Ctrl+B sidebar collapse/reopen, Settings
  and Session Browser focus/Escape/reopen, Ctrl+Shift+O, and Ctrl+Shift+P
  dispatch into Settings. Existing detached transfer, terminal, and close
  tests remained green.

### T4 - Record audit evidence and complete required checks (completed)

- Dependencies: T1-T3.
- Requirements/scenarios: R7-R10 and all non-goals.
- Files and symbols:
  - adjacent plan parity matrix/evidence;
  - `docs/multi-window-and-layout.md` for the current detached sidebar/control
    ownership rule and primary-only Jira lookup note if mechanism detail is
    needed;
  - `AGENTS.md` only for a terse guardrail if the new local-control invariant
    is decision-time durable.
- Current behavior: docs say detached sidebars remain open and archived 014/075
  describe primary-only overlays, which no longer matches the supported
  follow-up contract.
- Implementation change: update the mechanism docs and rule/doc pointers only
  where needed; do not rewrite archived specs 072, 074, or 075. Complete the
  matrix with exact evidence and note any remaining UNVERIFIED runtime area.
- Invariants and edge cases: no invented runtime result; no top tab strip; no
  transfer/PTY/provider ownership changes; no credential or transcript writes.
- Verification: run targeted tests, `npm run typecheck`, `npm run test`,
  `npm run build`, `npm run test:e2e`, `git diff --check`, and `git status`.
- Completion evidence: the parity matrix is complete; all required commands
  below passed; `git diff --check` passed; and the plan is ready for
  independent `verify-spec` review.

## Cross-Cutting Constraints

- Preserve sidebar-first navigation, per-window owned rows, detached sidebar
  visibility, no top tab strip, explicit transfer/return, and native-close
  terminal semantics.
- Reuse the existing Zustand actions, command registry, overlay components,
  preload IPC, and main-owned services. Do not create a second command or
  transfer protocol.
- Keep `sidebarOpen`, overlay open state, focus, search, and dialog state local
  to the renderer that owns the window. Main remains authoritative for shared
  settings persistence, session indexing, Jira credentials/status, PTY routes,
  provider lifecycle, and ownership cleanup.
- Preserve overlay styling, image-icon rules, focus trapping/first-control
  focus, Escape behavior, and the existing no-flow-control/no-PATH-rewrite
  terminal constraints.

## Risks, Migration, and Rollback

- Shared Settings edits from two windows can race visually. Existing persisted
  settings/main IPC semantics remain authoritative; no new synchronization
  protocol is introduced. Reopening the panel rehydrates the renderer cache.
- Detached Jira Settings could show stale/default data if hydration stays
  primary-only. T2 hydrates settings without enabling detached status lookup.
- Enlarging detached chrome could alter drag regions or layout. Keep button
  elements explicitly `no-drag` and preserve the sidebar/PaneGrid geometry.
- Rollback is source-only and does not modify layout, transcript, provider, or
  credential data; it would restore the known missing-control behavior.

## Handoff Checklist

- [x] Existing dirty work is preserved; archived specs 072/074/075 are untouched.
- [x] Main/detached rendered reproduction is recorded before and after the fix.
- [x] All three controls have explicit supported/main-only/broken classifications.
- [x] Component/store tests cover local controls, dispatch, focus, Escape, and reopen.
- [x] Real Electron coverage proves detached rendering and representative behavior.
- [x] Sidebar, transfer, PTY, terminal, agent, session, and close regressions remain green.
- [x] Required commands, diff check, status, and the Jira manual limit are recorded.

## Plan Review

Verdict: APPROVED

Coverage: The plan maps all ten requirements, each acceptance scenario, the
sidebar-first/non-goal constraints, the resolved support decisions, and the
main-owned Jira boundary to T1-T4. It records the actual pre-change Electron
button counts rather than relying on source tracing.

Repository checks: The named `App.tsx`, `TabBar`, panes store, command registry,
`SettingsPanel`, `SessionBrowser`, existing component tests, and
`e2e/startup.spec.ts` seams were inspected. The plan's proposed local overlay
path matches existing renderer-owned Zustand state and sender-scoped IPC
handlers. The no-tab-strip, transfer, terminal, and detached-close paths are
covered by existing tests that T3 preserves and reruns.

Falsification pass: The review checked the main failure branches: a detached
sidebar toggle is currently a no-op; detached App overlay guards prevent
Settings/Session Browser and the directory picker from mounting; registry and
keyboard gates suppress the corresponding commands; Jira status lookup is
already primary-gated and must remain so; and the detached window's top chrome
currently omits three existing image-button actions. T1/T2 address each
load-bearing gap without adding a second dispatch or transfer path. Focus,
Escape, overlay exclusivity, detached active-pane context, and collapsed
reopen behavior are explicit verification points.

Findings: No blocking or important finding remains. The support decision for
Settings and Session Browser is explicitly authorized by the user's request to
decide parity from current sidebar-first semantics, and the plan preserves
main-owned credential/status boundaries. Routine visual/platform differences
remain covered by the real Electron check and are not treated as source-only
proof.

Reviewer limitation: No separate delegated reviewer was available in this
session. This is a same-session fallback review, not independent reviewer
evidence; the repository/code falsification pass above is recorded
transparently.

Required corrections: None.

Manual items: Live external Jira credentials/network behavior is not exercised
by the isolated E2E profile and remains UNVERIFIED; the plan explicitly keeps
that path main-owned and avoids external calls.

## Implementation Summary

Implemented detached control parity without changing ownership or transfer
protocols. `TabBar` now shares the primary four-button chrome in detached
windows; `usePanesStore.toggleSidebar` is local in both modes; and App mounts
Settings, Session Browser, directory picker, and command palette in the
renderer that owns the window. Keyboard and command-registry gates now dispatch
sidebar/session/settings actions in detached windows. Jira settings hydrate
through existing main IPC, while primary-only Jira status synchronization and
network lookups remain unchanged. The durable audit matrix above records the
remaining intentional main-only behavior and preserved lifecycle/terminal
behaviors.

## Verification Evidence

### Requirement matrix

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R1-R2: detached four-button chrome and local sidebar collapse/shortcut | PASS | `TabBar/index.test.tsx`, `panes.test.ts`; real Electron control test checks four titles, click collapse/reopen, Ctrl+B, owned row preservation, and no `.tab-strip`. |
| R3: detached Settings overlay/focus/search/Escape/reopen | PASS | `CommandPalette/index.test.tsx`; real Electron control test opens Settings, asserts focused Search settings, closes/reopens with Escape, and opens it through palette dispatch. |
| R4: detached Session Browser search/selection/repair/resume/dialog path | PASS | `SessionBrowser/index.test.tsx` covers summary filtering and deep search; `SessionBrowser` uses the invoking renderer's `usePanesStore` resume/repair actions and nested `DirPicker`; real Electron control test opens, focuses, closes, reopens, and exercises Ctrl+Shift+O in a detached renderer. |
| R5: detached command palette and active-pane/tab dispatch | PASS | Existing detached shortcut E2E plus new control test; command palette component test confirms detached Settings/Session Browser commands are offered. |
| R6: main-owned settings/Jira boundaries | PASS | `App.tsx` hydrates Jira settings in either renderer but gates `syncJiraProjects` on `isDetachedWindow`; Jira store still invokes existing main-owned encrypted credential/status handlers. |
| R7-R8: sidebar, transfer, pane, terminal, agent/session, close, and main regressions | PASS | Full `npm run test:e2e` passed 36 tests, including detached PTY I/O, movement/return, pane drag, native close/process death, agent resume, and primary Settings flows; existing lifecycle tests remained green. |
| R9: deterministic and real Electron regression coverage | PASS | Focused renderer/store run passed 5 files / 72 tests; targeted detached Electron test passed; full unit/E2E gates passed. |
| R10: durable complete classification | PASS | The audit matrix above classifies every requested behavior, including the intentional primary-only Jira status lookup and absent top tab strip. |

### Acceptance and non-goal checks

- PASS: pre-change Electron reproduction observed collapse/open `0`, Settings
  `0`, Session Browser `0`, palette `1`; post-change real Electron observed
  all controls and interactions.
- PASS: sidebar ownership, transfer/return distinction, PTY/provider cleanup,
  native detached close, terminal behavior, and no top tab strip remain
  covered by the full E2E suite and existing 075 lifecycle changes.
- PASS: no archived spec 072/074/075 was rewritten; no second dispatch or
  transfer protocol was added; no transcript, provider config, or credential
  data was deleted or moved.
- PASS: no new Jira polling, writes, credential-bearing URLs, renderer token
  persistence, or external network calls were introduced.
- UNVERIFIED (deliberate manual limit): live external Jira credentials/network
  behavior was not exercised in the isolated E2E profile. The main-owned
  boundary and detached lookup suppression are verified from source and tests.

### Commands

- `npm run typecheck`: PASS.
- `npm run test`: PASS, 88 files / 934 tests.
- `npm run build`: PASS.
- `npm run test:e2e`: PASS, 36 tests.
- `git diff --check`: PASS.
- `git status --short --branch`: inspected; pre-existing lifecycle changes and
  archived-075 artifacts were preserved.

### Verification repair record

No implementation repair was needed during verification. The only corrected
verification issue was a stale mojibake placeholder locator in the newly added
E2E assertion; it was replaced with the stable textbox role, then the targeted
test and full E2E suite passed.
