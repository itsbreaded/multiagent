# 022 — Pane header: right-click drag to swap panes

## Problem

The pane header has a drag handle (`⠿`, top-left) that starts a native HTML5 drag used
to **split/rearrange** panes (left-drag → `PaneSplitDropTarget` → `movePaneToSplit`).
Spec 021 added a **swap** gesture in the sidebar (drag a pane onto another → they trade
positions, layout preserved). Users want the same swap available from the pane header:
**right-click drag** the handle onto another pane to swap them, while left-drag keeps its
existing split behavior.

## Constraint — right button cannot use native DnD

Native HTML5 drag-and-drop (`draggable` + `dragstart`/`drop`/`dataTransfer`) only
initiates on the **primary (left) mouse button**. A right mouse press fires `contextmenu`,
never `dragstart`. So the swap gesture cannot reuse the existing native-DnD plumbing; it
must be a small **custom pointer-drag**: `mousedown` with `button === 2` on the handle,
`mousemove`/`mouseup` listeners on `window`, hit-testing the pane under the cursor, and
committing a swap on release. Left-drag (split) is untouched and continues to use native
DnD.

## Intended behavior

- **Left-drag** the header handle → unchanged (native DnD → split via
  `PaneSplitDropTarget`).
- **Right-button press + drag** on the header handle → starts a swap drag:
  - As the cursor moves over panes in the active tab, the pane under the cursor is the
    **swap target** and is highlighted with an accent overlay (mirrors the sidebar's
    target-row highlight affordance).
  - On release over a valid target (a different pane in the same tab) → the two panes
    **swap positions** via the shared `swapPanes` action (layout shape frozen; only the
    two leaves trade slots; PTYs follow their panes).
  - Release over the source pane, over no pane, or outside the window → no-op.
  - The `contextmenu` event that would otherwise fire on right-mouse-up is suppressed for
    the duration of the gesture so no menu pops up after a swap.
- Swap is **same-tab only**, like the sidebar swap. Cross-tab/cross-window movement
  remains the job of the existing header/section-header transfer paths and is out of scope.

## Implementation phases

### Phase 0 — Rename `swapPanesInSidebar` → `swapPanes`
The action is no longer sidebar-specific. Rename it (interface, implementation, and the
`TabSections.tsx` caller) to `swapPanes(sourcePaneId, targetPaneId)`. Behavior unchanged.

### Phase 1 — Transient swap-drag state in the panes store
Add a small UI-only slice (next to `draggedPaneId`):
- `swapDrag: { sourceId: string; targetId: string | null } | null` (initial `null`).
- `startSwapDrag(sourceId)` → sets `{ sourceId, targetId: null }`.
- `setSwapDragTarget(targetId | null)` → updates `targetId` only while a drag is active.
- `clearSwapDrag()` → sets `swapDrag` to `null`.
Commit is done by the component (it reads `swapDrag` and calls `swapPanes`), keeping the
store state pure/transient.

### Phase 2 — Hit-testable pane containers
Add `data-pane-id={pane.id}` to the `PaneContainer` root `<div>` so a swap drag can
resolve the pane under the cursor via
`document.elementFromPoint(x, y)?.closest('[data-pane-id]')`. Inactive tabs render with
`visibility: hidden` + `pointerEvents: none`, so `elementFromPoint` only returns
active-tab panes — no cross-tab false hits.

### Phase 3 — Target highlight overlay
In `PaneContainer` (or `Terminal`), when `swapDrag?.targetId === pane.id`, render a
non-interactive accent overlay (e.g. `inset 0`, `2px solid` accent, low-alpha accent fill,
`pointerEvents: 'none'`, high `zIndex`) to indicate the swap target. Reuse the same green
accent used elsewhere (`#4ade80` / theme accent).

### Phase 4 — Right-drag gesture on the header handle
In `PaneHeader`, on the drag handle:
- `onMouseDown`: if `e.button === 2`, `e.preventDefault()`/`stopPropagation()`,
  `startSwapDrag(pane.id)`, and attach `mousemove`/`mouseup` listeners to `window` plus a
  one-shot `contextmenu` suppressor.
- `mousemove`: hit-test the pane under the cursor; `setSwapDragTarget(targetId)` (null when
  over the source or no pane).
- `mouseup`: read `swapDrag`; if `targetId` is set and differs from `sourceId`, call
  `swapPanes(sourceId, targetId)`; then `clearSwapDrag()` and remove all listeners.
- Ensure listeners are also cleaned up if the component unmounts mid-drag.
- A small drag threshold (a few px) before activating avoids treating a plain right-click
  as a drag, so a future header context menu (if added) is not blocked by stray gestures.

## Risks

- **Listener leaks:** `mousemove`/`mouseup`/`contextmenu` listeners must be removed on
  `mouseup` and on unmount. Track them in a ref and clean up in a `useEffect` return.
- **Context menu bleed-through:** the terminal has its own right-click context menu
  (`Terminal.onContextMenu`). Because the gesture starts on the header handle (not the
  terminal) and we suppress the trailing `contextmenu`, the terminal menu should not
  appear; verify it doesn't after a release over a terminal.
- **xterm event capture:** the target pane's xterm may consume mouse events, but `window`
  listeners and `document.elementFromPoint` are unaffected by which element handles the
  event, so hit-testing still works over terminals.
- **Source highlight vs. target:** only the target needs a highlight; do not dim/replace
  the source's content (keeps the gesture legible).
- **Discoverability:** right-drag is a non-standard, hidden gesture. Update the handle
  `title` to mention it (e.g. "Left-drag to split · Right-drag to swap"). If discoverability
  proves poor, a modifier (Alt+left-drag) is a viable alternative — out of scope here.

## Verification steps

1. `npm run typecheck` passes.
2. Two-pane tab: right-drag pane A's handle onto pane B → B highlights → release → A and B
   swap; layout shape, columns, and ratios unchanged.
3. Complex 3–4 pane grid: right-drag swaps exactly the two involved panes; all others keep
   position and size.
4. Left-drag the handle still splits (drops via `PaneSplitDropTarget`) — unchanged.
5. Right-drag and release over the **source** pane, over empty space, or outside the
   window → no swap, no leftover highlight, no context menu.
6. Right-drag over a terminal pane and release → swap happens and **no** terminal
   copy/paste context menu appears.
7. Swap a pane with a live agent/shell PTY → terminal/session stays alive and attached.
8. No console errors; `swapDrag` clears after every gesture; no lingering `window`
   listeners (verify the gesture can be repeated indefinitely).

## Handoff contract — non-negotiables

- **Left-drag split is untouched.** Only a right-button gesture triggers swap; the native
  DnD split path is unchanged.
- **Reuse `swapPanes`.** No second swap implementation; the header and sidebar share the
  one store action. Swap is same-tab only.
- **Layout shape frozen / identity preserved** (inherited from spec 021): only two leaves
  trade slots; split ids/directions/ratios preserved; each `PaneLeaf` keeps its
  `id`/`ptyId`/`sessionId`.
- **No listener leaks / no context-menu bleed-through.** All `window` listeners removed on
  release and unmount; the trailing `contextmenu` is suppressed.
- **Reuse the theme accent** for the target overlay; no new raw hex, no VS Code colors.
- **`npm run typecheck` must pass** before handoff is considered complete.

## Definition of done

- Right-click dragging a pane header handle onto another pane in the same tab swaps the
  two panes, with the target highlighted during the drag and the layout shape preserved.
- Left-drag still splits; the terminal context menu never appears as a side effect of a
  swap gesture.
- The store exposes a single `swapPanes` action (renamed from `swapPanesInSidebar`) used by
  both the sidebar and the pane header; swap-drag state is transient and always cleared.
