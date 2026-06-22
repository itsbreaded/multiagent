# 025 — Reorder projects/tabs: sidebar drag + tab-bar reorder regression fix

## Summary

Two parts, one underlying model ("the order of the `tabs` array"):

1. **Feature** — let the user drag a project (sidebar section) up/down to reorder it in the
   Sidebar. Today sidebar sections render in `tabs` order but cannot be reordered there.
2. **Bug fix** — the **top tab bar** tab-reorder gesture is currently broken: dragging a tab
   onto another tab can move a pane into the target tab instead of reordering the tab. Root
   cause and analysis are in spec 024 ("Related regression: tab-bar reorder hijacked by stale
   `draggedPaneId`"). This spec owns the fix because it is the same "reorder the tab list"
   operation the sidebar feature needs.

The sidebar project order, the tab-bar order, and `tabs` array order are the **same single
source of truth**: `TabSections` maps over `tabs`, `TabBar` maps over
`tabs.filter((t) => !t.detached)`. Reordering anywhere is reordering `tabs`. So both parts
should funnel through one new store action: `reorderTab`.

## Current behavior

- **Tab bar** (`TabBar/index.tsx`): tabs are `draggable`; reorder is computed inline in the
  tab's `onDrop` via `usePanesStore.setState((s) => { …splice s.tabs… })`. Two defects:
  - It branches on the persistent `draggedPaneId` flag, which can be **stale** after a
    drag-to-split (the source `PaneHeader` is remounted and its `onDragEnd` never clears the
    flag — see spec 024). A stale flag turns a tab drag into `movePaneToTab(...)`.
  - `dragIndex.current` is a **filtered** index (over non-detached tabs) but the splice runs
    against the **unfiltered** `s.tabs`. With detached tabs present, the wrong tab moves.
- **Sidebar** (`Sidebar/TabSections.tsx`): section headers are **not** `draggable`. They only
  *accept* drops — `onHeaderDragOver`/`onHeaderDrop` move a dragged pane into that project
  (`movePaneToTab` / `transferPaneToTab`). There is no project-reorder gesture.
- **Store** (`store/panes.ts`): there is **no** `reorderTab` action. Tab order is only ever
  mutated by the tab bar's inline splice and by add/close/duplicate/receive flows.

## Intended behavior

### Tab bar (bug fix)
- Dragging a tab and dropping it on another tab **always reorders** the dragged tab to the
  drop position. It never moves a pane, regardless of any stale `draggedPaneId`.
- Dragging a **pane** (from a pane header or sidebar row, identified by `PANE_DRAG_MIME`) onto
  a tab still moves that pane into the tab (existing, intended behavior — preserved).
- Reorder works correctly whether or not detached tabs exist.

### Sidebar (feature)
- A project section can be dragged vertically to a new position among the other **local**
  (non-detached) projects; dropping commits the new order.
- The gesture is visually and behaviorally **distinct from the existing pane-drop-on-header**
  gesture so the two never collide (a pane drop onto a header still moves the pane into that
  project; a project drag reorders projects).
- Reordering a project in the sidebar is immediately reflected in the tab bar, and vice-versa
  (both read `tabs`).

## Design decisions

### D1 — One shared `reorderTab` store action

Add to `usePanesStore`:

```ts
// Move `tabId` so it lands immediately before `beforeTabId`, or at the end when
// beforeTabId is null. Operates on the full tabs array (no filtered-index math).
reorderTab: (tabId: string, beforeTabId: string | null) => void
```

Rationale for a *by-id* target (not a numeric index): callers compute "drop before tab X" /
"drop after tab X" from the hovered element; resolving the id to an index inside the action
sidesteps the filtered-vs-unfiltered index bug entirely. Both the tab bar and the sidebar
call this one action.

Edge cases the action must handle: `tabId === beforeTabId` (no-op), `beforeTabId` not found
(treat as append), dragged tab not found (no-op). It must not perturb `detached` tabs'
relative order or any other tab state — only array position changes.

### D2 — Tab bar: discriminate drag kind by MIME type, not by `draggedPaneId`

In `TabBar` `onDragOver`/`onDrop`, decide the path from the **drag event**, not the store flag:

- `e.dataTransfer.types.includes(PANE_DRAG_MIME)` → pane drop path (`movePaneToTab` /
  `pane:transfer`).
- else `TAB_DRAG_MIME` present (or a local tab drag in progress) → tab reorder/cross-window.

`draggedPaneId` may still be used as a *same-window convenience* for highlight state, but it
must **not** be the deciding signal for whether a drop is a pane move. The MIME type lives on
the in-flight drag and cannot go stale.

Replace the inline splice in `onDrop` with `reorderTab(draggedTabId, beforeTabId)` where
`beforeTabId` is derived from `dragSideRef` (`'left'` → this tab's id; `'right'` → the next
tab's id, or `null` if last).

### D3 — Also clear `draggedPaneId` reliably after a split (defense in depth)

Even with D2, the lingering stale `draggedPaneId` is a latent hazard (it makes
`PaneSplitDropTarget.isDropTarget` and sidebar/header guards read "a drag is in flight" when
none is). Clear it without cancelling the in-flight split:

- Preferred: in `movePaneToSplit` (and `movePaneToTab`/`swapPanes` as appropriate), reset
  `draggedPaneId: null` as part of the same `set(...)` that restructures the tree — the drop
  has already been read by the time the action runs, so clearing here cannot cancel it.
- Verify this does not regress the spec 022 concern (clearing in the *capture phase* cancelled
  splits; clearing inside the *store action that runs from `onDrop`* is after the drop is
  committed, so it is safe). Add a comment pinning down why this location is safe.

### D4 — Sidebar project-reorder gesture (distinct from pane drop)

The section header already consumes drops for "move pane into project." To add project
reorder without collision, options (pick during implementation; default = **A**):

- **A — dedicated drag affordance + `TAB_REORDER_MIME`:** make the section header draggable
  (or add a small grip in the header that is draggable), set a distinct
  `TAB_REORDER_MIME` payload (`{ tabId }`) on `onDragStart`. The header's existing
  `onHeaderDragOver`/`onHeaderDrop` continue to handle `PANE_DRAG_MIME` for pane moves; a new
  branch handles `TAB_REORDER_MIME` for reorder, showing an insertion line (above/below)
  instead of the pane-drop "fill" highlight. Drop → `reorderTab`. This keeps the two gestures
  unambiguous by MIME type, mirroring D2.
- **B — between-row drop zones:** thin drop strips rendered between sections that only accept
  `TAB_REORDER_MIME`. More markup, clearer insertion point, no header-hit-test ambiguity.

Only **local** (non-detached) projects participate in reorder; detached projects render with
the `↗` suffix and are not valid drag sources or reorder targets in v1 (their order is owned
by their own window). Dropping a reorder between/around detached entries should resolve to the
nearest valid local position.

### D5 — Affordance & feedback

- Tab bar: keep the existing left/right accent border insertion indicator.
- Sidebar: a horizontal accent insertion line between sections (not the `border.accent`
  *outline* used for pane-drop-on-header, so the two are visually different). Use tokens from
  `styles/theme.ts`; add a shared token if a new one is warranted.
- Drag state must clear on every exit path (drop, cancel, dragend, Escape). No stuck cursor or
  lingering insertion line.

## Open questions

- **Q1** — Should the section *title* itself be the drag handle (whole header draggable), or a
  small dedicated grip? Whole-header draggable is more discoverable but risks interfering with
  the header's click-to-activate / double-click-to-rename and the existing pane-drop target.
  Recommendation: dedicated grip (or `draggable` with a drag-threshold guard) to keep click,
  rename, and pane-drop intact.
- **Q2** — Cross-window: reordering is same-window-only in v1 (detached projects are owned by
  their window). Confirm that is acceptable, matching the cross-window scoping in spec 024 Q5.
- **Q3** — Should there be a keyboard affordance (e.g. move-project-up/down command in the
  command palette + registry entry) in addition to drag? Out of scope for v1 unless requested,
  but `reorderTab` makes it trivial to add later (see Command Registry rules in CLAUDE.md).

## Implementation phases

1. **Store** — add `reorderTab(tabId, beforeTabId)`; unit-reason through the edge cases in D1.
   Add `draggedPaneId: null` cleanup to `movePaneToSplit`/`movePaneToTab`/`swapPanes` (D3).
2. **Tab bar** — switch `onDragOver`/`onDrop` to MIME-type discrimination (D2); replace the
   inline splice with `reorderTab`; delete the filtered/unfiltered index math.
3. **Sidebar** — add the project-reorder gesture (D4 option A by default): draggable affordance,
   `TAB_REORDER_MIME`, insertion-line affordance, `reorderTab` on drop; keep the existing
   `PANE_DRAG_MIME` header-drop path untouched.
4. **Theme** — add any new insertion-line token to `styles/theme.ts`.

## Risks

- **Gesture collision** in the sidebar header (pane-drop vs project-reorder). Mitigated by
  MIME-type branching and distinct affordances (D4/D5).
- **Detached tabs**: reorder must not corrupt detached ownership maps or relative order;
  `reorderTab` only changes array position and must leave `detached`/window-ownership state
  alone. Cross-check the "Multi-Window State Invariants" section in CLAUDE.md.
- **Layout persistence**: tab order is part of saved layout (`layout:save`/`applyLayout`).
  Confirm a reorder triggers a layout save and round-trips on restart.
- Re-introducing a `draggedPaneId`-only guard in any drop surface would re-open the regression;
  keep MIME-type discrimination the rule (also called out in spec 024).

## Implementation notes

- **Q1 resolved**: whole section header made `draggable` (not a dedicated grip). Click and double-click still work because they don't conflict with drag start.
- **`onDragEnter` required alongside `onDragOver`**: the browser evaluates both when determining the drop cursor. Container-level `onDragEnter` + `onDragOver` are both needed; `onDragOver` alone causes a flicker on every element transition because `dragenter` fires before the first `dragover` on each new element.
- **`reorderTab(id, null)` inserts after last local tab**: `null` means "append at end of local tabs." Using `next.push(moved)` would place the tab after detached entries; fixed with `reduce` to find the last non-detached index.
- **`dragenter` does not bubble through `stopPropagation()` on `dragover`**: these are independent events — `stopPropagation()` on one does not prevent the other from reaching ancestor handlers.

## Verification steps

1. `npm run typecheck` passes.
2. Tab bar: drag tab → reorders to drop position (left/right indicator honored). Repeat
   **after** doing a drag-to-split (which strands `draggedPaneId`): tab still reorders and no
   pane is moved. This is the explicit regression guard for the reported bug.
3. Tab bar: drag a **pane** (header grip / sidebar row) onto a tab → pane still moves into the
   tab (intended behavior preserved).
4. Tab bar reorder is correct with one or more **detached** tabs present (no wrong-tab move).
5. Sidebar: drag a project to a new position → order updates; tab bar reflects the same order;
   pane-drop-onto-header still moves a pane into that project (no collision).
6. Reordered order persists across app restart (layout save/restore).
7. Drag state clears on every exit path; no stuck cursor, no lingering insertion line, no
   console errors.
8. Spec 021 (sidebar same-tab pane swap) and spec 022 (pane-header right-drag swap) still work
   — regression guard for the shared drag machinery.
