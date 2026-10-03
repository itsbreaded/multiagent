# Implementation Plan: Sidebar Tab Detaching and Cross-Window Tab Transfer

Plan Status: completed <!-- review | changes-requested | approved | in-progress | completed -->
Source spec: `specs/done/074-sidebar-tab-detach-and-cross-window-transfer.md` (Status: done)

## Verified Repository Facts

- `TabSections` is the current sidebar tab/folder surface. Its section headers
  already use `SidebarSection`'s native drag callbacks for local reorder via
  `application/x-multiagent-tab-reorder`; pane rows use the separate
  `application/x-multiagent-pane` payload from `src/renderer/src/utils/paneDrag.ts`.
- `SidebarSection` renders the entire header as the draggable element while
  nested buttons remain the existing title/action controls. It already exposes
  insertion-line and drop-outline styling that can carry tab-transfer feedback.
- `usePanesStore` owns visible-tab filtering, local reorder, detached
  initialization, tab removal/return, xterm preservation, hydration, and
  source-side tear-off pending tokens. `moveTabToNewWindow` currently starts a
  tokenized tear-off at a fixed window-relative location; commit and rollback
  listeners are in `panesIpc.ts`.
- `initDetached` mounts the incoming tab, hydrates its existing pane runtime,
  invokes `tab:adopt`, and emits `tab:detached-ready` only when hydration and
  adoption succeed. Main keeps the source copy and PTY routes until that
  readiness commit; the existing timeout/rollback path is in
  `WindowManager`/`transferHandlers`.
- `tab:absorb` exists in `transferHandlers.ts`, but no current renderer invokes
  it after the top-tab surface was removed. Its old caller optimistically used a
  removed `receiveTab` action, so the target-application/ack stage is currently
  missing for sidebar cross-window tab movement.
- `WindowManager` tracks detached tab ownership, ownership generations,
  tombstones, PTY routes, pending tear-offs, and detached-window close cleanup.
  `unregister` intentionally closes owned detached tabs rather than returning
  them and rejects stale synchronization.
- Detached renderers publish versioned tab state to main; the primary merges
  detached ownership records through `syncDetachedTabs`. A primary tab that is
  already present as a detached proxy must be converted in place on a successful
  return/transfer, not appended as a duplicate.
- The shared IPC channel map in `src/shared/types.ts` is the source of truth for
  invoke/event/send signatures. Existing pane transfer handlers already use a
  destination-applied acknowledgement and rollback notification pattern that
  is appropriate for the tab target-application stage.
- Existing coverage includes sidebar reorder/action tests, pane drag utility
  tests, store reorder/ownership tests, `WindowManager` lifecycle tests, and
  Electron startup/tear-off/return/PTY-output scenarios in
  `e2e/startup.spec.ts`. There is no dedicated transfer-handler test file yet.

## Scope and Coverage

| Requirement/scenario | Planned task(s) | Verification |
| --- | --- | --- |
| R1, R9; same-window reorder | T1, T3 | sidebar component/store tests and E2E reorder |
| R2-R5; drag-out detachment and rollback | T2, T3, T5 | store/main lifecycle tests, E2E primary-to-detached and failure path |
| R6-R8; detached-to-primary and detached-to-detached transfer | T2, T3, T4, T5 | target-ack/ownership tests and Electron multi-window tests |
| R7; pane tree, active state, PTY routing/output, sessions | T2, T4, T5 | transfer state tests, PTY route/output E2E, session assertions |
| R10; tab/pane payload separation and unchanged pane behavior | T1, T3, T5 | MIME utility/component tests, pane regression tests, E2E pane drag |
| R11-R12; sidebar-only UI and preserved actions | T1, T5 | existing sidebar/chrome/action tests, stale-symbol audit |
| R13-R14; feedback, invalid/self-drop, races and stale sync | T1-T4 | component feedback tests, WindowManager/handler tests, E2E close/rollback |

## Architecture and Data Flow

Tab drags will carry a dedicated tab MIME payload containing the serialized tab
snapshot, its current PTY IDs, and the source window ID. The existing reorder
MIME remains on the same-window path so local reorder semantics do not depend
on a cross-window IPC round trip. The pane MIME remains unchanged.

The source begins a tear-off only from `dragend` when the pointer is outside all
known windows and no destination accepted the drop. It passes the actual screen
coordinates into the existing tokenized `tab:tear-off` invoke. The source tab
and PTY routes remain unchanged until the existing detached-ready commit.

For an existing-window drop, the destination invokes the existing `tab:absorb`
handler with a requested visible insertion index. Main first asks the
destination renderer to apply the tab and waits for a destination-applied ack.
Only after that ack does it ask the source renderer to acknowledge a pending
release. Main then revalidates source/target liveness, ownership generation,
and every PTY route before recording the new owner and rerouting PTYs. A
successful commit tells the source to finalize removal/detachment. Any failed
ack, close, timeout, stale generation, or route mismatch tells the destination
to remove its applied copy and leaves the source authoritative.

The destination store action is idempotent for a detached proxy already present
in the primary, but rejects an already-local duplicate. It inserts by visible
sidebar order, activates the received tab, preserves the serialized pane tree
and focused pane, and hydrates only the existing runtime. The source finalizer
is keyed by the main-issued transfer token so late commits cannot remove an
unrelated or newer tab state.

## Implementation Tasks

### T1 - Add a typed sidebar tab-drag payload and visual drop-state contract (complete)

- Dependencies: none.
- Requirements/scenarios: R1, R9, R10, R13; same-window reorder, invalid/self-drop,
  and pane-drag isolation scenarios.
- Files and symbols:
  - Add `src/renderer/src/utils/tabDrag.ts` and focused tests beside it.
  - Update `src/renderer/src/components/Sidebar/SidebarSection.tsx` only as
    needed to expose stable data attributes/classes for tab drag feedback while
    preserving nested action behavior.
  - Update `src/renderer/src/components/Sidebar/TabSections.tsx` drag handlers,
    insertion state, and target validation.
  - Use existing colors/tokens from `src/renderer/src/styles/theme.ts`.
- Current behavior: section headers publish only the reorder MIME; a pane MIME
  is handled separately; no target accepts an inter-window tab payload and no
  drag-out location is captured.
- Implementation change:
  - Define validated encode/decode/set helpers for a tab payload with tab,
    `ptyIds`, and numeric `sourceWindowId`; use a dedicated tab MIME and do not
    alter `paneDrag.ts` payload semantics.
  - Publish both the existing reorder marker and the tab payload from a tab
    header. Same-window handlers must identify the same-window source before
    invoking `reorderTab`; cross-window handlers must never consume the reorder
    marker.
  - Track visible insertion position, target window ownership, self-drop, and
    invalid-region state. Show insertion lines/drop outlines only for a valid
    target; reject a tab payload over its own tab and all pane payloads in tab
    paths.
  - Keep tab-drop handling ahead of pane handling only when the tab MIME is
    valid; otherwise preserve all existing pane-drop paths.
  - Capture current window bounds at drag start and install cleanup that survives
    source-row unmount. The drag-end behavior will delegate actual transfer to
    the store action in T2.
- Invariants and edge cases:
  - A tab dropped on another local tab uses the current visible reorder sequence,
    including the existing before/after insertion semantics.
  - Self-drops, malformed payloads, pane payloads, and drops inside an invalid
    region do nothing and never call a transfer action.
  - No top-tab UI or obsolete settings are reintroduced.
- Verification:
  - Utility tests cover valid/malformed/self/source-window payloads and prove
    the tab and pane MIME types are distinct.
  - Component tests assert insertion/drop feedback, same-window reorder, valid
    cross-window target acceptance, invalid/self-drop rejection, and unchanged
    pane drop calls.
- Completion evidence: focused utility/component tests pass and the implementation
  exposes no production path that interprets a pane payload as a tab.

### T2 - Reuse the tear-off handshake for sidebar drag-out at the drop location (complete)

- Dependencies: T1.
- Requirements/scenarios: R2-R5, R7, R13-R14; primary-to-detached, timeout,
  adoption failure, target-close, and source-close scenarios.
- Files and symbols:
  - `src/renderer/src/store/panes.ts`: `PanesStore`, `moveTabToNewWindow`,
    `commitTabTearOff`, `rollbackTabTearOff`, `closeTab` interaction.
  - `src/renderer/src/components/Sidebar/TabSections.tsx`: drag-end source
    location and outside-window decision.
  - `src/main/ipc/transferHandlers.ts`, `src/main/window/WindowManager.ts`,
    `src/shared/types.ts`: preserve and extend the existing tear-off token path
    only where needed for screen coordinates and stale-token validation.
  - Existing `src/main/window/WindowManager.test.ts` and new focused transfer
    lifecycle tests.
- Current behavior: context-menu movement calls `moveTabToNewWindow` with a
  fixed location; sidebar drag has no outside-window handling. The existing
  detached-ready handshake already retains the source until target adoption and
  rolls back on timeout/close.
- Implementation change:
  - Allow the store action to accept screen coordinates and use them in the
    existing `tab:tear-off` invoke; do not add a second detachment protocol.
  - On drag end, create a detached window only if the drop was outside every
    known window. If a destination window accepted the drop, or the pointer
    returned to an invalid area, leave the source unchanged.
  - Keep source tab rendering, xterm registry entries, session metadata, and
    PTY routes intact until `tab:absorb-committed` for the matching transfer
    token. Ensure source cancellation/close clears only its own pending token.
  - Preserve the current `tab:adopt` preflight, fitted-size initialization,
    target-ready commit, timeout, route restoration, and rollback event. Add
    validation where necessary so a stale ready/rollback cannot consume a newer
    transfer for the same tab.
- Invariants and edge cases:
  - Source close, target close, adoption failure, readiness timeout, and a
    source/target race converge on one rollback path; no PTY route is restored
    over a newer owner.
  - A target row cannot survive a failed tear-off, and the source cannot be
    removed before the destination commits.
- Verification:
  - WindowManager tests cover transfer token phases, original-route recovery,
    target/source close, stale-generation rejection, and one replacement attempt.
  - Store tests cover coordinates, source retention until commit, rollback with
    exactly one source row, and pending-token cancellation.

### T3 - Implement destination-applied tab absorb with atomic source commit (complete)

- Dependencies: T1.
- Requirements/scenarios: R6-R10, R13-R14; detached-to-primary,
  detached-to-detached, target application/ack, stale sync, and transfer-race
  scenarios.
- Files and symbols:
  - `src/shared/types.ts`: typed `tab:received`, `tab:received-applied`,
    `tab:transfer-rolledback`, and any transfer-token/drop-index signature
    additions; update channel comments to describe the live sidebar caller.
  - `src/main/ipc/transferHandlers.ts`: `tab:absorb` and ack/rollback flow.
  - `src/main/window/WindowManager.ts`: generation/owner helpers or a small
    pending-absorb record if needed to make the awaited commit idempotent.
  - `src/renderer/src/store/panes.ts`: restore a narrow `receiveTab` action (or
    equivalent) returning a boolean, visible-index insertion, duplicate/proxy
    handling, and source-finalization state.
  - `src/renderer/src/store/panesIpc.ts`: destination application ack, source
    release marker/ack, commit finalization, and rollback cleanup.
  - New focused main transfer tests plus store/IPC tests.
- Current behavior: `tab:absorb` waits only for a source release ack, then
  reroutes PTYs and tells the source to commit; its old optimistic target action
  was removed, so there is no actual destination apply/ack step.
- Implementation change:
  - Main-issued transfer IDs must identify one absorb attempt. First send the
    serialized tab and visible insertion index to the destination and wait for
    `tab:received-applied` from that destination window. The destination action
    must return false/no-ack for a missing target or an already-local duplicate.
  - After target apply, ask the source to acknowledge `tab:release` with the
    same transfer ID. The source records the pending release but does not mutate
    its tab until the final commit event.
  - Revalidate source/target windows, source ownership generation, source PTY
    routes, and transfer identity after each await. Only then unrecord old
    detached ownership, record detached target ownership when applicable,
    reroute every PTY, flush direct output, and send source commit.
  - On any failure send rollback to the destination and clear the source's
    pending release marker. Do not send a successful source-removal event after
    a no-op target apply or a stale generation.
  - On commit, primary sources become detached proxies only when the destination
    is detached; detached sources remove their local row. A primary destination
    converts an existing detached proxy in place. Preserve the incoming active
    tab/focused-pane data and let detached sync/tombstone guards reject stale
    copies.
- Invariants and edge cases:
  - Source removal happens after both target apply and main ownership/PTY commit,
    never after receipt alone.
  - Detached-to-detached transfers update ownership maps without causing either
    detached close path to return or duplicate the tab.
  - A stale source release ack, target ack, state sync, or commit cannot affect a
    later transfer token; an absent/ambiguous tab remains protected.
- Verification:
  - Main handler tests drive target ack success/failure, source ack timeout,
    source/target close, generation changes, PTY-route mismatch, successful
    routing, and rollback notifications.
  - Store/IPC tests assert no duplicate/stale rows, correct visible insertion,
    active/focused state, and source finalization only on the matching token.

### T4 - Preserve PTY/session/output and pane drag behavior across ownership changes (complete)

- Dependencies: T2-T3.
- Requirements/scenarios: R7, R10-R11; terminal output, session state,
  detached cleanup, pane drag/drop unaffected.
- Files and symbols:
  - `src/renderer/src/store/panes.ts`, `panesIpc.ts`, and existing hydration/
    xterm registry paths.
  - `src/main/ipc/ptyOutputRouter.ts` integration seams and transfer tests.
  - `src/renderer/src/App.tsx` root pane-drop handlers and
    `src/renderer/src/components/Sidebar/TabSections.tsx` pane row handlers.
  - `src/renderer/src/utils/paneDrag.test.ts`, pane/store tests, and
    `e2e/startup.spec.ts`.
- Current behavior: PTY ownership is transferred by main after pane/tab
  application; pane drag paths distinguish local moves from cross-window IPC.
  Existing E2E coverage proves tear-off/return output and detached close
  cleanup, but not sidebar cross-window tab transfer.
- Implementation change:
  - Keep terminal instances and serialized pane trees intact during transfer;
    do not kill/recreate PTYs or rewrite sessions. Flush buffered/direct output
    after each successful route change using existing router hooks.
  - Ensure transferred agent/session metadata remains bound to the same pane IDs
    and that destination hydration does not start a second session for a live
    PTY.
  - Keep root and pane-level drops gated on `PANE_DRAG_MIME`; tab payloads must
    be ignored there. Retain self-drop protections and existing pane ack/rollback
    behavior.
- Invariants and edge cases:
  - A terminal output marker sent before and after transfer is observed exactly
    once by the destination; source output is not routed after commit.
  - Closing a detached window still closes all tabs it owns; no new return path
    is introduced by drag transfer.
- Verification:
  - Unit tests assert PTY route owner changes only after target apply and that
    pane MIME drops still call the existing local/cross-window pane actions.
  - E2E tests exercise output/session identity before and after primary-to-
    detached, detached-to-primary, and detached-to-detached movement, plus
    pane drag/drop and detached-window close cleanup.

### T5 - Update focused tests, E2E coverage, comments, and architecture documentation (complete)

- Dependencies: T1-T4.
- Requirements/scenarios: all requirements and non-goals.
- Files and symbols:
  - `src/renderer/src/components/Sidebar/TabSections.test.tsx`,
    `SidebarSection.test.tsx`, `src/renderer/src/store/panes.test.ts`,
    `src/renderer/src/store/panesIpc.test.ts` if a listener seam is added,
    new tab-drag/transfer tests, `src/main/window/WindowManager.test.ts`, and
    new `src/main/ipc/transferHandlers.test.ts` or extracted handler seam.
  - `e2e/startup.spec.ts` helpers and tests for reorder, drag-out, both existing
    window transfer directions, rollback, PTY output, stale/duplicate rows,
    pane drag, and detached close.
  - `src/shared/types.ts`, current source comments, `docs/multi-window-and-layout.md`,
    and `docs/testing.md`.
- Current behavior: tests cover sidebar reorder and menu movement plus legacy
  tear-off/return, but no sidebar tab payload, target-apply ack, or
  cross-window tab drag scenarios. Comments describe `tab:absorb` as retained
  infrastructure rather than a live sidebar caller.
- Implementation change:
  - Add focused tests for each acceptance scenario, including negative/timeout/
    close/race cases and no stale/duplicate rows. Use deterministic IPC mocks
    and fixture panes; do not launch real provider CLIs in unit tests.
  - Extend Electron fixtures/helpers to use the visible sidebar and inspect
    window ownership, pane IDs, PTY output frames, and saved/session state.
    Keep top-tab absence assertions and current individual actions.
  - Update comments/architecture docs to describe the sidebar tab-drag payload,
    destination-applied ack, source-retained commit ordering, and intentionally
    retained transfer channels. Do not document top-tab navigation or invent
    a second transfer path.
  - Record any intentionally retained transfer references in this plan under
    `## Intentional Retained Transfer References` after the final audit.
- Invariants and edge cases:
  - Tests must distinguish code inspection from behavioral evidence and mark
    unavailable native-window/manual observations as `UNVERIFIED` rather than
    claiming them as passes.
  - Archived historical specs may retain old top-tab wording; current docs and
    source comments must describe the current sidebar-only behavior.
- Verification:
  - Run the focused tests during implementation, then the required full matrix:
    `npm run typecheck`, `npm run test`, `npm run build`, `npm run test:e2e`, and
    `git diff --check`.
  - Audit with `rg` for stale/duplicate transfer paths, obsolete top-tab UI,
    and intentional retained channel references.
- Completion evidence: all applicable focused/full checks pass, the plan has a
  truthful implementation summary and retained-reference audit, and the spec
  advances to `done` after the documented verification gate.

## Cross-Cutting Constraints

- Use one tab transfer protocol: existing tear-off/adopt/readiness for new
  windows and existing absorb/release/return/ownership/PTY safeguards for
  existing windows, extended only with destination apply acknowledgment.
- Source renderers retain their last good tab copy until main has confirmed
  destination application and committed ownership. No optimistic source delete.
- Do not mutate or persist a second tab identity, pane tree, session, or PTY
  representation. Preserve tombstones, generations, versioned detached sync,
  and guarded route restoration.
- Keep tab and pane MIME payloads disjoint. Pane drag/drop remains unchanged and
  must not be accepted by tab containers or tab-transfer IPC.
- Keep sidebar-only navigation and all 072/073 restrictions: no top tabs,
  duplicate actions, bulk-close actions, or obsolete overflow/wrap settings.
- Use theme tokens for visual affordances and maintain existing sidebar action
  behavior, terminal rendering, resize, session, and detached-close guardrails.

## Risks, Migration, and Rollback

- Cross-window transfer races can otherwise duplicate or lose a tab. Mitigate
  with target-applied and source-release acks, generation/route revalidation,
  transfer-token idempotence, and destination rollback.
- A stale detached sync can reclaim a moved tab. Preserve ownership tombstones,
  version checks, and primary-local conversion guards; test each transfer order.
- A drag-end outside-window detector can misclassify a target drop. Require
  explicit target acceptance/bounds checks and keep the source unchanged for
  invalid/ambiguous drops.
- Renderer unmount during a committed drag can leak visual state. Use global
  drag cleanup and token-keyed finalizers; no persisted migration is required.
- Rollback is source-preserving: revert only PTY routes still owned by the
  failed transfer target and remove only the target copy applied for that token.
  No package version, release, or external publish operation is in scope.

## Intentional Retained Transfer References

The implementation is expected to retain and actively use `tab:tear-off`,
`tab:adopt`, `tab:tear-off-cancel`, `tab:detached-ready`,
`tab:tear-off-rolled-back`, `tab:absorb`, `tab:release`,
`tab:absorb-committed`, `tab:received`, `tab:received-applied`,
`tab:transfer-rolledback`, `tab:return`, `tab:release-applied`, `tab:closed`,
`tab:state-sync`, `pendingTabAbsorbs`, `detachedWindowTabIds`,
`detachedWindowActiveTabIds`, `receiveTab`, `returnTab`, `detachTab`,
`removeTabLocally`, PTY ownership/routing, transfer generations, tombstones,
and detached-window cleanup. The target-application acknowledgements are part
of the same protocol and must not become a second movement implementation.

## Handoff Checklist

- [x] Plan is independently reviewed and marked approved (same-session fallback; blind
      plan reviewer was unavailable).
- [x] Existing dirty work is preserved; no package version is changed.
- [x] Every task records focused evidence and task status.
- [x] Source-retained and destination-acknowledged ownership ordering is proven.
- [x] Intentional retained transfer references are audited after implementation.
- [x] Full typecheck, unit, build, Electron E2E, and diff checks are recorded.

## Plan Review

Verdict: APPROVED

Coverage: all 14 requirements, all listed acceptance scenarios, the explicit
sidebar-only/pane-drag/non-goal decisions, detached-window close semantics,
and the existing transfer/PTY/session dependencies map to T1-T5. Repository
inspection confirmed the named sidebar, store, IPC, WindowManager, pane-drag,
E2E, and documentation seams. The plan explicitly addresses the current gap:
`tab:absorb` has no live sidebar target-application ack after the top-tab
surface was removed.

Falsification pass: the plan requires source retention through destination
apply and main ownership commit, validates generation and every PTY route after
each awaited ack, rolls back only the target copy/routes still attributable to
the failed transfer, and preserves the existing tokenized tear-off readiness
path. Same-window reorder is separated from cross-window absorb, and tab/pane
MIME payloads remain distinct. Detached-to-primary, detached-to-detached,
stale-sync, target-close, source-close, timeout, adoption failure, output, and
detached-close scenarios have explicit coverage.

Reviewer limitation: the blind delegated plan reviewer did not return after
three bounded waits and was shut down. The independent implementation
verification attempt had the same outcome. This is therefore a documented
same-session fallback review, not independent reviewer evidence. The fallback
audit found no blocking or important finding; the automated behavioral matrix
and concrete source/test inspection below are the archival evidence.

## Implementation Summary

Implemented the sidebar-only tab drag workflow. Section headers now publish a typed
tab payload alongside the existing reorder marker; same-window drops retain visible-tab
reorder semantics, cross-window drops invoke `tab:absorb`, and drag-end outside known
window bounds reuses the tokenized tear-off/adopt/detached-ready protocol at the native
drop coordinates. Pane rows continue to use the independent pane MIME path.

`tab:absorb` now waits for destination application (`tab:received-applied`) and source
release staging (`tab:release-applied`) before validating liveness, ownership generation,
and every PTY route. Main then commits ownership/routing and notifies both renderers;
token-keyed rollback restores detached proxies and source staging. Pending detached sync
is filtered during an absorb so it cannot claim the incoming tab before the main commit.
The existing detached-window close rule, session/pane trees, xterm runtime, and PTY output
paths remain in place.

## Verification Evidence

- Focused renderer/store/utilities: `npx vitest run
  src/renderer/src/components/Sidebar/TabSections.test.tsx
  src/renderer/src/store/panes.test.ts src/renderer/src/utils/tabDrag.test.ts` —
  PASS, 3 files / 77 tests.
- Full unit suite: `npm run test` — PASS, 88 files / 925 tests.
- `npm run typecheck` — PASS.
- `npm run build` — PASS.
- `npm run test:e2e` — PASS, 33 tests. This includes sidebar reorder, primary-to-detached
  drag-out with PTY output, detached-to-primary, detached-to-detached, destination no-op
  rollback/no-duplicate protection, detached close cleanup, top-tab absence, and pane
  drag/drop isolation.
- `git diff --check` — PASS (only Git's expected LF/CRLF conversion warnings).
- No package version, release, publish, or external side effect was performed.
