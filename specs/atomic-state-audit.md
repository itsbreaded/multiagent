# Atomic State and Focus Consistency Audit

Date: 2026-06-12

## Implementation Status

Last updated: 2026-06-12

This section tracks the current code state after the first implementation pass. The original audit findings below are intentionally preserved as historical context.

### Fixed In Current Code

1. Inactive sidebar pane clicks now use the atomic `focusPaneInTab(tabId, paneId)` transition instead of composing `setActiveTab` and `focusPane`.
2. Shell pane PTY creation now has one owner: `Terminal` creates shell PTYs on mount; `addShellPane` only publishes the shell pane.
3. Agent pane runtime metadata returned together from `session:new` is committed with a single `updatePane` patch.
4. `session:detected` now commits the last-agent preference and pane `sessionId` update in one store update.
5. Cross-window pane transfer is ack-based: the target renderer commits `pane:received` and sends `pane:received-applied` before main moves PTY routing.
6. `tab:absorb` now validates source and destination windows before releasing the source tab or moving PTYs.
7. Detached tab ownership has sync versions, ownership generations, and stale-sync tombstones to prevent old detached sync from reclaiming returned/moved tabs.
8. Detached tab ownership is kept pending during `tab:tear-off` and is promoted to routable/focusable ownership only after the detached renderer initializes and acks PTY adoption with `tab:detached-ready`.
9. `window:focus-pane` re-checks tab ownership and ownership generation before focusing a remote window.
10. Detached tab sync now uses a structured `TabStateSyncPayload` with `{ windowId, tabs, activeTabId, version }`. Main still accepts the legacy positional shape for compatibility.
11. `zoomedPaneId` is cleared when switching/focusing a tab that does not contain the zoomed pane.
12. Optimistic remote focus is represented separately as `pendingFocusTarget`; confirmed OS focus remains `activeWindowId`.
13. Confirmed focus now flows through a main-stamped `FocusTarget` broadcast with `{ windowId, tabId, paneId, version }`; the sidebar uses this target, while `pendingFocusTarget` remains only for in-flight remote focus feedback.
14. `Terminal` updates xterm cursor/theme options when `paneType` changes.
15. Sidebar pane context close now uses `closePaneInTab(tabId, paneId)`.
16. Pane drags now carry a cross-window pane payload with source window/tab identity; detached sidebar rows remain draggable, pane headers provide the payload, tab bars/content accept cross-window pane drops, and main removes/moves the pane in the owning renderer after target commit.

### Remaining Follow-Up

- Consider a full acked `tab:release-applied` / `tab:receive-applied` transaction for tab absorb. The current implementation validates source before routing and receives optimistically in the destination, but it is not a complete tab-transfer transaction.
- Manually verify multi-window behavior in the running app:
  - No sidebar focus flicker when focusing detached panes.
  - Clicking inactive-tab sidebar panes highlights only the intended pane.
  - Closing panes from inactive sidebar tabs works correctly.
  - Creating shell panes creates exactly one PTY.
  - Moving panes/tabs across windows does not leave duplicates or stale ownership.
  - Dragging panes main window <-> detached window works in both directions.

### Verification Completed

- `npm run typecheck` passed after each meaningful implementation group.
- `npm run build` passed after the implementation pass.

## Purpose

This audit looks for code paths where user-visible state is published in multiple steps even though the UI treats the result as one transition. The recent detached-sidebar focus flicker was caused by this pattern: `setActiveTab(tabId)` published the destination tab with its old `focusedPaneId`, then `focusPane(paneId)` published the intended pane. Subscribers and IPC saw both states.

The goal is to identify similar risks before they become hard-to-reproduce visual, routing, or persistence bugs.

## Investigation Split

The audit was split across three independent read-only passes and then verified locally:

1. Renderer store atomicity
   - Scope: `src/renderer/src/store/panes.ts` and direct consumers.
   - Question: Which store actions expose incomplete state or require callers to compose multiple actions that should be one transition?

2. Main-process IPC and multi-window ordering
   - Scope: `src/main/ipc/handlers.ts`, `src/main/window/WindowManager.ts`, `src/shared/types.ts`, `src/preload/index.ts`.
   - Question: Which IPC flows route ownership, focus, or PTYs before both renderer and main state agree?

3. Renderer component selectors and highlights
   - Scope: `src/renderer/src/components/PaneGrid`, `Sidebar`, `TabBar`, `Terminal`, `PaneHeader`, and `App`.
   - Question: Which components render from state combinations that can be temporarily inconsistent?

## Guiding Principle

Any operation that changes the user's current target should have a single committed state transition.

Examples:

- Active tab plus focused pane should be updated together.
- Window ownership plus active detached tab should be updated together.
- Moving a pane or tab across windows should have a transaction or explicit pending state.
- Side effects such as PTY routing should not move ahead of the renderer state that can display the PTY.
- Broadcasts and persistence should observe final states, not intermediate construction states.

## Confirmed Findings

### 1. Inactive sidebar pane click still composes tab focus and pane focus

Files:
- `src/renderer/src/components/Sidebar/TabSections.tsx`
- `src/renderer/src/store/panes.ts`

Current shape:
- Sidebar rows render panes from every tab.
- Local pane rows use `setActiveTab(tab.id)` followed by `focusPane(pane.id)`.
- `setActiveTab` has detached-window side effects and can broadcast the tab's previous `focusedPaneId`.

Risk:
- The same old-pane-then-new-pane flicker can happen when clicking a pane in an inactive local tab.
- In detached windows, it can also broadcast the wrong pane before the intended pane.

Improvement:
- Route all "activate tab and focus pane" interactions through `focusPaneInTab(tabId, paneId)`.
- Avoid exposing `setActiveTab` plus `focusPane` composition in components.

Priority: High.

### 2. Shell pane creation has two PTY owners

Files:
- `src/renderer/src/store/panes.ts`
- `src/renderer/src/components/Terminal/index.tsx`

Current shape:
- `addShellPane` inserts a shell leaf without `ptyId`, then calls `pty:create` and later `setPtyId`.
- `Terminal` also creates a PTY when a mounted shell pane has no `ptyId`.

Risk:
- A shell pane can race two `pty:create` calls.
- One PTY can become orphaned, or the losing `ptyId` can still have output/routing side effects.

Improvement:
- Choose exactly one owner for shell PTY creation.
- Preferred: let `Terminal` own shell PTY creation, and remove `pty:create` from `addShellPane`.
- Alternative: create the PTY before publishing the shell pane and insert the leaf with `ptyId` already set.

Priority: High.

### 3. Agent pane metadata is committed in stages

Files:
- `src/renderer/src/store/panes.ts`
- `src/renderer/src/App.tsx`

Current shape:
- `newSession`, `splitPane`, and resume flows insert an agent pane first.
- Later IPC responses call `setPtyId` and `setSessionId` separately.
- `App` saves and syncs whenever `tabs` changes.

Risk:
- The app can briefly observe or persist an agent pane with `ptyId` but no `sessionId`, or otherwise partial identity.
- Sidebar/session UI can derive stale or incomplete session status.

Improvement:
- Add a single pane metadata patch action, for example `updatePane(paneId, { ptyId, sessionId })`.
- When an IPC response contains both fields, commit both fields in one `set`.
- For truly pending panes, model pending state explicitly instead of relying on missing fields.

Priority: Medium.

### 4. `session:detected` updates preference and pane identity separately

Files:
- `src/renderer/src/store/panes.ts`

Current shape:
- The listener calls `setLastAgentKind(agentKind)` and then `setSessionId(pane.id, sessionId)`.

Risk:
- Low severity, but UI can observe a new default agent kind before the detected session is attached to the pane.

Improvement:
- If detection semantically updates both preference and pane identity, commit both in one store update.

Priority: Low.

### 5. Cross-window pane transfer duplicates ownership during handoff

Files:
- `src/renderer/src/components/Sidebar/TabSections.tsx`
- `src/main/ipc/handlers.ts`
- `src/renderer/src/store/panes.ts`

Current shape:
- Source renderer invokes `pane:transfer`.
- Main routes the PTY to the target window before sending `pane:received`.
- Target renderer adds the pane.
- Source renderer removes the pane only after the IPC promise resolves.

Risk:
- For a short period, source and target stores can both contain the same pane.
- PTY output can be routed to the target before the target has rendered the pane.
- Save/sync effects can observe duplicate or pre-removal state.

Improvement:
- Treat pane transfer as a transaction.
- Add a transfer id and an explicit pending/transferring state.
- Target should ack that the pane is committed before PTY routing moves, or main should pause/flush PTY delivery during the handoff.
- Source should suppress persistence/sync for transferring panes or remove/mark the pane immediately.

Priority: High.

### 6. `tab:absorb` routes PTYs before source release is validated

Files:
- `src/main/ipc/handlers.ts`

Current shape:
- `tab:absorb` transfers PTYs to the destination window before confirming the source window exists and before sending `tab:release`.

Risk:
- If `sourceWindowId` is stale or destroyed, PTY ownership can move while the source renderer still shows the tab.
- The receiver may not have fully committed the tab when output begins routing there.

Improvement:
- Validate source and destination before moving PTYs.
- Use an acked release/receive flow, or a main-owned transfer transaction that cannot partially complete.

Priority: High.

### 7. `tab:bring-home` can be overwritten by stale detached sync

Files:
- `src/main/ipc/handlers.ts`
- `src/main/window/WindowManager.ts`
- `src/renderer/src/store/panes.ts`

Current shape:
- Main unrecords a tab, sends `tab:release`, and immediately sends `tab:return`.
- A stale `tab:state-sync` from the detached window can arrive afterward and re-record the old window as owner.

Risk:
- Focus or pane transfer commands can route to the stale detached window.
- Primary and detached stores can temporarily disagree about ownership.

Improvement:
- Add per-tab ownership generations or transfer tombstones.
- Reject `tab:state-sync` messages older than the latest ownership transition.
- Consider `tab:release-applied` before `tab:return`.

Priority: High.

### 8. Detached window ownership is published before detached init/adoption is confirmed

Files:
- `src/main/ipc/handlers.ts`
- `src/main/window/WindowManager.ts`
- `src/renderer/src/App.tsx`

Current shape:
- `tab:tear-off` creates and loads a detached window.
- Main records detached tab ownership before the detached renderer has fetched init data and adopted PTYs.

Risk:
- A focus or transfer request can target a detached window that is registered but not yet ready to display the tab.

Improvement:
- Pass init data into `createDetachedWindow` before loading the renderer, or mark ownership as pending.
- Expose the tab as routable/focusable only after the detached renderer acks init and PTY adoption.

Priority: Medium.

### 9. `window:focus-pane` should re-check ownership before focusing

Files:
- `src/main/ipc/handlers.ts`
- `src/main/window/WindowManager.ts`

Current shape:
- Main resolves the owner window once, sends `pane:focus-remote`, and later focuses the same `BrowserWindow` after ack or fallback.

Risk:
- If the tab moves during the focus request, main can focus the old window.

Improvement:
- Re-check `windowManager.getWindowIdForTab(tabId)` inside the ack/fallback path.
- Include expected owner window id and ownership generation in focus request state.

Priority: Medium.

### 10. `tab:state-sync` runtime contract differs from shared type contract

Files:
- `src/shared/types.ts`
- `src/main/ipc/handlers.ts`
- `src/renderer/src/App.tsx`

Current shape:
- Runtime sends and handles `tab:state-sync(windowId, tabsJson, activeTabId)`.
- The shared channel signature documents only `windowId` and `tabsJson`.

Risk:
- Type drift hides active-tab sync ordering bugs.
- Positional JSON-string payloads are easy to extend incorrectly.

Improvement:
- Replace positional arguments with a structured payload:
  - `{ windowId, tabs, activeTabId, version }`
- Include a monotonically increasing version so receivers can reject stale sync.

Priority: Medium.

### 11. Global `zoomedPaneId` can point outside the active tab

Files:
- `src/renderer/src/components/PaneGrid/index.tsx`
- `src/renderer/src/App.tsx`
- `src/renderer/src/components/Terminal/index.tsx`
- `src/renderer/src/store/panes.ts`

Current shape:
- `zoomedPaneId` is global.
- `PaneGrid` resolves the zoomed pane through `findPane`, which searches the active tab.
- Switching tabs can leave `zoomedPaneId` set for an inactive tab.

Risk:
- The zoom hotkey can unzoom an invisible zoom state instead of zooming the current focused pane.
- Returning to the original tab can unexpectedly restore zoom.

Improvement:
- Store zoom per tab, or clear/validate `zoomedPaneId` when `activeTabId` changes.
- Hotkey logic should only treat the UI as zoomed if the zoomed pane exists in the active tab.

Priority: Medium.

### 12. Optimistic detached focus can become confirmed-looking state

Files:
- `src/renderer/src/components/Sidebar/TabSections.tsx`
- `src/renderer/src/store/panes.ts`

Current shape:
- `focusDetachedPaneOptimistically` writes `activeWindowId`, detached active tab, and focused pane immediately.
- The pending guard timeout clears only the guard, not the optimistic state.

Risk:
- If remote focus fails, the primary sidebar can keep showing a detached pane as focused.
- Local highlights can be suppressed because `activeWindowId` no longer points at the primary window.

Improvement:
- Separate optimistic focus from confirmed focus.
- Use a shape such as:
  - `confirmedFocusTarget`
  - `pendingFocusTarget`
- Render optimistic highlights only while the request is pending, and revert on failure/timeout.

Priority: Medium.

### 13. Detached focus sync splits active window and focused pane updates

Files:
- `src/renderer/src/store/panes.ts`
- `src/renderer/src/components/Sidebar/TabSections.tsx`
- `src/main/ipc/handlers.ts`

Current shape:
- `pane:focus-changed` updates detached tab focus.
- `window:became-active` separately updates active window.

Risk:
- Event ordering can produce fresh pane focus with stale active window, or stale active window with fresh pane focus.
- Sidebar highlighting has to combine two independent event streams.

Improvement:
- Represent focus as a single target object:
  - `{ windowId, tabId, paneId, source, version }`
- Main should broadcast one focus transition when possible, or renderer should coalesce events by version.

Priority: Medium.

### 14. Terminal xterm options do not update when pane type mutates

Files:
- `src/renderer/src/components/Terminal/index.tsx`
- `src/renderer/src/store/panes.ts`

Current shape:
- Terminal xterm instance is created from `pane.paneType` and `agentKind`.
- The attach effect depends only on `pane.id`.
- `applyLayout` can later mutate an existing pane from agent to shell when resume fails.

Risk:
- A shell pane can keep agent terminal behavior, such as transparent cursor or agent key handling.

Improvement:
- Either update xterm options when `paneType` or `agentKind` changes, or replace the pane id when converting an agent pane to shell.

Priority: Medium.

### 15. Sidebar pane context actions operate on active-tab-only store methods

Files:
- `src/renderer/src/components/Sidebar/TabSections.tsx`
- `src/renderer/src/store/panes.ts`

Current shape:
- Sidebar renders panes for all tabs.
- `PaneRow` context actions call `closePane(pane.id)` and `movePaneToNewTab(pane.id)`.
- `closePane` searches only the active tab after disposing the pane's xterm registry entry.

Risk:
- Closing a pane from an inactive tab can dispose its terminal instance but leave the pane in store.
- Later activating the tab can show stale or recreated terminal state.

Improvement:
- Add tab-aware actions such as `closePaneInTab(tabId, paneId)`.
- Or make inactive pane context actions first activate/focus the tab and pane atomically, then mutate.

Priority: High.

### 16. Detached sidebar panes are not draggable, blocking pane moves from detached windows

Files:
- `src/renderer/src/components/Sidebar/TabSections.tsx`
- `src/renderer/src/components/PaneHeader/index.tsx`
- `src/renderer/src/components/TabBar/index.tsx`
- `src/renderer/src/store/panes.ts`

Current shape:
- The primary sidebar lists panes for both local and detached tabs.
- Local pane rows are draggable through `PaneRow`.
- Detached pane rows pass `onClickOverride` / `onMouseDownOverride` so clicks focus the remote window and pane.
- `PaneRow` sets `draggable={!renaming && !onClickOverride}`.
- Because detached rows always have `onClickOverride`, detached pane rows cannot start a drag.
- `PaneHeader` drag handles exist inside detached windows, but those drags only interact with drop targets in the same renderer/window. There is no payload or drop handling for dragging a pane from a detached window into the primary window or another detached window.

Risk:
- The multi-window spec says pane drag should work on all tabs, local and detached, but the current UI prevents detached-to-main and detached-to-detached pane moves.
- Users can move local panes to detached tabs from the primary sidebar, but cannot symmetrically move detached panes back or across windows.
- Any future pane transfer transaction work can appear broken because the source drag cannot be initiated.

Improvement:
- Separate "click focuses remote pane" from "row is draggable"; detached pane rows should still be draggable.
- Add a cross-window pane drag payload containing at least `{ pane, sourceTabId, sourceWindowId }` or `{ paneId, sourceTabId, sourceWindowId }`.
- For detached-pane drags started from the primary sidebar, main can already identify the target detached/local tab, but the source removal must be sent to the owning detached window rather than calling local `removePaneKeepTab`.
- For drags started inside a detached window, `PaneHeader` should set the cross-window pane payload and target windows should accept it on tab headers / tab bars.
- Use the existing acked `pane:transfer` flow or extend it so source removal happens only after target commit and PTY routing is moved.

Priority: High.

## Recommended Refactor Direction

### A. Introduce explicit transition actions

Store actions should match user-level operations:

- `focusPaneInTab(tabId, paneId)`
- `closePaneInTab(tabId, paneId)`
- `movePaneAcrossWindows(transferId, source, target)`
- `commitPaneRuntimeMetadata(paneId, metadata)`
- `setConfirmedFocusTarget(target)`
- `setPendingFocusTarget(target)`

Components should call transition actions, not compose lower-level actions with side effects.

### B. Keep side effects out of primitive setters

`setActiveTab` currently mutates state and broadcasts focus in detached windows. That makes it dangerous to compose.

Prefer:

- Pure state setters for small internal updates.
- Named transition actions for state plus IPC side effects.

### C. Add versions/generations to multi-window ownership

Detached tab ownership and focus requests need stale-message protection.

Recommended payload shape:

```ts
type TabStateSync = {
  windowId: number
  tabs: Tab[]
  activeTabId: string
  version: number
}

type FocusTarget = {
  windowId: number
  tabId: string
  paneId: string
  version: number
}
```

### D. Treat PTY movement as transactional

PTY routing should not move before the destination renderer can display the pane/tab.

Recommended phases:

1. Prepare transfer and assign transfer id.
2. Mark source pane/tab as transferring.
3. Destination commits pane/tab and acks.
4. Main moves PTY routing.
5. Source finalizes removal.
6. Sync/save ignores pending transfer objects or records them explicitly.

## Suggested Implementation Order

1. Fix inactive sidebar pane click to use `focusPaneInTab`.
2. Remove duplicate shell PTY creation ownership.
3. Add tab-aware sidebar pane actions, especially close.
4. Rework pane transfer and tab absorb as acked transactions.
5. Restore pane dragging main window <-> detached window, including detached-to-main and detached-to-detached source removal.
6. Add sync versions/generations for detached tab ownership.
7. Split optimistic focus from confirmed focus.
8. Convert `tab:state-sync` to a typed structured payload.
9. Validate/clear zoom state on active-tab changes.
10. Make terminal options respond to pane type changes or replace pane ids on type conversion.

## Open Questions

- Should shell PTY creation belong to the store or to `Terminal`? Current behavior suggests `Terminal`, because it owns connection lifecycle and resize.
- Should focus highlight represent OS focus only, or should pending remote focus be visibly optimistic?
- Should layout save/sync skip panes/tabs in pending transfer states, or persist the transfer state explicitly?
- Should detached windows be addressable before they ack init, or should main keep them hidden from routing until ready?
