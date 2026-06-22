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

## What still works vs. what is broken

| Gesture | Status | Handler |
|---|---|---|
| Drag pane within the same tab's sidebar section | **Works** (spec 021) | `swapPanes` |
| Right-drag pane header onto another pane in same tab | **Works** (spec 022) | `swapPanes` |
| Drag pane from tab 1 → drop on **tab 2's section header** | **Works** (pre-existing) | `movePaneToTab` / `transferPaneToTab` |
| Drag pane from tab 1 → drop on **a pane row inside tab 2's section** | **Broken** | calls `swapPanes` → silent no-op |

### Root cause

`src/renderer/src/components/Sidebar/TabSections.tsx` `PaneRow.onDrop` (line ~438):

```ts
onDrop={(e) => {
  if (!draggedPaneId || draggedPaneId === pane.id) return
  e.preventDefault()
  e.stopPropagation()
  swapPanes(draggedPaneId, pane.id)   // ← same-tab only; cross-tab drops silently no-op
  ...
}}
```

`swapPanes` in `panes.ts` finds the single tab containing both IDs:

```ts
const tab = tabs.find(t => containsPane(t.rootNode, sourcePaneId) && containsPane(t.rootNode, targetPaneId))
if (!tab) return   // ← silent bail when panes are in different tabs
```

The `onDragOver` guard `if (!draggedPaneId || draggedPaneId === pane.id) return` does not
check whether the dragged pane belongs to this pane's tab, so cross-tab pane rows accept
the drag visually (highlight, `e.preventDefault()`) but do nothing on drop.

## Design questions — must be resolved before implementation

The intended behavior when a user drags pane A (from tab 1) and drops it on pane B (inside
tab 2's section in the sidebar) is **not decided**. This spec exists first to document the
regression, then to collect user answers to the following questions before any code is
written.

### Q1 — What should dropping tab 1's pane A onto tab 2's pane B do?

Options:

1. **Plain transfer (ignore B):** pane A moves to tab 2 — the same outcome as dropping on
   the tab 2 section header, except the target pane B provides no affordance for "where in
   tab 2 will A land" (it just appends to tab 2's root, which is what `movePaneToTab`
   currently does). Pane B is unaffected.

2. **Cross-tab swap:** pane A and pane B exchange tabs. A takes B's slot in tab 2's tree;
   B takes A's slot in tab 1's tree. Both layouts preserve their overall shape — only the
   two leaf positions trade across tab boundaries. This is the logical extension of the
   same-tab swap.

3. **Transfer + take B's slot:** pane A moves to tab 2 and is placed at B's tree position
   (B shifts to accommodate, or B and A swap within tab 2's tree). Pane B stays in tab 2.
   This is the most complex option and may conflict with the "layout shape frozen" principle
   from specs 021/022.

4. **No-op on pane rows, header-only cross-tab:** explicitly reject pane-row drops when
   the source and target pane belong to different tabs. Users must drop on the section
   header to move across tabs. Clear visual feedback (cursor change, no highlight) is needed
   to distinguish the affordance from same-tab rows.

### Q2 — Should the highlight affordance change for cross-tab pane-row hover?

Currently `PaneRow.onDragOver` highlights the row identically for same-tab and cross-tab
drags. If the behavior differs (e.g. Q1 option 1 = transfer vs. swap for same-tab), the
highlight should visually distinguish the two — otherwise users cannot predict the outcome.

Options:
- **Same highlight:** accept that the gesture is uniform; cross-tab and same-tab look
  identical.
- **Different highlight:** e.g. a dashed or differently-colored outline for cross-tab hover
  vs. the solid accent used for same-tab swap.
- **No cross-tab highlight (reject):** don't call `e.preventDefault()` for cross-tab hovers,
  which shows the browser's "no-drop" cursor and makes the distinction obvious without any
  custom UI.

### Q3 — Cross-tab swap: what happens when the two tabs have different layout shapes?

Only relevant if Q1 → option 2 (cross-tab swap) is chosen.

Example: tab 1 has a 2-column split (A | B). Tab 2 has a 3-pane layout (C / D | E, i.e.
a vertical stack on the left and E on the right). Drag A onto E:
- Tab 1's tree gets E in A's slot: now has a 2-column split (E | B). Tab 1 layout shape
  unchanged.
- Tab 2's tree gets A in E's slot: now has (C / D | A). Tab 2 layout shape unchanged.
- Both layouts are valid because a pane leaf is opaque — it can occupy any leaf slot.

This is actually clean: a cross-tab swap is exactly the same algorithm as a same-tab swap,
just run across two separate tab trees instead of one. Confirm whether this is the right
mental model before implementation.

### Q4 — What should happen when tab 1 has only one pane and you drag it to tab 2?

If Q1 → option 1 (transfer) or option 2 (cross-tab swap): tab 1 would end up with zero
panes, which is invalid. Options:
- Block the gesture (no-op, cursor feedback).
- Auto-close tab 1 after the last pane leaves.
- The current `movePaneToTab` path already handles this (it calls `removeTab` if the source
  tab becomes empty) — verify the same logic applies to whichever path is chosen.

### Q5 — What about cross-window cross-tab drops?

The section-header path already handles cross-window drops via `transferPaneToTab` and the
`PANE_DRAG_MIME` payload. Should cross-tab pane-row drops also support cross-window, or is
same-window-only acceptable for now?

---

## Current state summary (before this spec is implemented)

- Cross-tab pane-row drops: visually accept the drag (highlight fires, `preventDefault`
  called) then silently discard on drop. No user feedback.
- Section-header cross-tab drops: work correctly.
- Same-tab pane-row drops: work correctly (spec 021).
- Pane-header right-drag same-tab swap: works correctly (spec 022).

## Implementation — deferred pending Q1–Q5 answers

Once the design questions above are answered, the implementation will likely touch:

- `TabSections.tsx` `PaneRow.onDragOver` — detect cross-tab hover; apply decided affordance.
- `TabSections.tsx` `PaneRow.onDrop` — branch on same-tab vs. cross-tab; call `swapPanes`
  for same-tab, call decided action for cross-tab.
- `panes.ts` — add a cross-tab swap action (if Q1 → option 2) or verify `movePaneToTab`
  suffices (if Q1 → option 1).
- No changes to the pane-header right-drag path or the section-header drop path unless
  explicitly decided.

## Verification steps (to be refined after design is resolved)

1. `npm run typecheck` passes.
2. Same-tab pane-row swap still works (regression guard for spec 021).
3. Right-drag pane-header same-tab swap still works (regression guard for spec 022).
4. Section-header cross-tab transfer still works.
5. Cross-tab pane-row drop behaves per the decided behavior (Q1).
6. Visual affordance is unambiguous and matches the decided behavior (Q2).
7. One-pane tab edge case handled per Q4.
8. No console errors; drag state clears on every exit path.
