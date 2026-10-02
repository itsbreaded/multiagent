# Implementation Plan: Sidebar-first tab navigation cleanup

Plan Status: completed <!-- review | changes-requested | approved | in-progress | completed -->
Source spec: `specs/done/073-sidebar-first-tab-navigation-cleanup.md` (Status: done)

## Verified Repository Facts

- `TabBar` renders window chrome and no longer renders tab entries, but it still
  reads `tabOverflowMode` to decide whether the primary chrome's left control
  cluster is rendered in `TabBar` or in an alternate `App` wrap layout.
- `App` contains a second flex layout used only for `tabOverflowMode ===
  'wrap'`; the normal layout already provides the current chrome, sidebar, and
  pane content arrangement for both primary and detached windows.
- The settings store still owns, loads, persists, and exposes
  `tabOverflowMode`; the settings panel still renders `TabOverflowSetting` and
  searches for its old vocabulary.
- `PanesStore.receiveTab` has no production caller. Its only remaining caller
  is an obsolete store test. `returnTab`, `detachTab`, detached ownership maps,
  and synchronization actions have active transfer/lifecycle callers.
- `TabSections` filters visible rows through
  `isTabVisibleInCurrentWindow`, so the primary-window detached-proxy branch
  inside the visible-row loop is unreachable. The detached ownership map is
  still read by pane right-drag target resolution and must remain.
- `.tab-strip` appears in dead renderer CSS and in intentional tests that
  assert the retired top surface is absent. The latter assertions are
  regression coverage and must remain.
- Shared IPC retains `tab:absorb`, `tab:release`,
  `tab:absorb-committed`, `tab:return`, `tab:release-applied`, and related
  transfer channels used by backend movement and rollback. They are not
  removable UI leftovers.

## Scope and Coverage

| Requirement/scenario | Planned task(s) | Verification |
| --- | --- | --- |
| R1, R2, R3; no top-tab UI; no primary proxy rows | T1 | Component tests, source audit, full test/build/E2E matrix |
| R4; remove obsolete overflow setting and wrap layout; legacy persistence safe | T2 | Settings tests, chrome/layout tests, source audit |
| R5; comments, IPC descriptions, docs, tests, migration references | T3 | Focused `rg` audit, docs review, test suite |
| R6, R7; preserve transfers, ownership, sidebar/pane behavior | T1, T4 | Existing transfer/store/sidebar tests plus full unit/E2E tests |
| R8, R9; regression and repository verification | T4 | `npm run typecheck`, `npm run test`, `npm run build`, `npm run test:e2e`, `git diff --check` |
| S1/S2; primary and detached sidebar ownership/navigation | T1, T4 | `TabSections` tests and Electron detached-window scenarios |
| S3/S4; movement, close races, and safe legacy settings | T2, T4 | Store/window lifecycle tests and settings persistence assertion |
| S5; only intentional historical/transfer references remain | T3, T4 | Final targeted search with documented allowlist |

## Architecture and Data Flow

The renderer has one structural chrome component (`TabBar`) and an app-level
layout (`App`). The cleanup removes the obsolete alternate layout decision and
leaves the normal layout as the sole current composition: `AppChrome`, update
or recovery banners, then `Sidebar` beside the pane content. Detached windows
continue to use the same chrome/content composition and receive their sidebar
from the existing detached initialization path.

Sidebar rows are derived from the local ownership predicate. The primary
renderer may retain detached records in its store for IPC/focus/pane-transfer
bookkeeping, but those records are not visible rows. Detached renderers hold
their local tabs directly. Pane right-drag target resolution still consults
`detachedWindowTabIds` to identify the target window; this map is state
bookkeeping, not a navigation surface.

Tab movement remains a main/renderer ownership protocol. Explicit tear-off,
return, absorb, release, PTY route changes, commit/rollback acknowledgements,
versioned synchronization, and native detached-window cleanup are outside the
dead top-tab UI and remain intact.

Settings persistence is a renderer-local JSON mirror. Removing the field from
the persisted shape and serializer means an old `tabOverflowMode` value is
ignored on load and discarded on the next save; no destructive migration of
unrelated settings is needed.

## Implementation Tasks

### T1 - Remove unreachable/dead renderer tab-strip paths (completed)

- Dependencies: none.
- Requirements/scenarios: R1, R2, R3, R6, R7; S1, S2.
- Files and symbols:
  - `src/renderer/src/assets/main.css`: retired `.tab-strip` scrollbar rules.
  - `src/renderer/src/store/panes.ts`: `PanesStore.receiveTab`, its
    implementation, and comments that still describe rendered detached
    proxies or the removed receive path.
  - `src/renderer/src/store/panes.test.ts`: the test block whose only purpose
    is to call `receiveTab`; retain all adjacent initialization, detached sync,
    pane-transfer, and status coverage.
  - `src/renderer/src/components/Sidebar/TabSections.tsx`: the unreachable
    primary detached-proxy branch and selectors/helpers used only by it.
    Keep the shared visible-row predicate and `detachedWindowTabIds` lookup
    used by `PaneRow` cross-window swap resolution.
  - `src/renderer/src/components/Sidebar/TabSections.test.tsx` and related
    sidebar tests: adjust assertions/fixtures only where they describe the
    removed rendering branch; strengthen local ownership and detached-sidebar
    navigation coverage where needed.
  - `src/renderer/src/components/TabBar/index.test.tsx`: retain the absence of
    `.tab-strip` and chrome assertions, but remove the wrap-mode test and its
    obsolete setting setup once T2 removes that setting.
- Current behavior: the visible predicate already hides primary detached
  records, while dead branch code and receive action/comments imply a second
  UI model.
- Implementation change: delete only unreachable render/action/test code;
  preserve all ownership maps, local detached initialization, explicit return,
  pane transfer, focus, synchronization, and close cleanup paths.
- Invariants and edge cases: a detached record may remain in state without a
  rendered proxy; pane target resolution must still find a detached owner;
  stale sync must not reclaim a returned or closed tab; no transfer channel is
  removed in this task.
- Verification: TypeScript catches action interface callers; focused store and
  sidebar tests prove no proxy row and correct local navigation/reorder/pane
  behavior; targeted search confirms `receiveTab` has no production reference.
- Completion evidence: no production `receiveTab` symbol/call remains, the
  dead proxy branch is gone, `.tab-strip` CSS is gone, intentional absence
  assertions remain, and the ownership map still participates in pane swaps.
  `npm run typecheck` passed and the focused sidebar/store/chrome run passed
  71 tests in 3 files.

### T2 - Remove the obsolete overflow preference and wrap-only composition (completed)

- Dependencies: T1 for the chrome test shape.
- Requirements/scenarios: R1, R4, R5; S1, S4.
- Files and symbols:
  - `src/renderer/src/store/settings.ts`: remove the state/action,
    persisted-field type, default, load coercion, save serialization, and
    migration-shaped references for `tabOverflowMode`.
  - `src/renderer/src/App.tsx`: remove the overflow selector, `isWrapLayout`,
    `LeftChrome` import, and alternate wrap-only branch; retain the normal
    chrome/sidebar/content layout and detached guards.
  - `src/renderer/src/components/TabBar/index.tsx`: remove overflow-setting
    usage and the conditional that only moved the left chrome cluster for wrap
    mode; retain window drag/maximize controls and the primary/detached chrome
    differences.
  - `src/renderer/src/components/TabBar/index.tsx`: remove `LeftChrome` if it
    becomes unreachable after the alternate layout is deleted.
  - `src/renderer/src/components/SettingsPanel/index.tsx` and
    `SettingsPanelParts.tsx`: remove overflow search vocabulary, prop plumbing,
    and rendering while preserving appearance-section behavior for the git
    branch setting and all unrelated settings.
  - `src/renderer/src/components/SettingsPanel/settings/TabOverflowSetting.tsx`:
    delete the retired control.
  - `src/renderer/src/components/SettingsPanel/settings/settings.test.tsx` and
    `src/renderer/src/store/settings.test.ts`: remove control assertions and
    add a persistence assertion that an old `tabOverflowMode` value is not
    re-emitted when a current setting is saved.
- Current behavior: the old preference changes chrome/sidebar placement even
  though no top tabs exist and remains visible/searchable in Settings.
- Implementation change: make the existing normal composition unconditional;
  ignore legacy JSON fields by omitting them from the current persisted shape
  and serializer. Do not replace the setting with a new sidebar layout option.
- Invariants and edge cases: old localStorage containing the value must not
  crash startup or affect detached windows; unrelated settings and current
  appearance filtering must remain intact; window controls must remain usable.
- Verification: settings tests prove legacy data is safely discarded on save;
  chrome tests prove primary and detached chrome remain tab-free; targeted
  source search finds no live overflow setting/wrap branch.
- Completion evidence: the setting file and state API are gone, no wrap-only
  app branch remains, and the normal layout passes all existing chrome/sidebar
  assertions. `npm run typecheck` passed; the focused settings/chrome/sidebar
  run passed 24 tests in 4 files; the targeted source search found only the
  intentional legacy-settings regression assertions.

### T3 - Reconcile comments, docs, shared IPC wording, and retained-reference allowlist (completed)

- Dependencies: T1 and T2.
- Requirements/scenarios: R5, R6; S5.
- Files and symbols:
  - `src/shared/types.ts`: rewrite the `tab:absorb` description so it does
    not claim a current top-tab drag caller.
  - `src/renderer/src/store/panes.ts` and `src/renderer/src/store/panesIpc.ts`:
    update comments that describe the removed proxy/receive path while keeping
    transfer protocol comments accurate.
  - `docs/multi-window-and-layout.md`: remove stale tab-bar wording and keep
    the sidebar ownership, top-chrome, explicit return, terminal detached
    close, and transfer-ack mechanisms.
  - `docs/testing.md`, focused tests, and any current source comments found by
    the final audit: describe intentional absence assertions and preserved
    backend transfer coverage without implying old UI callers.
- Current behavior: architecture docs are mostly current but retain a few
  historical tab-bar/proxy phrases and one misleading shared IPC description.
- Implementation change: update only current guidance/mechanism comments;
  leave archived 072 spec/plan history intact as historical record.
- Invariants and edge cases: documentation must continue to name all retained
  transfer/lifecycle paths so future cleanup does not remove required backend
  behavior; no comment change may alter runtime code.
- Verification: review the diff and run targeted searches for `.tab-strip`,
  `receiveTab`, overflow vocabulary, proxy wording, and transfer channel names.
- Completion evidence: current docs no longer present top tabs as navigation,
  and the final plan contains the intentional retained-reference list. Current
  comments/docs now describe sidebar ownership and internal detached records;
  the retained transfer search matches the allowlist in this plan.

### T4 - Regression matrix and final audit (completed)

- Dependencies: T1-T3.
- Requirements/scenarios: all requirements and scenarios, especially R7-R9;
  S1-S5.
- Files and symbols: affected focused tests, `e2e/startup.spec.ts` and other
  existing detached/sidebar scenarios, plus no new production surface unless a
  missing regression seam is discovered.
- Current behavior: the sidebar-first implementation already has tests for
  hidden top tabs, ownership-scoped reorder, sidebar movement/return, and
  detached close; cleanup must keep those tests meaningful rather than
  deleting them as stale.
- Implementation change: update fixtures/assertions to the cleaned APIs and
  add only focused regression coverage for newly exposed cleanup boundaries.
- Invariants and edge cases: primary and detached ownership filtering,
  individual close, explicit return, native detached close, pane drag/drop,
  PTY routing, session hydration, and terminal behavior must remain unchanged.
- Verification:
  1. `npm run typecheck`
  2. `npm run test`
  3. `npm run build`
  4. `npm run test:e2e`
  5. `git diff --check`
  6. final targeted `rg` audit with the allowlist below.
- Completion evidence: every check is PASS or precisely recorded as
  `UNVERIFIED`; the spec and plan include requirement/scenario evidence and
  the plan is ready for archival. `npm run typecheck`, `npm run test`,
  `npm run build`, `npm run test:e2e`, and `git diff --check` all passed.

## Cross-Cutting Constraints

- Do not reset, overwrite, or reformat unrelated dirty work from the archived
  072 implementation or sidebar-resize fix.
- Do not remove `tab:absorb`, `tab:release`, `tab:absorb-committed`,
  `tab:return`, `tab:release-applied`, `tab:state-sync`, tear-off readiness or
  cancellation, PTY routing, ownership maps, tombstones, or detached-window
  cleanup solely because top-tab UI no longer calls them.
- `.tab-strip` absence assertions in tests and E2E are intentional and should
  remain. Archived specs/plans may mention the old implementation as history.
- Sidebar rows must continue to use the ownership predicate; state-only
  detached records must not become rendered navigation entries.
- No behavior change to sidebar movement/reorder/close, pane drag/drop,
  terminal/session lifecycle, or detached-window close semantics.

## Risks, Migration, and Rollback

- Removing `receiveTab` or the proxy branch can accidentally remove a state
  path used by synchronization. Mitigate with production reference search,
  focused ownership tests, and preservation of `returnTab`, sync, and close
  actions.
- Removing the wrap branch can accidentally remove primary window controls.
  Mitigate with chrome tests for primary and detached windows and an E2E
  startup assertion.
- Old localStorage can contain the removed preference. Treat it as an ignored
  unknown field and overwrite it only when an existing current setting is
  saved; do not clear the whole settings object.
- If any test reveals an actual current caller of a supposedly dead symbol,
  stop deletion, document the caller, and return the plan to review rather
  than silently expanding the cleanup.

## Intentional Retained Transfer References

The following are explicitly retained and must be called out in the final
diff/docs audit: `tab:tear-off`, `tab:adopt`, `tab:tear-off-cancel`,
`tab:detached-ready`, `tab:tear-off-rolled-back`, `tab:absorb`, `tab:release`,
`tab:absorb-committed`, `tab:return`, `tab:release-applied`, `tab:closed`,
`tab:state-sync`, `detachedWindowTabIds`, `detachedWindowActiveTabIds`,
`returnTab`, `detachTab`, PTY route/ownership bookkeeping, tombstones, and
detached-window resource cleanup. These support explicit sidebar movement,
pane movement, synchronization, rollback, focus, and terminal cleanup; they
are not top-tab UI remnants.

## Handoff Checklist

- [ ] Plan is independently reviewed and marked approved.
- [ ] Implementation changes are limited to dead tab-strip-era code,
      documentation, tests, and the specified persistence cleanup.
- [ ] Existing dirty work is preserved.
- [ ] Intentional transfer references are rechecked after implementation.
- [ ] Full verification commands and any limitations are recorded.

## Plan Review

Verdict: APPROVED

The plan's requirements/scenario matrix covers the dead renderer paths,
obsolete setting and wrap layout, current documentation, retained transfer
infrastructure, sidebar ownership, detached-window behavior, and the complete
verification sequence. Repository checks confirmed the named symbols and
current test seams: `receiveTab` has no production caller, the primary proxy
branch is behind the visible ownership predicate, `detachedWindowTabIds` is
still used by pane swap resolution, and the overflow setting is wired through
the settings store, App layout, TabBar, and settings panel.

The blind delegated reviewer was unavailable after two bounded waits and was
shut down. Approval is therefore a same-session fallback review, not
independent reviewer evidence. No blocking or important finding was found in
the fallback coverage/falsification pass. The implementation must still prove
the ownership, transfer, persistence, and detached-window invariants with the
listed tests and commands.

## Implementation Summary

Removed dead `.tab-strip` CSS, the production-unused `receiveTab` store path
and test, and the unreachable primary detached-proxy renderer branch while
retaining detached ownership maps and pane-swap resolution. Removed the
obsolete `tabOverflowMode` state/UI/persistence and wrap-only layout, safely
ignoring legacy persisted values and dropping them on the next current-setting
save. Reconciled current comments/docs and preserved the backend transfer,
PTY-routing, synchronization, rollback, and detached-window cleanup paths.

The intentional retained transfer references are listed above in this plan;
the final audit found only those references, historical archived-spec mentions,
and deliberate top-tab absence assertions outside the removed code.

## Verification Evidence

- `npm run typecheck` — PASS.
- `npm run test` — PASS, 87 files and 913 tests.
- `npm run build` — PASS.
- `npm run test:e2e` — PASS, all 29 Electron tests.
- `git diff --check` — PASS; only normal line-ending warnings were emitted.
- Focused T1 run — PASS, 3 files and 71 tests.
- Focused T2 run — PASS, 4 files and 24 tests.
- Final stale-symbol audit — PASS: only intentional `.tab-strip` absence
  assertions and the legacy-settings regression test remain for removed terms.
- Final retained-transfer audit — PASS: transfer channels, ownership maps,
  return/detach actions, PTY routing, tombstones, and detached cleanup remain
  in the documented allowlist.
- Independent blind plan review — UNAVAILABLE after two bounded waits and
  explicit shutdown; the plan records the same-session fallback approval.
- Independent blind verification — UNAVAILABLE after two bounded waits and
  explicit shutdown; the matrix below is the required same-session fallback.

### Verification matrix

- R1 PASS — source audit found no production `.tab-strip` CSS/rendering path;
  `TabBar/index.test.tsx` and `e2e/startup.spec.ts` assert no top tab surface
  while chrome remains present.
- R2 PASS — `receiveTab` is absent from production code and only its obsolete
  test call was removed; `returnTab`, `detachTab`, ownership maps, and IPC
  listeners remain and typecheck passes.
- R3 PASS — `TabSections` now renders only the ownership-filtered local branch;
  pane right-drag still reads `detachedWindowTabIds`, and ownership/sidebar
  tests plus the full suite pass.
- R4 PASS — `tabOverflowMode`, its action, setting component, Settings wiring,
  and wrap-only App/TabBar composition are absent. The settings test proves an
  old `wrap` value is ignored and omitted on the next save.
- R5 PASS — current comments/docs/shared IPC wording were audited; stale
  proxy/tab-bar descriptions were updated, while intentional absence tests and
  archived historical specs remain explainable.
- R6 PASS — the retained transfer allowlist includes tear-off/adopt/readiness,
  absorb/release/return, rollback, state sync, ownership maps, PTY routing,
  tombstones, and detached cleanup; full unit and E2E suites pass.
- R7 PASS — focused sidebar/store tests and 29 passing Electron tests cover
  sidebar move/return, detached close, pane/session/terminal flows; no
  unrelated product behavior was changed by the cleanup.
- R8 PASS — focused tests (71 + 24), full unit suite (87 files/913 tests),
  chrome/ownership assertions, and E2E sidebar move/return scenarios pass.
- R9 PASS — typecheck, build, unit, E2E, diff check, stale-symbol audit, and
  retained-transfer audit all pass.

### Scenario and scope matrix

- S1 PASS — primary and detached chrome have no `.tab-strip`; E2E startup
  assertions cover both windows.
- S2 PASS — primary detached records are not rendered; sidebar ownership and
  reorder tests pass.
- S3 PASS — detached move/return E2E scenarios exercise the detached sidebar;
  detached close and renderer lifecycle tests remain green.
- S4 PASS — movement/return preserves PTY and ownership behavior in E2E;
  detached close preserves terminal cleanup semantics in the full suite.
- S5 PASS — legacy settings save test plus final search prove retired terms
  cannot control current layout; unrelated settings persist through existing
  E2E settings tests.
- Non-goals PASS — no new top-chrome action, sidebar redesign, pane/terminal/
  session semantics, or detached-window ownership change was introduced;
  full E2E coverage exercises those protected paths.
- Resolved decision PASS — the obsolete overflow preference is removed rather
  than migrated, and no new sidebar layout preference was introduced.
- Dependency PASS — archived `sidebar-first-tab-navigation` behavior and the
  current layout/multi-window guardrails remain the basis for the checks.
