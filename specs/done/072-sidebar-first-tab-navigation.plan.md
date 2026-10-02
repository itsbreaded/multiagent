# Implementation Plan: Sidebar-first tab navigation

Plan Status: completed
Source spec: `specs/done/072-sidebar-first-tab-navigation.md` (Status: done)

## Verified repository facts

- `src/renderer/src/App.tsx` composes the top chrome, sidebar, and pane grid. It
  already mounts `Sidebar` in detached renderers, but `initDetached` currently
  sets `sidebarOpen: false`.
- `src/renderer/src/components/AppChrome/index.tsx` delegates to `TabBar`.
  `TabBar` currently owns the top tab strip, top-tab context menu, drag-out
  behavior, window controls, and non-tab chrome buttons. `LeftChrome` is used by
  the wrapped layout while the normal layout renders the full `TabBar` above
  the sidebar/panes.
- `Sidebar` and `TabSections` already provide sidebar tab selection, ordering,
  pane navigation, rename, project-directory selection, and individual close.
  `TabSections` also contains a primary-window proxy branch for detached tabs;
  that branch conflicts with the new per-window ownership rule.
- `src/renderer/src/store/panes.ts` contains the tab ownership model, detached
  initialization, sidebar state, tab movement actions, and the obsolete
  `duplicateTab`, `closeOtherTabs`, and `closeTabsToRight` actions.
- `src/renderer/src/store/panesIpc.ts` and
  `src/main/ipc/transferHandlers.ts` implement the existing two-phase tab/PTY
  transfer protocol. The destination-commit, source-release, acknowledgement,
  and rollback behavior must remain intact.
- `src/main/window/WindowManager.ts` currently sends `tab:return` for every tab
  owned by a detached window when that window closes. That is the main lifecycle
  behavior that must change: detached-window close must terminate ownership,
  clean PTYs, and notify the primary to remove any stale proxy without routing
  the tab home.
- The current `tab:tear-off` path creates a detached window and immediately
  lets the source renderer mark/remove its copy after the invoke resolves;
  unlike `tab:absorb`, it has no destination-ready commit or rollback step.
- The command registry and command palette still expose `tab.duplicate`; this
  is a second duplicate-tab surface that must be removed along with the store
  action and top/sidebar menu entries.

## Scope and coverage

| Spec coverage | Plan task | Evidence |
|---|---|---|
| Requirements 1–7, 13; scenarios primary navigation, detached navigation, top chrome, reorder, empty ownership | T1 | Renderer tests for chrome/sidebar ownership and existing sidebar behavior |
| Requirements 8–11; scenarios move, failed move, return, context menu | T2 | Store/component tests plus transfer-path regression tests |
| Requirement 12; scenarios detached close and no stale primary entries | T3 | Main lifecycle tests, renderer IPC tests, and focused integration/e2e check |
| All requirements and non-goals | T4 | Documentation update, typecheck/build/test/e2e results, manual evidence where automation cannot observe native window chrome |

## Architecture and data-flow decisions

1. The sidebar becomes the only tab/folder navigation surface. The top chrome
   remains a structural chrome region with window controls and existing
   non-tab controls, but it renders no tab entries, tab close affordances, tab
   context menu, or tab drag/reorder surface.
2. Sidebar visibility is ownership-scoped. In the primary renderer, visible tab
   rows are local tabs only; detached-window proxy records remain internal to
   transfer/synchronization bookkeeping and are not rendered. In a detached
   renderer, all local tabs are owned by that detached window and are the only
   rows rendered.
3. Detached initialization sets the sidebar open. Detached sidebars stay open
   for this iteration and do not expose independent collapse persistence. The
   primary sidebar keeps its existing collapse control.
4. Sidebar movement actions call the existing transfer protocol rather than
   creating a second movement implementation. The new-window path will extend
   the existing protocol with a destination-ready commit: the source copy and
   its PTY route remain authoritative until detached readiness is acknowledged
   (the existing `tab:adopt` preflight must not reroute before that point);
   a startup timeout/close rolls the target route back and leaves the source
   unchanged.
5. Closing a detached native window is terminal for its owned tabs. Main-process
   window teardown will kill/dispose their PTYs through an explicit main-owned
   lifecycle callback, clear ownership while retaining stale-sync tombstones,
   and emit a dedicated close-notification for primary proxy cleanup. It will
   not send `tab:return`.
6. Cross-window tab dragging from the old top strip is removed with that strip;
   it is not replaced with drag-to-existing-window UI in this iteration. The
   main-process `tab:absorb` handler and acknowledgement machinery remain
   internal transfer infrastructure, but no renderer tab surface invokes them
   after the top strip is removed. Pane drag/drop remains unchanged and
   continues to use its pane-specific IPC.

## Implementation tasks

### T1 — Replace the top tab strip with persistent, tab-free chrome and scope sidebar rows

**Status:** completed
**Dependencies:** none
**Covers:** requirements 1–7 and 13; primary/detached navigation, chrome,
ordering, and empty-state scenarios.

**Files and symbols**

- `src/renderer/src/App.tsx`
- `src/renderer/src/components/AppChrome/index.tsx`
- `src/renderer/src/components/TabBar/index.tsx`: `TabBar`, `LeftChrome`,
  `ChromeButtonCluster`, `WindowControls`
- `src/renderer/src/utils/paneDrag.ts`: remove the tab-only drag MIME/helper
  while preserving pane payload encoding/decoding and pane transfer helpers
- `src/renderer/src/components/Sidebar/index.tsx`
- `src/renderer/src/components/Sidebar/TabSections.tsx`
- `src/renderer/src/store/panes.ts`: `initDetached`, ownership selectors/helpers
- Existing component tests under `src/renderer/src/components/TabBar/` and
  `src/renderer/src/components/Sidebar/`

**Changes**

- Refactor `AppChrome`/`TabBar` so the top region retains draggable chrome,
  window controls, and applicable existing non-tab buttons while no longer
  rendering the top tab list, tab close button, tab-new affordance in the tab
  strip, tab reorder handlers, or top-tab context menu.
- Keep the wrapped-layout chrome composition coherent; do not leave a second
  hidden/empty tab bar that still captures tab drag or context-menu behavior.
- Set `sidebarOpen: true` during detached initialization and keep detached
  renderers from exposing a collapse path that would violate the resolved
  first-version behavior.
- Add one ownership-scoped visible-tab derivation used by `Sidebar`/`TabSections`:
  primary local rows exclude `tab.detached` records, while detached renderers
  use their local tabs. Preserve the existing internal transfer state needed by
  IPC; only the rendered navigation list is filtered.
- Remove the primary sidebar’s detached-tab proxy presentation, including its
  “in separate window” navigation rows and proxy-specific pane transfer UI.
  Detached tabs must not appear as ordinary or proxy navigation entries in the
  primary sidebar.
- Preserve active-row highlighting, tab ordering, rename, directory selection,
  pane selection, Jira/sidebar sections, and individual close behavior.
- Make sidebar reorder operate on the visible tab sequence, not absolute
  `tabs` indices. In the primary, hidden detached records remain internal
  anchors while local rows are reordered among local slots; in a detached
  renderer all owned rows participate. Drag/drop insertion markers, last-row
  detection, and `reorderTab` calls must use the same visible sequence.

**Invariants**

- `setActiveTab` and `focusPaneInTab` continue to operate against the local
  window’s ownership; no selection can activate a hidden tab owned elsewhere.
- Existing window controls and non-tab command/settings/session buttons remain
  usable where they were previously available.
- No pane tree, PTY, session, or layout semantics change as part of this task.

**Verification**

- Component tests assert that neither primary nor detached chrome renders a top
  tab entry, while window controls/non-tab chrome remain present.
- Sidebar tests assert primary filtering, detached local-only rendering,
  active-row highlighting and selection, rename commit, directory-picker
  update, pane-row selection/focus, individual close, and no stale
  cross-window rows.
- Sidebar reorder tests use an interleaved `[local, detached, local]` store and
  assert that moving visible rows changes only the local visible order and does
  not reorder or expose the detached record.
- Existing sidebar reorder and pane-navigation tests continue to pass.

### T2 — Move tab actions into the sidebar and remove obsolete tab actions

**Status:** completed
**Dependencies:** T1
**Covers:** requirements 8–11; successful/failed move, return, and context-menu
scenarios.

**Files and symbols**

- `src/renderer/src/components/Sidebar/TabSections.tsx`: sidebar tab context
  menu and movement action handlers
- `src/renderer/src/components/TabBar/index.tsx`: delete obsolete top-tab
  action/menu and drag-out entry points that are no longer reachable
- `src/renderer/src/App.tsx`: remove root `TAB_DRAG_MIME` acceptance and
  `absorbDroppedTab` invocation; keep root pane-drop acceptance and
  `transferDroppedPane` behavior unchanged
- `src/renderer/src/store/panes.ts`: remove `duplicateTab`,
  `closeOtherTabs`, and `closeTabsToRight` from the store interface/actions;
  retain individual `closeTab`, add the source-retained
  `moveTabToNewWindow` action, and keep existing transfer actions
- `src/renderer/src/store/panesIpc.ts`: move tear-off initiation here (including
  extraction of `collectPtyIds` from `TabBar`), maintain a renderer-side
  pending transfer token, cancel it before `closeTab` tears down a source tab,
  and preserve two-phase acknowledgements
- `src/renderer/src/commands/registry.ts`: remove `CommandContext.duplicateTab`
  and the `tab.duplicate` command
- `src/renderer/src/components/CommandPalette/index.tsx`: stop providing the
  removed command context field
- Related renderer tests, especially `TabSections.test.tsx`,
  `TabBar/index.test.tsx`, `panes.test.ts`, and command tests if present

**Changes**

- Add “Move Tab to New Window” to the primary sidebar tab action menu. It must
  call the new store `moveTabToNewWindow` action. That action must invoke a
  two-phase tear-off path with the tab’s current PTY ownership. The
  source keeps its local tab and PTY route until the detached renderer has
  initialized, passed the `tab:adopt` preflight, fitted its local panes, and
  sent `tab:detached-ready`; only then does main reroute the PTYs, record target
  ownership, and send the existing `tab:absorb-committed` finalization event to
  the source. `tab:adopt` must be changed to validate/stage the pending IDs
  without changing their PTY routes. The target is already local and visible in
  its own sidebar at commit time.
- Extend `tab:tear-off`/`tab:detached-ready` with an explicit pending transfer
  token/record in `WindowManager`: source window id, target window id, tab id,
  original ownership generation, PTY IDs, phase (`pending`, `ready`,
  `canceled`, or `committed`), and a bounded readiness timeout. Return the
  token from `tab:tear-off` and include it in detached init data so the target
  can identify the exact transfer. `tab:detached-ready` validates that record,
  confirms both windows are alive,
  reroutes PTYs only after validation, records target ownership, and then
  sends `tab:absorb-committed(tabId, ownerWindowId, transferId)` to the source
  to commit source release. If readiness is not received, target creation or
  preflight adoption fails, or either window closes first, main cancels the
  record, restores any PTY route that had already been changed, clears target
  pending ownership, and closes the target without changing the source tab. No
  destination row may survive a failed move.
- Bind `tab:adopt` and `tab:detached-ready` to the transfer token and validate
  the complete per-PTY route snapshot before changing any route: every listed
  PTY must still be routed to the recorded source webContents, the source and
  target generations must match, and the target must still be the pending
  target. Only after all checks pass may main transfer the complete PTY set;
  the route changes are treated as one main-process critical section. On
  rollback, restore only PTYs whose current owner is still the transfer target;
  never overwrite a newer pane transfer or close-time owner.
- Add `tab:tear-off-cancel(transferId)` for the source renderer. `closeTab`
  cancels a matching pending transfer before local PTY teardown; main marks the
  token canceled, cancels/closes the target, restores any changed route, and
  rejects all later ready/commit messages for that token. A pending source-tab
  close, target close, startup timeout, and adoption failure therefore all
  converge on the same rollback state machine.
- On rollback, main sends `tab:tear-off-rolled-back(transferId, tabId)` to the
  target before closing it. The target handler removes that token’s optimistic
  local row without killing the source-owned PTYs; native close remains the
  final cleanup if the renderer cannot receive the event.
- Remove the current eager `tearOffTab(...).then(...)` source mutation in
  `TabBar` (both `detachTab` and detached-window `removeTabLocally`). The only
  source mutation for a new-window move is the renderer listener for the
  committed token, which calls `detachTab` for a primary source or
  `removeTabLocally` for a detached source. A source close while the token is
  pending therefore has an explicit cancel path instead of relying on a stale
  ownership generation.
- Keep the existing `tab:absorb` two-phase release/ack behavior for other
  cross-window transfers, but add the same post-await source/target
  registration and ownership-generation validation before `unrecordTab`, PTY
  reroute, and commit notification. A source close after a release ack must
  fail/roll back rather than commit against a dead owner.
- Add the detached-sidebar counterpart (“Bring to Main Window”/equivalent) for
  a local tab in a detached renderer. It must use the existing return path and
  remove the detached local row only after the transfer is accepted.
- Ensure the applicable movement action is based on renderer/window ownership,
  not only on the `tab.detached` proxy flag, because a local tab in a detached
  renderer is not itself a primary proxy.
- Keep individual close, rename, project-directory, and Jira actions as
  applicable. Remove duplicate, close-other, and close-to-right actions from
  every UI and from the command registry/store API.
- Remove dead top-tab drag/reorder/tear-off and context-menu code only after
  confirming it is not needed by sidebar movement or pane transfer. Remove the
  top-tab cross-window drag/drop invocation and its renderer-only handlers;
  retain the backend `tab:absorb` handler and pane transfer implementation as
  internal infrastructure.

**Invariants**

- A failed new-window move leaves exactly one usable source tab and does not
  leave a stale or duplicate destination row. This includes target startup
  timeout, failed PTY adoption, target native close before readiness, and a
  source/target close race.
- A successful move/return preserves tab identity, pane tree, PTY ownership,
  and active-tab behavior.
- Store action return values and the existing transfer acknowledgement contract
  remain truthful; no-op applies stay silent so main can roll back/time out.

**Verification**

- Menu tests assert the movement action is present in the correct window and
  duplicate/bulk-close actions are absent everywhere.
- Store/IPC tests cover successful move, failed move with source retention,
  successful return, no duplicate/stale rows, and tear-off readiness timeout/
  rollback with PTY route restoration. They also cover source-tab cancellation,
  target close before ready, and adoption failure, asserting the source tab and
  PTY owner remain unchanged.
- Root-drop regression tests assert pane drops still call local/cross-window
  pane transfer while a tab-drag MIME payload is ignored and cannot invoke
  `tab:absorb`.
- Main transfer tests assert that `tab:absorb` cannot commit after a source or
  target generation/window-validity change during its awaited release ack.
- `rg`-based review or compile failures confirm no remaining command/context
  references to the removed duplicate/bulk-close actions.

### T3 — Make detached-window close terminal and clean ownership/resources

**Status:** completed
**Dependencies:** T1 and T2
**Covers:** requirement 12; detached-close and stale-primary scenarios.

**Files and symbols**

- `src/main/window/WindowManager.ts`: `register`, `unregister`, detached tab
  and PTY ownership bookkeeping, pending tear-off records, and ownership
  generations
- `src/main/ipc/handlers.ts` and `src/main/ipc/ptyControl.ts`: add one explicit
  `closeDetachedWindowResources(ptyIds)` callback wired into `WindowManager`
  after the PTY services are constructed. It must perform, idempotently and in
  order, `unroutePty`, output-router release, agent-spawner disposal, and
  `PtyManager.kill` for each snapshot ID, matching the existing authorized
  `pty:kill` cleanup primitives.
- `src/main/ipc/transferHandlers.ts`: implement the exact tear-off pending
  token/record/ready commit and timeout rollback, preserve explicit user-requested
  return/bring-home paths, and add post-await ownership validation to
  `tab:absorb` before any unrecord/reroute/commit operation
- `src/shared/types.ts`: add the typed renderer event
  `tab:closed` carrying the closed tab id and detached window id; retain the
  existing `tab:absorb-committed` event for successful tear-off finalization,
  extended with the transfer token, plus typed `tab:tear-off-cancel`
  invocation/event payloads, `tab:tear-off-rolled-back`, and `transferId` in
  detached init data
- `src/renderer/src/store/panesIpc.ts` and `src/renderer/src/store/panes.ts`:
  consume `tab:closed` by removing internal stale proxies and the closed
  detached-window bookkeeping without recreating or returning tabs
- Main/renderer transfer tests and a new focused `WindowManager` lifecycle test
  if the current suite has no coverage

**Changes**

- In `WindowManager.unregister`, first mark the window as closing, cancel every
  pending tear-off whose source or target is that window, and reject any later
  `tab:detached-ready`, `tab:tear-off-cancel`, or commit message for those
  tokens. `unregister` remains synchronous: the closing marker/token
  invalidation, per-PTY guarded rollback, target rollback notification, and
  active-window removal happen synchronously before route/tab maps are cleared;
  the async PTY disposal callback is started only after that snapshot. This
  serialized state transition prevents a late ready event from rerouting a
  PTY after teardown without requiring the native `closed` event to await.
- On detached native-window close, snapshot all owned and still-pending tab
  IDs and all PTYs routed to that window’s `webContents.id` before clearing
  mappings. Pending-init/tear-off PTYs that are still routed to the source are
  cancelled and left alive; only PTYs whose current route is the closing
  window are passed to the configured `closeDetachedWindowResources` callback.
  Invoke the callback once for the de-duplicated cleanup set and make repeated
  close/exit notifications harmless.
- For every closed tab, retain a `tabSyncTombstones` barrier keyed to the closed
  ownership generation/window so a late `tab:state-sync` cannot reclaim it.
  `recordDetachedTabsForWindow` must reject messages from an unregistered
  detached window and must not clear a closed-window tombstone merely because
  the old renderer sent an empty or delayed snapshot.
- Notify the primary renderer with `tab:closed(tabId, windowId)` so it removes
  the internal detached proxy and detached-window ID bookkeeping. The event
  must not trigger `returnTab`, `tab:return`, or primary-tab recreation.
- Handle windows that close during detached initialization as well as windows
  with multiple fully adopted tabs. Avoid double-killing PTYs already released
  by a prior successful transfer or explicit tab close by snapshotting/removing
  ownership exactly once and making the cleanup callback idempotent.
- Keep explicit “return to main” behavior unchanged for a user action from the
  detached sidebar; only native detached-window shutdown changes semantics.
- Ensure the existing detached empty-window behavior remains valid when the
  last tab is individually closed, without treating that path as a window-close
  return.

**Invariants**

- No detached-window close sends `tab:return` for an owned tab.
- Closing a detached window cannot leave a primary navigation entry, orphaned
  PTY route, or live PTY for a tab it owned.
- A detached window that closes after a tab has been individually removed does
  not resurrect that tab; the empty-window close path publishes no return and
  late sync remains rejected by the window/generation barrier.
- Transfer commit/rollback ordering remains unchanged for moves that race with
  window shutdown; a destination must not be treated as committed merely
  because a source window closed.

**Verification**

- Main lifecycle tests assert all owned tabs are terminally closed, no return
  event is emitted, ownership/PTY maps are cleared, tombstones remain, and
  late sync from the closed window is rejected.
- Renderer IPC tests assert the primary removes stale closed-window records and
  never calls the normal return path.
- Main tests cover pending-init close, multi-tab adopted close, PTY cleanup
  idempotence, closing after the last detached tab was individually removed,
  pending tear-off cancellation before map clearing, per-PTY route snapshot
  validation, rollback that does not overwrite a newer pane transfer, and
  rejection of late ready/commit messages.
- A focused Electron/e2e scenario covers a detached window with multiple tabs,
  closes the native window, and verifies no tab is recreated in the primary.

**Explicit sidebar behavior assertions**

- For `[localA, detachedProxy, localB]`, moving `localB` before `localA` must
  leave the rendered order `[localB, localA]` and preserve the detached record;
  moving `localA` to the visible end must yield `[localB, localA]` without
  moving the detached record into the visible list.
- Selecting `localB` must set `activeTabId` to `localB` and apply its active
  style; selecting the detached proxy must have no rendered target.
- Rename commits the edited label; directory confirmation updates that tab’s
  `defaultCwd`; a pane-row click calls the atomic focus action for that tab;
  individual close removes only that owned tab and leaves the other visible
  rows/order intact.

### T4 — Update durable architecture guidance and complete verification

**Status:** completed
**Dependencies:** T1–T3
**Covers:** all requirements, non-goals, and definition of done.

**Files**

- `AGENTS.md` Layout & multi-window guardrail
- `docs/multi-window-and-layout.md`
- Any focused test documentation required by `docs/testing.md`
- Spec status/completion metadata only after implementation and verification

**Changes**

- Replace the obsolete documentation claim that the primary alone owns the
  sidebar and detached windows have only a tab bar. Document per-window sidebar
  ownership, hidden top tab navigation, explicit return versus terminal native
  close, and the preserved transfer acknowledgement invariant.
- Keep the AGENTS rule terse and put mechanism/why in the subsystem document.
- Do not add command-palette/search controls or unrelated pane/terminal changes.

**Verification sequence**

1. `npm run typecheck`
2. `npm run test`
3. `npm run build`
4. `npm run test:e2e` (or record the precise environment blocker if the native
   Electron smoke suite cannot run)
5. Inspect the final diff for scope discipline, remaining duplicate/bulk-close
   references, and documentation consistency.

The implementation is complete only when the spec scenarios have automated or
explicitly recorded behavioral evidence, all applicable commands pass, and the
spec can be moved to `specs/done/` with its adjacent plan preserved.

## Risks and mitigations

- **Ownership filtering can hide the wrong records.** Centralize the visible
  row predicate and test primary/local, detached/local, transfer-pending, and
  empty states separately.
- **Removing the top strip can accidentally remove window chrome.** Test the
  chrome shell independently from tab content and preserve draggable/control
  hit-test boundaries.
- **Detached close can race with transfer.** Reuse WindowManager ownership and
  the existing two-phase transfer state; make cleanup idempotent and test close
  during pending initialization and pending transfer.
- **PTY cleanup duplication can diverge.** Extract a narrow main-owned cleanup
  helper from the existing `pty:kill` path rather than inventing a renderer
  cleanup path.
- **Stale command references can break typecheck.** Remove the command context
  field, registry entry, palette wiring, tests, and documentation references as
  one change.

## Definition of done

- The ready spec requirements and scenarios are implemented without changing
  the non-goals.
- Primary and detached windows retain usable top chrome but have no top tab
  strip; each sidebar displays only its owning window’s tabs.
- Sidebar movement, individual close, rename, directory, pane navigation, and
  ordering work; duplicate and bulk-close actions are absent.
- Detached native-window close terminates all owned tabs and resources without
  returning or recreating them in the primary window.
- Transfer/PTY ownership invariants remain covered by tests.
- Typecheck, unit tests, build, and the available e2e verification are recorded.
- The implementation is review-ready and the updated docs no longer describe
  the old primary-only-sidebar model.

## Plan Review

Verdict: APPROVED

An independent blind reviewer inspected the spec, this plan, the repository
paths/symbols it names, the renderer ownership/filtering paths, the transfer
handlers, `WindowManager`, PTY cleanup boundaries, and the app-level drag/drop
root. The plan covers all requirements, scenarios, non-goals, resolved
decisions, source-retained tear-off with tokenized rollback, detached-window
terminal close, and focused verification. No blocking or important findings
remain.

Reviewer limitation: this was a read-only plan review; implementation tests
and native-window runtime behavior remain for execution and verification.

## Implementation Summary

- Replaced the rendered top tab surface with tab-free chrome while retaining
  window controls and existing non-tab controls; detached renderers now open
  with an always-visible, ownership-scoped sidebar.
- Scoped primary and detached sidebar rows to local ownership, preserved
  sidebar selection/reorder/rename/directory/pane actions, and moved new-window
  movement into the sidebar menu. Removed duplicate and bulk-close actions from
  the store, command registry, palette, and UI.
- Added tokenized source-retained tear-off readiness/rollback, per-PTY route
  validation, and terminal detached-window close cleanup with tombstones and
  `tab:closed` proxy cleanup. Renderer notifications during native teardown
  are best-effort so a destroyed webContents cannot crash main.
- Updated renderer, main-process, lifecycle, and Electron regression coverage;
  the old top-tab E2E interactions now exercise sidebar movement and ownership.
- Evidence before verification: `npm run typecheck` passed; `npm run test`
  passed with 87 files and 913 tests; `npm run build` passed; `npm run
  test:e2e` passed all 29 tests; focused detached tests passed; `git diff
  --check` passed.

## Verification Evidence

### Requirements

- R1–R2 PASS — `TabBar/index.test.tsx` verifies tab-free chrome; sidebar
  selection is covered by `TabSections.test.tsx`, and the Electron move/return
  scenarios exercise navigation in both primary and detached windows.
- R3 PASS — `initDetached` sets `sidebarOpen: true` and detached toggle calls
  are guarded; the Electron detached-window scenarios observe the sidebar.
- R4 PASS — both chrome tests and the Electron move scenario assert no
  `.tab-strip` in either window while existing chrome controls remain present.
- R5 PASS — `isTabVisibleInCurrentWindow` is the shared ownership predicate;
  the hidden-proxy/reorder test and Electron source/destination ownership
  assertions confirm no cross-window navigation row is rendered.
- R6 PASS — the sidebar activation test changes `activeTabId`; startup and
  suspension E2E flows also select Alpha/Beta through sidebar buttons.
- R7 PASS — sidebar action/reorder/pane-navigation coverage remains green in
  the full suite; rename, directory, Jira, pane, and individual-close paths
  remain in `TabSections` and the store.
- R8 PASS — `moves a tab and its PTY to a new window from the sidebar` passes;
  it invokes the sidebar menu, checks source removal/destination visibility,
  and receives PTY output in the destination.
- R9 PASS — `returns a detached tab to the primary sidebar` passes the full
  `Bring to Main Window` action and confirms detached removal plus primary
  restoration; the component test also verifies the IPC action.
- R10 PASS — the sidebar context-menu test and source search confirm no
  duplicate action or `tab.duplicate` command remains.
- R11 PASS — the sidebar context-menu test and source search confirm no
  close-other or close-to-right actions remain; individual close remains.
- R12 PASS — `WindowManager.test.ts` covers two owned tabs, terminal close,
  no `tab:return`, PTY cleanup, tombstones, late-sync rejection, and destroyed
  renderer notification safety; the Electron detached-close scenario confirms
  the owned PTY is killed and the detached window does not resurrect it.
- R13 PASS — the top region remains structurally available for window controls
  and existing non-tab controls without adding new top-level actions.

### Acceptance scenarios and non-goals

- Primary navigation, detached navigation, active styling, and visible reorder:
  PASS via `TabSections.test.tsx`, `panes.test.ts`, `TabBar/index.test.tsx`,
  and the final Electron suite.
- Successful sidebar move, failed/rolled-back move, explicit return, and
  context-menu action availability: PASS via `WindowManager.test.ts`, store/
  component tests, and the move/return Electron scenarios.
- Detached native close, no stale primary entry, and empty-window behavior:
  PASS via the two-tab lifecycle test, `tab:closed` renderer handling, and the
  detached-close Electron scenario.
- No new command-palette/search/top-tab replacement, no pane-layout redesign,
  no terminal/session behavior change, and no cross-device synchronization:
  PASS by scoped diff review, unchanged pane/terminal contracts, and the full
  test/build/Electron matrix.
- `Open Questions`: PASS — none remain.

### Mechanical checks

- `npm run typecheck` — PASS.
- `npm run test` — PASS, 87 files and 913 tests.
- `npm run build` — PASS as part of the final E2E command.
- `npm run test:e2e` — PASS, all 29 Electron tests.
- `git diff --check` — PASS.

### Verification limitation and repairs

- A blind delegated verifier was started with only the spec and plan, but did
  not return before its process was shut down; independence is therefore
  explicitly UNAVAILABLE rather than represented as an independent verdict.
- During verification, the destroyed-webContents teardown race was repaired
  with guarded main-process sends and a regression test. The obsolete top-tab
  E2E selectors were redirected to sidebar actions, and explicit return plus
  multi-tab close coverage was added. Affected tests and the full unit suite
  were rerun after each repair.
