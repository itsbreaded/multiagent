# 021 — Sidebar pane reorder: drag to swap with a highlighted target

## Problem

Dragging a pane within a tab's section in the sidebar to reorganize panes only ever
drops the pane **after** the target row (the old `movePaneToSplit(..., false)` call),
and there is no clear indication of where the dragged pane will land. Users want to drag
a pane onto another and have the two **trade places**, with a clear highlight showing
which pane is the swap target — without disturbing the rest of a carefully arranged
layout.

## Design decision — pane swap, not reorder, not split-insert

The sidebar lists a tab's panes as a flat vertical list in `collectLeaves` order, but the
underlying model is a binary tree (`PaneSplit`/`PaneLeaf`) that renders as a **2D pane
grid of unequal cells**. Three behaviors were considered:

1. **Split-insert via `movePaneToSplit(..., sourceBefore)`** — creates a *new* split node
   at the drop target, changing the grid shape (column count, nesting, ratios). Rejected:
   the layout must be preserved.
2. **Full reorder (insert + shift over fixed slots)** — freezes the tree shape but, on
   every move, *cascades* every pane between source and target into new slots and new
   sizes. In a complex layout this means dragging one pane visibly reshuffles and resizes
   many others, destroying the user's spatial organization. Rejected for that reason.
3. **Pane swap (chosen).** The dragged pane and the drop target **exchange positions**;
   every other pane stays exactly where it is, at the same size. Only two cells change.
   This preserves the user's layout and spatial mental map, which matters most in complex
   grids. There is no before/after — you swap *with* the target.

Rationale: for a 2D grid of unequal cells, minimal-motion swap is more predictable and
less disruptive than a reorder cascade. A swap has no insertion position, so the drop
affordance is a **target-row highlight** ("drop here to trade places"), not an insertion
line.

## Current behavior (must be replaced)

`src/renderer/src/store/panes.ts` currently has `reorderPaneInSidebar(source, target,
sourceBefore)`, which implements **full reorder** via a `collectLeaves` permutation +
`assignLeavesInOrder`. `src/renderer/src/components/Sidebar/TabSections.tsx` `PaneRow`
computes a `dropEdge` (`'before' | 'after'`) from cursor Y and renders a 2px insertion
line. Both must change to swap semantics.

## Intended behavior

- While dragging a pane over another sidebar `PaneRow` (a different pane), **highlight the
  whole target row** with the accent color to signal "drop here to swap." No top/bottom
  detection.
- On drop, **swap the two panes' positions** in the tab's tree. The split structure
  (every split node's id, direction, and ratio) is preserved byte-for-byte; only the two
  leaves trade slots. Each `PaneLeaf` keeps its own id/`ptyId`/`sessionId`, so live PTYs
  follow their panes. No new splits are created or removed; no other pane moves or resizes.
- Behavior is identical regardless of where the two panes sit in the tree (direct
  siblings or not) — one uniform swap, no special-casing.

## Implementation phases

### Phase 1 — Replace the store action with a uniform swap
In `src/renderer/src/store/panes.ts`:
- Remove `assignLeavesInOrder` (added for the reorder approach; no longer needed).
- Add a single-pass `swapLeaves(node, idA, idB, leafA, leafB)` helper that returns a new
  tree with the two leaf nodes exchanged in their structural positions, preserving all
  split nodes' id/direction/ratio.
- Replace `reorderPaneInSidebar(source, target, sourceBefore)` with
  `swapPanes(sourcePaneId, targetPaneId)` (named generically — spec 022 reuses it from the
  pane header):
  1. No-op if `sourcePaneId === targetPaneId`.
  2. Find the single tab whose `rootNode` contains both ids.
  3. Resolve both `PaneLeaf` objects; bail if either is missing.
  4. `swapLeaves` the tree, set `focusedPaneId` to `sourcePaneId`, write the tab.
- Do not touch `hydratedTabIds` (a swap needs no re-hydration), `movePaneToSplit`,
  `movePaneToTab`, or any transfer path.

### Phase 2 — Switch the renderer indicator to a target-row highlight
In `src/renderer/src/components/Sidebar/TabSections.tsx` `PaneRow`:
- Replace `dropEdge` state with a boolean `dropActive`.
- `onDragOver` sets `dropActive` true (keep the `if (!draggedPaneId || draggedPaneId ===
  pane.id) return` guard); remove the cursor-Y / `getBoundingClientRect` math.
- `onDragLeave`/`onDrop`/`onDragEnd` clear `dropActive` (keep the
  `e.currentTarget.contains(relatedTarget)` guard on leave).
- Remove the 2px insertion-line element. Indicate the swap target by highlighting the
  whole row — `outline: border.accent` with `outlineOffset: -1` (and optionally the
  raised background) when `dropActive`.
- `onDrop` calls `swapPanes(draggedPaneId, pane.id)`.

## Risks

- **PTY identity:** the swap must move whole `PaneLeaf` objects (with their ids), not copy
  payload fields between fixed slot ids, or `ptyId`/`sessionId`→pane routing breaks.
- **DragLeave flicker:** the `e.currentTarget.contains(relatedTarget)` guard prevents the
  highlight from flickering as the pointer crosses child nodes.
- **Header-drop isolation:** the swap state must not leak into the section-header drop
  handler, which transfers panes across tabs and is out of scope.
- **Self-drop:** dropping a pane on itself is guarded in both the handler and the action.

## Verification steps

1. `npm run typecheck` passes.
2. Tab with a 2-column layout (1 pane left, 2-pane stack right), panes **A | B / C**:
   - Drag **A** onto **C** → C's row highlights → drop → A and C trade cells; B unchanged,
     all sizes unchanged.
   - Drag **B** onto **A** → A and B trade cells; C unchanged.
3. Confirm the grid shape is unchanged after any swap: same column count, same split
   directions, same ratios — only the two swapped panes' contents move.
4. Swap a pane running a live agent/shell PTY and confirm its terminal/session stays alive
   and attached (scrollback intact, no "Connecting…" flash).
5. Confirm dragging a pane onto a different tab's section header still transfers the pane
   to that tab (unchanged).
6. No console errors; `draggedPaneId` and `dropActive` clear after drop/cancel.

## Handoff contract — non-negotiables

- **Swap, not reorder/insert.** Exactly two panes change position; no other pane moves or
  resizes. No before/after semantics.
- **Layout shape is frozen.** Preserve every `PaneSplit` node's id, `direction`, and
  `ratio`. Never create or remove a split during a sidebar swap.
- **Uniform behavior.** One swap path for all cases — no sibling/non-sibling branching.
- **Move leaf objects, preserve identity.** Each `PaneLeaf` keeps its `id`/`ptyId`/
  `sessionId` so PTYs follow panes.
- **Do not touch** `movePaneToSplit`, `movePaneToTab`, `transferPaneToTab`, the
  section-header drop handlers, or any detached/cross-window transfer path.
- **Target affordance is a row highlight**, using `border.accent` / `ui.color.accent` from
  `src/renderer/src/styles/theme.ts`. No new raw hex, no VS Code colors.
- **Clear drop state on every exit path** (`onDragLeave`, `onDrop`, `onDragEnd`).
- **`npm run typecheck` must pass** before handoff is considered complete.

## Definition of done

- Dragging a pane onto another in the sidebar highlights the target row and, on drop,
  swaps the two panes' positions.
- The grid layout shape (columns, split directions, ratios) and every non-swapped pane's
  position and size are unchanged; live PTYs follow their panes.
- `reorderPaneInSidebar`/`assignLeavesInOrder` are gone; the store exposes a single
  uniform `swapPanes`. `movePaneToSplit` and all cross-tab/cross-window transfer
  paths are untouched.
