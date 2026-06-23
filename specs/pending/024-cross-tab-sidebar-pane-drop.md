# 024 — Cross-tab pane drop via sidebar: regression and design

## Problem

Specs 021 and 022 replaced the old sidebar pane-reorder logic with a **swap** gesture. In
doing so, the `PaneRow.onDrop` handler was simplified to always call
`swapPanes(draggedPaneId, pane.id)`. `swapPanes` is same-tab only — it finds the single
tab whose `rootNode` contains both IDs and bails silently when the two panes live in
different tabs.

Before spec 021 the drop handler did something different here (the old `reorderPaneInSidebar`
path). Now **cross-tab pane-row drops are silently no-ops**: the pane does not move, no
error is shown, and the drag state clears normally so there is no obvious signal to the
user that anything failed.

## Broader problem discovered during implementation (2026-06-23)

The original scope of this spec (fix the silent no-op) was resolved with a partial
implementation (see "What has been implemented" below), but that implementation exposed a
deeper inconsistency: **sidebar pane row drag ignores mouse button entirely**, making it
inconsistent with pane header drag:

| Gesture | Status |
|---|---|
| Left-drag pane header handle `⠿` | Split (directional drop zones appear) |
| Right-drag pane header handle `⠿` | Swap (spec 022) |
| Left-drag sidebar pane row → drop on pane grid | Split — **but targets don't appear cross-window** |
| Left-drag sidebar pane row → drop on another sidebar row | Was: swap (spec 021). Should be: **directional split, identical to the grid** |
| Right-drag sidebar pane row | **No-op** (context menu or nothing). Should be: **swap** |
| Left-drag sidebar pane row → cross-tab/cross-window | Was: silent no-op. Now: always swaps. Should be: **split** |

The pane header distinguishes gestures by mouse button: left = split (native DnD +
`draggedPaneId` + `PaneSplitDropTarget`), right = swap (manual pointer + `swapDrag` state).
The sidebar pane row has no right-drag handler at all, and its `onDrop` always routes to
swap regardless of which button started the drag.

## What has been implemented (partial — 2026-06-22)

- `panes.ts`: `swapPanesAcrossTabs(sourcePaneId, targetPaneId)` action added. Uses `replaceNode`
  to swap two leaf nodes across their respective tab trees. The store interface is updated.
- `TabSections.tsx` `PaneRow`:
  - `onDragOver` now reads `e.dataTransfer.types` for MIME-type detection (handles cross-window).
  - Detects cross-tab via leaf list check; sets `dropIsCrossTab` state; shows different outline
    (green solid = same-tab, blue dashed = cross-tab).
  - `onDrop` routes: same-tab → `swapPanes`, cross-tab same-window → `swapPanesAcrossTabs`,
    cross-window → `pane:transfer` IPC.

**Problem with the current implementation:** it makes all sidebar pane row drops into swaps,
regardless of whether the user did a left-drag or right-drag. This is wrong — left-drag
should split, right-drag should swap.

## Resolved questions (2026-06-23)

Three behaviors the original draft left ambiguous or under-specified, now decided:

1. **Right-click vs right-drag on a sidebar pane row.** The sidebar `PaneRow` has a
   right-click context menu (Rename, Open in new tab, Close pane, Open folder, Copy path,
   Copy session ID), unlike the pane-header handle which has none. So the right-drag swap
   gesture must NOT blindly suppress every `contextmenu` like the header does. **Decision:
   movement threshold.** A right-press that releases without moving past a small threshold
   (~5px) opens the context menu as today; only an actual right-*drag* (cursor moves past the
   threshold while the right button is held) begins a swap and suppresses the trailing
   contextmenu. See item 3 below.

2. **Cross-window swap / row-split.** A sidebar row can represent a pane that physically lives
   in a detached window (`sourceWindowId !== windowId`), because the primary sidebar lists
   detached tabs. **Decision: fully support cross-window.** Right-drag swap and left-drag
   row-on-row split must both work when the two panes live in different windows — not silently
   no-op (the original bug). This needs a new `pane:swap-transfer` IPC alongside
   `pane:split-transfer` (see items 2 and 3).

3. **Left-drag row-onto-row split direction.** **Decision (revised 2026-06-23): full directional
   split on sidebar rows, identical to the pane grid.** Dropping one sidebar row onto another shows
   the same 4-way directional zones (`PaneSplitDropTarget`), and the split happens at the chosen
   direction with the correct `sourceBefore`. There is no hardcoded vertical default and no separate
   "row split" behavior. See the **Unification principle** below — this is the central design goal:
   sidebar drags and pane-grid drags must produce the same outcomes through the same code, differing
   only in visual scale.

4. **Active-tab follow on cross-tab operations.** **Decision: keep the existing asymmetry.**
   Left-drag split (`movePaneToSplit`) sets `activeTabId` to the target tab and hydrates it, so the
   user is taken to the tab where the moved pane lands. Right-drag swap (`swapPanesAcrossTabs`) does
   NOT change `activeTabId` — the view stays put while two panes trade tabs. This is intentional;
   do not "normalize" the two paths. Implementers must preserve `movePaneToSplit`'s `activeTabId`
   set and must NOT add an `activeTabId` change to the swap path.

   **Cross-window split (decided 2026-06-23): raise and focus the target window.** When a left-drag
   split lands a pane in a tab owned by a *different* OS window, the target window switches its active
   tab to where the pane landed AND is raised to the foreground with focus (`BrowserWindow.show()` +
   `.focus()` in main after the insert commits). This extends "view follows the split" across windows.
   Cross-window *swap* still raises/focuses nothing (consistent with the no-view-change swap rule).

5. **Right-drag swap target surface.** **Decision: allow grid panes too, not just sidebar rows.**
   Resolve the swap target with `elementFromPoint` → `closest('[data-pane-id]')` (same as the pane
   header). This naturally matches both sidebar rows and live grid panes, so a sidebar right-drag can
   swap onto either. No extra guarding to restrict to the sidebar.

## Unification principle (2026-06-23) — the controlling design goal

**There must be no parallel code paths doing slightly different things between sidebar drags and
pane-grid drags.** The drop *target* (a sidebar `PaneRow` vs a grid pane) and the drop *source*
(a sidebar row vs a pane-header handle) are interchangeable. The behavior is decided entirely by
the **gesture**, never by the surface:

- **Left-drag → split**, with the *same* 4-way directional preview/zones on the target, whether the
  target is a grid pane or a sidebar row. Same `PaneSplitDropTarget` component, same direction +
  `sourceBefore` resolution, same `movePaneToSplit` / `pane:split-transfer` outcome.
- **Right-drag → swap**, with the *same* target resolution (`elementFromPoint` → `[data-pane-id]`)
  matching grid panes and sidebar rows alike, same `swapPanes`/`swapPanesAcrossTabs` /
  `pane:swap-transfer` outcome.

The only *intentional* difference is visual scale: a sidebar row is ~26px tall, so the directional
overlay is rendered smaller than on a full grid pane. The behavior, hit semantics, and code are the
same. The litmus test for every decision in this spec is **"what would the user expect?"** — and a
user who learned directional splits on the grid expects the identical gesture to work on a sidebar
row.

### Sole unavoidable mechanism split (NOT a behavior difference)

Left-drag must use native HTML5 DnD (only the left button fires `onDrop`); right-drag must use manual
pointer events (`mousedown`/`mousemove`/`mouseup`). This split is **by gesture, not by surface** —
split is always native-DnD and swap is always pointer on *both* the grid and the sidebar — so it does
not create divergent behavior. Do not try to "unify" these two event mechanisms; that is the floor.

### Gesture model

| Drag type | Drop target | Result |
|---|---|---|
| **Left-drag** | Grid pane **or** sidebar pane row (same or different tab/window) | Directional split at the chosen zone — identical 4-way preview on both |
| **Right-drag** | Grid pane **or** sidebar pane row (any tab/window) | Swap |
| Section header drop (any drag) | Tab section header | Plain transfer (unchanged) |

### Visual affordance

- Left-drag split target (grid pane or sidebar row): the **same** `PaneSplitDropTarget` directional
  overlay renders on the hovered target, sized to that target's box. On a sidebar row the top/bottom
  zones are thin (~13px) but behave identically to the grid. The highlighted zone/edge indicates
  where the moved pane will land.
- Right-drag swap target (grid pane or sidebar row): highlight the hovered target with the swap
  highlight style (`swapDrag?.targetId === target.id`), identical treatment on both surfaces.

### Cross-window split targets

Currently `PaneSplitDropTarget` checks `draggedPaneId !== null` (Zustand store) to decide
whether to render. That state is window-local, so dragging from window A to window B shows no
split targets in B. Confirmed symptom: "it just creates a split on the right — no highlight,
no directional control."

**Decision:** Full directional control cross-window. `PaneSplitDropTarget` must detect a pane
drag from `e.dataTransfer.types.includes(PANE_DRAG_MIME)` (authoritative, not store state) and
show the directional zones. Cross-window splits require a new `pane:split-transfer` IPC channel.

### Source tab on cross-tab operations

Tabs are never auto-closed. For a swap (right-drag), pane counts in both tabs stay the same —
the empty-tab edge case does not arise. For a split/transfer (left-drag), the source tab loses
a pane; if it was the only pane, it shows the default blank new-session screen. Never close.

### Cross-window routing rule (the single source of truth for items 3 and 4)

The sidebar only renders in the **primary** window, so a `PaneRow`'s drag/drop handlers always run
in the primary renderer and its store `windowId` is always the primary id. But the *panes* a row
represents may be owned by any window — each `PaneRow` carries a `sourceWindowId` prop = the window
that owns *that row's* pane/tab. A drop therefore involves two window ids that are independent of the
rendering window:

- `srcWin` = `payload.sourceWindowId` (window owning the **dragged** pane).
- `tgtWin` = window owning the **drop-target** pane. For a drop onto a sidebar row, that is the
  target row's `sourceWindowId` prop. For a drop onto a primary grid pane, `tgtWin = windowId`. For
  a right-drag swap, resolve it from the target pane id via the primary store: find the tab
  containing that pane; `tgtWin` is the primary id if `!tab.detached`, else the detached window id
  from the existing detached-ownership map.

**Route by these two ids — never by comparing only to the rendering window:**

- **Both local** (`srcWin === windowId && tgtWin === windowId`): call the local store action
  (`movePaneToSplit` for split, `swapPanesAcrossTabs` for swap). No IPC.
- **Otherwise** (either pane owned by another window — this single branch covers primary↔detached,
  detached↔primary, *and* detached↔detached): use the `*-transfer` IPC. The payload names
  `sourceWindowId: srcWin` and `targetWindowId: tgtWin` explicitly; main sends the remove to `srcWin`
  and the insert/replace to `tgtWin`. Do **not** special-case detached↔detached — the explicit ids
  make one branch handle every pairing.

Consequence: the `*-transfer` `targetWindowId` is **`tgtWin`**, never the primary `windowId`. The
partial implementation's `targetWindowId: windowId` (existing `onDrop`) is wrong for any target owned
by a detached window and must be replaced.

**Primary-sidebar mirror:** the primary window lists detached tabs from its mirrored copy. After a
cross-window op that mutates a detached tab (including detached↔detached), do not hand-patch the
primary store from the `*-transfer` handler — let the affected detached window(s) push their updated
state through the existing versioned `tab:state-sync` path, which refreshes the sidebar listing.
Rely on the generation/version guard already in place so a stale sync cannot revert the move.

## What still needs to be implemented

### 1. `PaneSplitDropTarget.tsx` — cross-window detection

- Add local `[isDragOver, setIsDragOver]` state.
- `isDropTarget = (draggedPaneId !== null && draggedPaneId !== pane.id) || isDragOver`.
- `onDragEnter`: `if (e.dataTransfer.types.includes(PANE_DRAG_MIME)) setIsDragOver(true)`.
- `onDragLeave`: clear on true leave (`!e.currentTarget.contains(e.relatedTarget)`).
- `onDrop` cross-window: decode `PANE_DRAG_MIME` payload; if `payload.sourceWindowId !== windowId`,
  invoke `pane:split-transfer` IPC instead of calling `movePaneToSplit` directly.

### 2. New IPC channel `pane:split-transfer` (cross-window directional split)

- **`shared/types.ts`**: add invoke channel `pane:split-transfer` with payload
  `{ pane: PaneLeaf, sourceTabId: string, sourceWindowId: number, targetPaneId: string, direction: SplitDirection, sourceBefore: boolean, targetWindowId: number }`.
- **`src/main/handlers.ts`**: handle `pane:split-transfer` — send `renderer:remove-pane` to
  `srcWin`, send `renderer:insert-at-split` to `tgtWin`, **then reroute the moved pane's PTY to
  `tgtWin`** (same PTY-routing path used by `pane:transfer`). Commit the target insert/ownership
  before rerouting the PTY (per the Multi-Window invariants); the source should not lose its copy
  until the target has committed. After the insert commits and the PTY reroutes, **raise and focus
  `tgtWin`** (`BrowserWindow.show()` + `.focus()`) when `tgtWin !== srcWin` (decision 4, cross-window
  split). The swap path (item 2a) raises no window.
- **`src/main/handlers.ts`**: add `renderer:remove-pane` and `renderer:insert-at-split` send
  channels.
- **Renderer IPC listeners**: handle `renderer:remove-pane` (call a new `removePaneById` store
  action) and `renderer:insert-at-split` (call a new `insertPaneAtSplit` store action).
- **`panes.ts`**: `removePaneById(paneId)` — remove the leaf from its tab tree (reuse `removeLeaf`).
  This is a **move, not a close**: it must NOT kill the pane's PTY/session and must NOT trigger a
  session refresh. If removing the leaf empties the tab, set `rootNode: undefined` / `focusedPaneId:
  ''` (same as `movePaneToSplit`'s source-tab branch); never auto-close the tab. If `paneId` was the
  tab's `focusedPaneId` but the tab is non-empty, refocus the first remaining leaf.
- **`panes.ts`**: `insertPaneAtSplit(pane, targetPaneId, direction, sourceBefore)` — insert the leaf
  next to `targetPaneId` (find the target leaf across this window's tabs, build a `makeSplit` exactly
  as `movePaneToSplit`'s target branch does). To preserve decision 4 ("view follows the split") in
  the **target** window, set that window's `activeTabId` to the target tab, `focusedPaneId` to the
  inserted pane, and call `hydrateTabRuntime(targetTabId, true)` — the same end state a local
  `movePaneToSplit` produces.

### 2a. New IPC channel `pane:swap-transfer` (cross-window swap)

Right-drag swap across windows cannot use the window-local `swapPanesAcrossTabs` store action.
Add a parallel channel to `pane:split-transfer`:

- **`shared/types.ts`**: invoke channel `pane:swap-transfer` with payload
  `{ sourcePane: PaneLeaf, sourceTabId: string, sourceWindowId: number, targetPane: PaneLeaf, targetTabId: string, targetWindowId: number }`.
- **`src/main/handlers.ts`**: handle `pane:swap-transfer` — instruct `sourceWindowId` to put
  `targetPane` where `sourcePane` was, and `targetWindowId` to put `sourcePane` where `targetPane`
  was (a dedicated `renderer:replace-pane` keyed by pane id is cleanest; `replaceNode` already swaps
  by id). Then reroute **both** PTYs to their new owning windows. Commit destination ownership in
  both windows before rerouting either PTY (per the Multi-Window invariants); this is the
  highest-risk path because two PTYs reroute in opposite directions at once.
- **Focus/activeTab: unchanged in both windows** (decision 4 — swap never moves the view). Do not
  set `activeTabId` or raise either window. Each window keeps its current active tab; only the leaf
  contents trade places, with `focusedPaneId` updated only if it pointed at a swapped pane (mirror
  `swapPanesAcrossTabs`).
- Both panes' tabs keep the same pane count — no empty-tab edge case.

### 3. `TabSections.tsx` `PaneRow` — right-drag swap gesture (with click/drag threshold)

- Add `onMouseDown` handler: if `e.button !== 2` or `renaming`, return. **Do not start the swap
  yet** — record the press origin (`{x, y}`) and register a capture-phase global `mousemove`
  listener. Swap begins only once the cursor moves past ~5px from the origin; at that point call
  `startSwapDrag(pane.id)` and add the `pane-dragging` class. A right-press released before
  crossing the threshold is a plain right-click and must let the existing `onContextMenu`
  (`setMenu`) fire normally.
- **Required prerequisite:** add `data-pane-id={pane.id}` to the `PaneRow` root `<div>`. Without it,
  `elementFromPoint` → `closest('[data-pane-id]')` cannot resolve a sidebar row as a swap target and
  the gesture silently fails. (Grid `PaneContainer` already carries this attribute.)
- **Hover tracking has exactly one writer:** the global `mousemove` listener calls
  `setSwapDragTarget(resolveTarget(x, y))`, where `resolveTarget` = `document.elementFromPoint` →
  `closest('[data-pane-id]')` returning the id only if `!== sourceId` (identical to the pane header).
  Do **not** also set the swap target from `onMouseEnter`/`onMouseLeave` — two writers race during a
  pointer-captured drag. The row's `onMouseEnter`/`onMouseLeave` are NOT used for swap targeting.
- Capture-phase global `mouseup` listener: read `swapDrag`; if a swap was started and a `targetId`
  is set, resolve `tgtWin` and route per the **Cross-window routing rule** above:
  - Both local: `swapPanesAcrossTabs(sourceId, targetId)` (handles same-tab and cross-tab — item 5).
  - Otherwise: build the `pane:swap-transfer` payload — look up `sourcePane`/`sourceTabId`/`srcWin`
    (captured at gesture start) and `targetPane`/`targetTabId`/`tgtWin` (from the primary store by
    `targetId`) — and invoke item 2a. Do not call the local store swap; it cannot reach another window.
  Then `clearSwapDrag()`, remove class, remove listeners. If the threshold was never crossed, just
  tear down the move/mouseup listeners and let the context menu open.
- Capture-phase global `contextmenu` listener: `stopImmediatePropagation()` to suppress — **only
  register this once the threshold is crossed** (i.e. an actual drag), so a plain right-click still
  reaches `onContextMenu`. Self-remove after firing (and defer removal one tick, as the header does).
- Visual: show swap-target highlight when `swapDrag?.targetId === pane.id` (subscribe to `swapDrag`,
  see the subscription note below). Grid `PaneContainer` already does this, so a sidebar→grid swap
  highlights the grid pane with no extra work.

### 4. `TabSections.tsx` `PaneRow` — left-drag = directional split via the shared overlay

The row must become a directional split target using the **same** `PaneSplitDropTarget` logic the
grid uses — not a hardcoded vertical split. Two viable shapes; prefer (a):

- **(a) Reuse `PaneSplitDropTarget` directly.** Render a `PaneSplitDropTarget` (or a thin extraction
  of its zone-detection + overlay) absolutely-positioned over the row while a left-drag is in
  progress, sized to the row box. It already computes `(direction, sourceBefore)` from the cursor
  zone, renders the overlay, and (per item 1) detects the drag via
  `e.dataTransfer.types.includes(PANE_DRAG_MIME)`. The row passes its own `pane.id` as the target.
  This is the maximal-unification choice (selected 2026-06-23): identical component, identical zone
  math, identical visuals scaled to the row.
- **(b)** If `PaneSplitDropTarget` cannot be mounted over a row without refactor, extract its
  zone-resolution into a shared helper `resolveSplitZone(rect, x, y) → { direction, sourceBefore }`
  and a shared overlay component, and use both in the row. Do **not** re-derive a second, slightly
  different zone calc — that is the parallel-path failure this spec forbids.

Routing once a zone is chosen (replaces the old hardcoded `'vertical', false`) — apply the
**Cross-window routing rule** above with `srcWin = payload.sourceWindowId`,
`tgtWin = ` this row's `sourceWindowId` prop:
- Both local: `movePaneToSplit(payload.pane.id, pane.id, direction, sourceBefore)`
  (`movePaneToSplit` already handles same-tab and cross-tab). **Remove the `swapPanes` call** and the
  `else if (localDragId)` swap fallback — left-drag splits, never swaps.
- Otherwise: invoke `pane:split-transfer` with `targetWindowId: tgtWin` (NOT `windowId`) and the
  chosen `direction` / `sourceBefore`. Same payload shape the grid drop target sends.

**Stale-`draggedPaneId` cleanup (spec-025 lesson, see bottom).** The sidebar left-drag currently
relies on `onDragEnd` to clear `draggedPaneId`. When the source pane moves out on drop, the source
`PaneRow` instance can unmount before `onDragEnd` fires, leaving `draggedPaneId` stale and hijacking
the next tab-bar/pane drag. Mirror the pane header's `beginNativeDrag`: in the row's `onDragStart`,
register capture-phase global `drop` and `dragend` listeners that clear `draggedPaneId` and the
row's local drop state, and self-remove. Do not depend on `onDragEnd` alone.

Whichever overlay shape is used, the row's split overlay and the grid's must share the zone math and
the overlay component so a future change to split-zone behavior updates both at once. The zone→
(`direction`,`sourceBefore`) mapping is owned by that shared code — do not restate or re-derive it.

### 5. `panes.ts` — `swapPanesAcrossTabs` same-tab handling

Currently `swapPanesAcrossTabs` returns early if both panes are in the same tab. Remove that
guard and handle same-tab with `swapLeaves` (same algorithm as `swapPanes`), making it a
unified "swap anywhere" action. This simplifies the right-drag mouseup handler — it can always
call `swapPanesAcrossTabs` without branching on same-tab vs cross-tab.

## Implementation notes and gotchas

### `onDrop` only fires for left-drag — never for right-drag

Native HTML5 `onDrop` is triggered exclusively by left-button drag (the browser's native DnD
protocol). Right-drag uses manual pointer events (`onMouseDown` button 2 → global `mousemove`
/ `mouseup`) and never produces a `drop` event. This means:

- **`onDrop` on `PaneRow` is a left-drag-only handler.** It should contain only split routing.
  Swap routing does not belong here and should be removed entirely.
- The right-drag gesture is fully handled by the pointer listeners added in `onMouseDown` and
  never reaches `onDrop` at all.
- The `else if (localDragId)` fallback in the current `onDrop` also needs to become
  `movePaneToSplit`, not `swapPanes`.

### `movePaneToSplit` already handles cross-tab for same-window drops

`movePaneToSplit` in `panes.ts` loops through all tabs to find both panes — it is not
same-tab-only. For a **both-local** cross-tab left-drag sidebar drop, call
`movePaneToSplit(payload.pane.id, pane.id, direction, sourceBefore)` with `direction` /
`sourceBefore` taken straight from the shared zone resolver (item 4). No new store action is needed
for this path. `movePaneToSplit` already removes the pane from its source tab, inserts it next to the
target pane, sets `activeTabId` to the target tab, and calls `hydrateTabRuntime` — i.e. it is the
local equivalent of the cross-window `insertPaneAtSplit` end state.

`direction`/`sourceBefore` are never hardcoded and never restated here — they are whatever the shared
`PaneSplitDropTarget` zone logic returns, identical to the grid.

### `onMouseDown` handler must guard `button === 2`

`PaneRow` currently has `onMouseDown={() => { if (!renaming) onMouseDownOverride?.() }}`.
This fires for all mouse buttons. When the right-drag swap handler is added, a right-click on
a pane row must NOT also trigger `onMouseDownOverride` (which sets pane focus). Update to:

```ts
onMouseDown={(e) => {
  if (renaming) return
  if (e.button === 2) { /* arm threshold: record origin + register mousemove; swap starts only past ~5px */ return }
  onMouseDownOverride?.()
}}
```

Note the swap is *armed* but not *started* on right-mousedown — `startSwapDrag` fires only after the
cursor crosses the ~5px threshold. A right-press that releases under the threshold is a plain
right-click: it must NOT call `onMouseDownOverride` (focus) and must let `onContextMenu` open the menu.

### `swapDrag` store subscriptions needed in `PaneRow`

The right-drag swap gesture reuses the existing `swapDrag` store state (also used by pane
header right-drag). `PaneRow` needs these subscriptions:

```ts
const swapDrag = usePanesStore((s) => s.swapDrag)
const startSwapDrag = usePanesStore((s) => s.startSwapDrag)
const setSwapDragTarget = usePanesStore((s) => s.setSwapDragTarget)
const clearSwapDrag = usePanesStore((s) => s.clearSwapDrag)
```

`swapDrag` must be subscribed (not just read imperatively) so that `swapDrag?.targetId === pane.id`
re-renders the highlight reactively as the global `mousemove` updates the target. (The target is set
by `setSwapDragTarget` from the `mousemove` handler — see item 3 — not by row hover handlers.)

### `PaneSplitDropTarget` self-drop guard cross-window

`onDragEnter` cannot call `getData()` — browsers only expose data in `onDrop`. So for
cross-window drags, the split overlay will activate even when the user drags a pane over
itself (same pane id, different window). `movePaneToSplit` guards `sourcePaneId === targetPaneId`
internally and returns early, so no corruption occurs — it's just a minor visual glitch
(targets flash briefly). Acceptable for now.

### `pane:split-transfer` exact payload for sidebar row drops

When a cross-window left-drag sidebar row drop lands on a `PaneRow`, `direction` / `sourceBefore`
come from the directional zone the cursor was over (item 4), exactly as on the grid:

```ts
window.ipc.invoke('pane:split-transfer', {
  ...payload,                       // pane, sourceTabId, sourceWindowId (= srcWin)
  targetPaneId: pane.id,
  direction,                        // from the shared zone resolver, NOT hardcoded
  sourceBefore,                     // from the shared zone resolver
  targetWindowId: sourceWindowId,   // tgtWin = the TARGET row's sourceWindowId prop, NOT the primary windowId
})
```

`targetWindowId` is the target row's `sourceWindowId` prop (`tgtWin`), not the rendering window —
see the Cross-window routing rule. This is the identical payload the grid `PaneSplitDropTarget`
sends (where `tgtWin === windowId` because the grid is in the dropping window).

### `swapPanesAcrossTabs` — same-tab unification detail

Remove the `if (sourceTabIdx === targetTabIdx) return s` guard. Replace with:

```ts
if (sourceTabIdx === targetTabIdx) {
  const newRoot = swapLeaves(root, sourcePaneId, targetPaneId, sourceLeaf, targetLeaf)
  return { ...s, tabs: s.tabs.map((t, i) =>
    i === sourceTabIdx ? { ...t, rootNode: newRoot, focusedPaneId: sourcePaneId } : t
  ), draggedPaneId: null }
}
```

After this change, the **both-local** swap path always calls `swapPanesAcrossTabs` without needing to
determine which tab each pane lives in first (it handles same-tab and cross-tab). The cross-window
path still routes to `pane:swap-transfer` per the Cross-window routing rule — `swapPanesAcrossTabs`
is local-store only and cannot reach a pane in another window.

## State of existing code (to keep or revert)

- `panes.ts` `swapPanesAcrossTabs`: **keep** the store action; modify per item 5 above.
- `TabSections.tsx` `PaneRow.onDragOver`: **keep** the MIME-type detection (used to activate the
  directional overlay), but the simple full-row outline is **superseded** by the directional split
  overlay (item 4) — the row now shows the same zone overlay the grid does, not a single outline.
- `TabSections.tsx` `PaneRow.onDrop`: **rework** — left-drag → directional split (zone-resolved),
  right-drag → swap (right-drag path handled by the new pointer listeners, not by `onDrop`).
- The old `dropIsCrossTab` green-vs-blue-dashed outline: **retire** as the primary affordance. The
  directional overlay already communicates "split here, this direction." A subtle cross-tab/window
  tint on the overlay is optional, but do not maintain a second, outline-only highlight path in
  parallel with the overlay.

## Handoff contract — non-negotiables

1. **One behavior per gesture, not per surface.** Left-drag = directional split, right-drag = swap,
   on grid panes and sidebar rows alike. No second zone-resolution, no surface-specific outcome.
2. **Shared split code.** The sidebar row's directional overlay and zone→(`direction`,`sourceBefore`)
   mapping come from the same `PaneSplitDropTarget` logic as the grid (item 4 shape (a) preferred,
   (b) via a shared `resolveSplitZone` helper if a refactor is needed). No duplicated zone math.
3. **Cross-window routing by explicit window ids** (`srcWin`/`tgtWin`), never by the rendering
   window. `*-transfer` `targetWindowId` is `tgtWin`. One IPC branch covers primary↔detached and
   detached↔detached.
4. **Moves never kill PTYs.** `removePaneById` detaches the leaf without killing the PTY/session;
   `pane:split-transfer`/`pane:swap-transfer` reroute PTYs to the new owning window(s).
5. **Right-click still works.** The ~5px threshold means a plain right-click opens the `PaneRow`
   context menu; only a real right-drag swaps and suppresses `contextmenu`.
6. **Focus rules:** cross-window split raises+focuses `tgtWin` and switches its active tab; swap
   changes no active tab and raises no window (decision 4).
7. **No stale drag state.** Sidebar left-drag uses capture-phase `drop`/`dragend` cleanup (spec-025
   lesson); `draggedPaneId`, `swapDrag`, and local drop state clear on every exit path.
8. **No config/file mutation, no auto-close of tabs.**

## Definition of done

- `npm run typecheck` and `npm run build` pass.
- All Verification steps below pass by manual check in `npm run dev`, including the cross-window
  (7, 7a, 7b, 7c) and threshold (3a) cases.
- `data-pane-id` present on `PaneRow`; swap target resolves for both sidebar rows and grid panes.
- New IPC channels `pane:split-transfer` and `pane:swap-transfer` and their `renderer:*` companions
  are declared in `src/shared/types.ts` (the single source of truth) with matching preload wiring.

## Verification steps

1. `npm run typecheck` passes.
2. Same-tab left-drag sidebar row → drop on pane grid: split at chosen direction. Regression guard for spec 021 left-drag flow.
3. Same-tab right-drag sidebar row → drop on another sidebar row: swap. Rows highlight on hover during drag.
3a. Plain right-click (no drag) on a sidebar row still opens its context menu (Rename / Close / Open folder / Copy path…). Regression guard for the threshold.
4. Cross-tab left-drag sidebar row → drop on pane grid (same window): split with directional targets in target tab.
5. Cross-tab left-drag sidebar row → drop on another sidebar pane row: the 4-way directional overlay appears on the row; splitting at the chosen zone moves the pane to the target tab at that direction (identical to the grid). No hardcoded vertical.
5a. Same-tab left-drag sidebar row → another sidebar row: directional overlay appears; chosen zone splits in-place. The same zone math/overlay as the grid (no second code path).
6. Cross-tab right-drag sidebar row → swap across tabs. Both tabs retain all panes.
7. Cross-window left-drag sidebar row → drop on pane grid in detached window: split targets appear (directional); splits at chosen direction.
7a. Cross-window left-drag sidebar row → drop on another sidebar row whose pane lives in a different window: directional overlay on the row; chosen zone splits via `pane:split-transfer` into the target window/tab (`targetWindowId = tgtWin`), and the moved pane's PTY reroutes to that window.
7c. Detached→detached: drag a row owned by detached window D1 onto a row owned by detached window D2 (gesture performed in the primary sidebar). Split and swap both route correctly via the `*-transfer` IPC with explicit src/tgt window ids — neither endpoint is the primary window.
7b. Cross-window right-drag swap (one or both rows belong to a detached window): panes swap via `pane:swap-transfer`; both windows retain their pane counts; PTYs reroute to new owners.
8. Right-drag pane header same-tab swap still works (regression guard for spec 022).
9. Section-header cross-tab transfer still works (unchanged code path).
9a. Right-drag a sidebar row onto a live pane in the grid: swaps the two panes (target surface includes grid panes, not only sidebar rows).
9b. After a left-drag cross-tab split, the view switches to the target tab; after a cross-tab right-drag swap, the view stays on the current tab. (Asymmetry is intended — regression guard against accidental normalization.)
10. Source tab never auto-closes when it loses a pane.
11. No console errors; drag state (`draggedPaneId`, `swapDrag`, `isDragOver`) clears on every exit path.

---

## Related regression: tab-bar reorder hijacked by stale `draggedPaneId`

(Documented here for context; owned by **spec 025**, which is already implemented.)

Drag tab A in the top tab bar → tab B. Instead of reordering, a pane from a previous drag
moves into tab B. Root cause: `draggedPaneId` stays non-null after a drag-to-split because
the source element is remounted mid-drag and its `onDragEnd` never fires. Tab bar then treats
a genuine tab drag as a pane drop. Spec 025 fixed this via MIME-type discrimination
(`TAB_DRAG_MIME` vs `PANE_DRAG_MIME`) in the tab bar handlers.

The lesson for this spec: all drag surfaces should discriminate by `e.dataTransfer.types`,
not by store state alone.
