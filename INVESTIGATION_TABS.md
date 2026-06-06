# Investigation: VS Code Tab Drag, Sash Resizing, and Layout Model

**Goal**: Adapt VS Code's tab drag-and-drop, pane-splitting, and sash-resizing patterns for this Electron app (multiagent). A developer should be able to implement the full feature set from this document alone, with no additional research phase.

---

## Table of Contents

1. [VS Code Source Files — Ownership Map](#1-vs-code-source-files--ownership-map)
2. [VS Code Data Structures — Layout Model](#2-vs-code-data-structures--layout-model)
3. [Tab Drag-and-Drop Lifecycle](#3-tab-drag-and-drop-lifecycle)
4. [Pane-Split Drop Zones (EditorDropTarget)](#4-pane-split-drop-zones-editordropoverlay)
5. [Sash/Divider Resizing](#5-sashdivider-resizing)
6. [Our Binary-Tree Model vs VS Code's Grid Model](#6-our-binary-tree-model-vs-vs-codes-grid-model)
7. [Required Refactoring — Store, Types, Components](#7-required-refactoring--store-types-components)
8. [Implementation Plan](#8-implementation-plan)
9. [Electron / Windows / xterm.js Gotchas](#9-electron--windows--xtermjs-gotchas)

---

## 1. VS Code Source Files — Ownership Map

### Tab Drag-and-Drop (within and between groups)

**`src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts`**
- GitHub: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts
- Class: `MultiEditorTabsControl extends EditorTabsControl`
- Key lines:
  - `onDragStart()` ~L1396–1429: populates `dataTransfer`, sets `effectAllowed = 'copyMove'`, applies drag image
  - `onDragOver()` ~L1445–1453: calls `getTabDragOverLocation()` to determine left/right insertion
  - `getTabDragOverLocation()` ~L1506–1510: compares `clientX` to tab's bounding rect midpoint → `'left'` or `'right'`
  - `onDrop()` ~L1457–1473: computes final `targetEditorIndex`, calls `moveEditor()` / `copyEditor()`
  - `computeDropTarget()` ~L1512–1533: picks left/right neighbor tab elements for the CSS highlight
  - `updateDropTarget()` ~L1489–1505: toggles `'drop-target-left'` / `'drop-target-right'` CSS classes
  - `onDragEnd()` ~L1705: handles window-creation case for detached tabs

**`src/vs/workbench/browser/parts/editor/editorTabsControl.ts`**
- GitHub: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/editor/editorTabsControl.ts
- Class: `EditorTabsControl extends Themable` (base class)
- Key lines:
  - L106–108: Three `LocalSelectionTransfer` singletons for in-process drag payloads:
    - `editorTransfer = LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>()`
    - `groupTransfer = LocalSelectionTransfer.getInstance<DraggedEditorGroupIdentifier>()`
    - `treeItemsTransfer = LocalSelectionTransfer.getInstance<DraggedTreeItemsIdentifier>()`
  - `onGroupDragStart()` L280–310: sets group transfer, fills resource URIs
  - `onGroupDragEnd()` L312–333: clears group transfer, handles window creation
  - `doFillResourceDataTransfers()` L380–387: populates standard `text/uri-list` and custom `CodeDataTransfers.EDITORS`
  - `isNewWindowOperation()` L353–358: modifier-key check for detached window
  - `isMoveOperation()` L360–370: Ctrl (Win/Linux) or Alt (macOS) for copy vs move

### Drop-Zone Splitting (drag tab to edge)

**`src/vs/workbench/browser/parts/editor/editorDropTarget.ts`**
- GitHub: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/editor/editorDropTarget.ts
- Classes:
  - `DropOverlay extends Themable` (L39–540): the visual translucent overlay that shows UP/DOWN/LEFT/RIGHT/CENTER zones
  - `EditorDropTarget extends Themable` (L542–630): top-level coordinator, creates/destroys `DropOverlay` on `dragenter`/`dragleave`
- Key lines:
  - `OVERLAY_ID = 'monaco-workbench-editor-drop-overlay'` L41
  - `positionOverlay()` L394–479: threshold-based zone calculation, **1/3 of each axis** determines splits
  - `doPositionOverlay()` L481–502: applies CSS top/left/width/height to overlay div
  - `handleDrop()` L271–381: routes to `moveGroup()`, `moveEditors()`, or `ResourcesDropHandler`
  - `registerListeners()` L129–226: `DragAndDropObserver` with `onDragOver`, `onDragLeave`, `onDrop`
  - `onDragEnter()` L563–603: counter-based entry/exit tracking; instantiates `DropOverlay`
  - `isCopyOperation()` L383–388: `ctrlKey` (Win/Linux) or `altKey` (macOS)
  - `isToggleSplitOperation()` L390–392: `altKey` (Win/Linux) or `shiftKey` (macOS)
  - `isDragIntoEditorEvent()` L29–31: `e.shiftKey` to drop content _into_ the active editor

### Sash / Divider Primitive

**`src/vs/base/browser/ui/sash/sash.ts`**
- GitHub: https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/sash/sash.ts
- Class: `Sash extends Disposable`
- Key lines:
  - `onPointerStart()` L430–523: captures `startX`/`startY`; emits `ISashEvent` `{startX, currentX, startY, currentY, altKey}` on each `pointermove`
  - `layout()` L560–587: positions sash element using layout provider callbacks
  - Events: `onDidStart`, `onDidChange`, `onDidReset` (double-click), `onDidEnd`, `onDidEnablementChange`
  - `SashState` enum: `Disabled`, `AtMinimum`, `AtMaximum`, `Enabled`
  - Global default sash size: 4 px via `setGlobalSashSize()`
  - Hover delay: 300 ms

### SplitView (1D layout engine used inside each BranchNode)

**`src/vs/base/browser/ui/splitview/splitview.ts`**
- GitHub: https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/splitview/splitview.ts
- Class: `SplitView`
- Key lines:
  - `onSashStart()` L933–1004: calculates snap thresholds and min/max delta bounds
  - `onSashChange()` L1006–1028: calls `resize()`, handles alt-key mirror-resize, then fills empty space
  - `onSashEnd()` L1030–1038: calls `saveProportions()`
  - `resize()` L1047–1127: the core algorithm (see §5)
  - `saveProportions()` L858–862: stores ratios as `viewItem.size / totalContentSize`
  - `layout()` L777–800: reapplies stored proportions × new total size, clamped to min/max

### Grid (2D layout engine)

**`src/vs/base/browser/ui/grid/gridview.ts`**
- GitHub: https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/grid/gridview.ts
- Classes: `GridView`, `BranchNode`, `LeafNode`
- Key: `BranchNode` wraps a `SplitView`; sashes live at `this.splitview.sashes[index]`
- `BranchNode.resizeChild()` L662: delegates to `splitview.resizeView(index, size)`
- `BranchNode.boundarySashes` setter L476–493: propagates to children

**`src/vs/base/browser/ui/grid/grid.ts`**
- GitHub: https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/grid/grid.ts
- Classes: `Grid`, `SerializableGrid`
- `addView(newView, size, referenceView, direction)` L327–368
- `Sizing` namespace L193–199: `Distribute`, `Split`, `Auto`, `Invisible(cachedVisibleSize)`
- `Direction` enum L18–23: `Up, Down, Left, Right`
- Serialization interfaces: `ISerializedLeafNode`, `ISerializedBranchNode`, `ISerializedGrid`

### EditorPart (the top-level orchestrator)

**`src/vs/workbench/browser/parts/editor/editorPart.ts`**
- GitHub: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/editor/editorPart.ts
- Classes: `EditorPart`, `MainEditorPart`
- `addGroup()` L781–822: calls `gridWidget.addView(newGroupView, getSplitSizingStyle(), locationView, direction)`
- `getSplitSizingStyle()` L1009–1016: maps user pref (`'distribute'`→`Sizing.Distribute`, `'split'`→`Sizing.Split`, else `Sizing.Auto`)
- `createEditorDropTarget()` L1081: instantiates `EditorDropTarget` per group container
- `setBoundarySashes()` L1269: propagates outer sashes to grid and centeredLayout

### Drag Payload (in-process transfer)

**`src/vs/workbench/browser/dnd.ts`**
- GitHub: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/dnd.ts
- `DraggedEditorIdentifier` L49–51: wraps `IEditorIdentifier`
- `DraggedEditorGroupIdentifier` L53–55: wraps `GroupIdentifier`

**`src/vs/platform/dnd/browser/dnd.ts`**
- GitHub: https://github.com/microsoft/vscode/blob/main/src/vs/platform/dnd/browser/dnd.ts
- `LocalSelectionTransfer<T>` L491–530: singleton per type, `setData(data, proto)` / `getData(proto)` / `hasData(proto)` / `clearData(proto)` — **works in-process only, not across windows**
- `CodeDataTransfers` L36–42: string keys for the real `dataTransfer` object (`'CodeEditors'`, `'CodeFiles'`, etc.)

---

## 2. VS Code Data Structures — Layout Model

### The Grid is a recursive tree of BranchNodes and LeafNodes

```
ISerializedGrid {
  root: ISerializedNode   // BranchNode or LeafNode
  orientation: Orientation  // HORIZONTAL | VERTICAL
  width: number
  height: number
}

ISerializedBranchNode {
  type: 'branch'
  data: ISerializedNode[]  // ordered children
  size: number             // orthogonal dimension in px
  visible?: boolean
}

ISerializedLeafNode {
  type: 'leaf'
  data: unknown            // serialized IEditorGroupView (editors list, active editor)
  size: number             // orthogonal dimension in px
  visible?: boolean
  maximized?: boolean
}
```

**Key insight**: `size` is always the **orthogonal** (cross-axis) dimension. In a horizontal split (side by side), each child's `size` is its **height**. In a vertical split (top/bottom), each child's `size` is its **width**. The primary (split) axis dimension is determined by the SplitView's layout algorithm from sash positions, not stored directly.

### BranchNode structure (in memory)

```typescript
class BranchNode {
  children: Node[]           // ordered array of BranchNode | LeafNode
  splitview: SplitView       // manages child layout along this orientation
  _size: number              // orthogonal size
  _orthogonalSize: number    // primary (split axis) size
  _boundarySashes: IBoundarySashes
}
```

Sashes between children live at `splitview.sashes[i]` — one sash between each pair of adjacent children. When a BranchNode has N children there are N-1 sashes.

### Comparison with our tree

| VS Code | Ours |
|---------|------|
| `BranchNode` (N children) | `PaneSplit` (exactly 2 children) |
| `ISerializedBranchNode { data: ISerializedNode[] }` | `PaneSplit { first: PaneNode, second: PaneNode }` |
| `size` = orthogonal dimension in px | `ratio: number` (0–1, fraction of parent) |
| `ISerializedLeafNode { data: IEditorGroup }` | `PaneLeaf { paneType, cwd, ptyId, sessionId }` |
| Grid has a root orientation + arbitrary nesting depth | Binary tree with alternating directions implied by nesting |
| Sash positions stored in SplitView proportions array | Ratio stored on PaneSplit node |

### The Sizing strategies (used when adding a group)

- `Sizing.Distribute`: all children get equal space
- `Sizing.Split`: new view steals half of the reference view's current size
- `Sizing.Auto`: new view takes half of reference, but only if reference is larger than its minimum × 2
- `Sizing.Invisible(n)`: keeps the view at zero size (used for hidden panels)

---

## 3. Tab Drag-and-Drop Lifecycle

### Phase 1: dragstart

Triggered on `mousedown` + motion, or HTML5 `dragstart` event on the tab element.

**In VS Code (`MultiEditorTabsControl.onDragStart`, ~L1396):**
1. Determine whether this is a "new window" operation (modifier key check).
2. Collect selected editors (multi-select is supported — Ctrl+click).
3. Set in-process payload: `editorTransfer.setData([new DraggedEditorIdentifier(...)], DraggedEditorIdentifier.prototype)`.
4. Set `dataTransfer.effectAllowed = 'copyMove'`.
5. Call `doFillResourceDataTransfers()` to also place `text/uri-list` in the OS dataTransfer — this enables dragging to Finder/Explorer.
6. Apply drag image: for single tabs in normal mode, use the tab DOM element itself as image; for multi-select, generate a text label with count.

**In our app:** We use the browser's native HTML5 `draggable` + `onDragStart` which sets nothing in `dataTransfer`. To support cross-pane drops we need to track which tab is being dragged in a React ref or a Zustand field. We do not need `LocalSelectionTransfer` (that's for in-process cross-iframe communication which VS Code needs due to its webview architecture — we don't have that complexity).

### Phase 2: dragover within the same tab strip

**In VS Code (`MultiEditorTabsControl.onDragOver`, ~L1445):**
1. `getTabDragOverLocation()`: measure `event.clientX - tabElement.getBoundingClientRect().left`. If `< tabWidth / 2` → `'left'`, else `'right'`.
2. `computeDropTarget()`: identify the left/right neighbor tab elements at the insertion point.
3. `updateDropTarget()`: add CSS class `'drop-target-left'` to left neighbor, `'drop-target-right'` to right neighbor, removing classes from previously highlighted tabs.
4. Auto-open timeout: if `dragover` fires continuously for 1500 ms on a tab without dropping, that tab is activated (`DRAG_OVER_OPEN_TAB_THRESHOLD`).

**In our app:** Our current `TabBar` uses HTML5 `onDragOver` + `setDragOverIndex` which adds a dashed outline. We should upgrade to left/right insertion-point highlighting (border on the correct side of the target tab).

### Phase 3: drop within the same tab strip

**In VS Code (`MultiEditorTabsControl.onDrop`, ~L1457):**
1. Compute `targetEditorIndex` adjusting for sticky tabs.
2. If source is `editorTransfer` (same-app tab) and source group === target group: call `group.moveEditor(editor, group, { index: targetEditorIndex })` — pure reorder.
3. If different groups: call `sourceGroup.moveEditor()` or `copyEditor()` to the target group at `targetEditorIndex`.
4. Clear `editorTransfer`.
5. Fire `updateDropFeedback()` to remove CSS classes.

**In our app:** Our current implementation does a simple array splice. This is correct for same-tab-strip reorder. We need to add the case where a tab from a different (future) pane strip could be dropped.

### Phase 4: dragend / cancel

**In VS Code (`onDragEnd`, ~L1705):**
- Clears `editorTransfer` and `groupTransfer`.
- If dragged to outside the window (no target registered the drop), creates an auxiliary editor part in a new window.

**In our app:** We should always call `dragIndex.current = null` in `onDragEnd` (not just in `onDrop`) so cancelled drags don't leave stale state.

---

## 4. Pane-Split Drop Zones (EditorDropOverlay)

This is the feature we do **not yet have** — the ability to drag a tab to the top/bottom/left/right edge of a pane to create a split.

### How VS Code's DropOverlay works

**Lifecycle:**

1. `EditorDropTarget` registers a `DragAndDropObserver` on the root container at construction time.
2. When `dragenter` fires, a counter (`counter`) is incremented. If counter goes from 0 to 1 (genuine entry, not child re-entry), and the payload is valid (`validateTransfer()`), a `DropOverlay` is created.
3. `DropOverlay.create()` appends a full-size `div` (`position: absolute; pointer-events: none` initially) to the group container.
4. On every `dragover` within the overlay, `positionOverlay(mouseX, mouseY)` is called.

**`positionOverlay()` zone calculation (~L394–479):**

```
splitWidthThreshold  = editorControlWidth  / 3
splitHeightThreshold = editorControlHeight / 3

if (preferSplitVertically) {
  // Wide left/right zones, narrow top/bottom
  LEFT  if mouseX < splitWidthThreshold
  RIGHT if mouseX > splitWidthThreshold * 2
  UP    if (center band) mouseY < editorControlHeight / 2
  DOWN  (center band) else
} else {
  // Tall top/bottom zones, narrow left/right
  UP    if mouseY < splitHeightThreshold
  DOWN  if mouseY > splitHeightThreshold * 2
  LEFT  if (center band) mouseX < editorControlWidth / 2
  RIGHT (center band) else
}
CENTER = none of the above (drop into same group, no split)
```

**`doPositionOverlay()` CSS (~L481–502):**

| Direction | top | left | width | height |
|-----------|-----|------|-------|--------|
| UP        | 0   | 0    | 100%  | 50%    |
| DOWN      | 50% | 0    | 100%  | 50%    |
| LEFT      | 0   | 0    | 50%   | 100%   |
| RIGHT     | 0   | 50%  | 50%   | 100%   |
| CENTER    | 0   | 0    | 100%  | 100%   |

The overlay div has a translucent background color (`EDITOR_DRAG_AND_DROP_BACKGROUND` theme key — typically rgba of the accent color). CENTER also shows a "drop into prompt" text badge.

**`handleDrop()` routing (~L271–381):**

```
if groupTransfer.hasData → moveGroup()/copyGroup() with splitDirection, or mergeGroup() for CENTER
if editorTransfer.hasData → moveEditors()/copyEditors() to existing or split group
if treeItemsTransfer.hasData → openEditors (from sidebar file tree)
else → ResourcesDropHandler (files from OS)
```

Split is performed by calling `editorGroupsService.addGroup(targetGroup, splitDirection)` which triggers `gridWidget.addView()` with `Sizing.Split`.

### What we need to build

An analogous `PaneSplitDropTarget` component that:
- Wraps each `PaneContainer`
- On `dragenter` (when `dragState.isDragging` is truthy), renders a full-size overlay div
- On `dragover`, computes UP/DOWN/LEFT/RIGHT/CENTER based on 1/3 thresholds
- Shows the highlighted half/full overlay
- On `drop`:
  - CENTER: move the dragged pane into this pane's position (tab reorder for future multi-pane-tabs)
  - UP/DOWN/LEFT/RIGHT: call `splitPane(targetPaneId, direction)` and optionally `closePane(sourcePaneId)`

---

## 5. Sash/Divider Resizing

### VS Code's Sash primitive

`Sash` is a thin, invisible (or hover-visible) 4 px div placed between two views. It handles:
- `pointerdown` → capture pointer, emit `onDidStart({startX, startY, currentX, currentY, altKey})`
- `pointermove` → emit `onDidChange` with updated `currentX`/`currentY`
- `pointerup` → emit `onDidEnd`; release pointer capture
- `dblclick` → emit `onDidReset` (snap to equal distribution)

**Critical detail for iframes**: During drag, Sash calls `event.target.setPointerCapture(event.pointerId)` AND disables `pointer-events` on all `iframe` elements. Without this, the iframe (e.g., a webview or our xterm.js terminal) captures mouse events and the drag breaks. This is directly relevant to our xterm.js panes.

### SplitView resize algorithm

The SplitView sits inside each `BranchNode` and owns one axis. When a sash fires `onDidChange`:

**`onSashStart()` (~L933):**
```
snapBefore = views[sashIndex].snap && views[sashIndex].visible
snapAfter  = views[sashIndex+1].snap && views[sashIndex+1].visible
minDelta = sum of (view.size - view.minimumSize) for views above/left
maxDelta = sum of (view.maximumSize - view.size) for views above/left
```

**`resize()` core algorithm (~L1047):**
1. Split views into "up" group (indices 0..sashIndex) and "down" group (sashIndex+1..end).
2. Compute `minDelta` / `maxDelta` by summing min/max slack across both groups.
3. **Snap**: if delta crosses the snap threshold for any view, toggle that view's visibility and recurse.
4. Clamp `delta` to `[minDelta, maxDelta]`.
5. Iterate up-group from bottom to top: subtract from each view's size until delta is consumed; clamp to `[min, max]`.
6. Iterate down-group from top to bottom: add to each view's size; clamp to `[min, max]`.

**Proportional resize (during window resize):**
- `saveProportions()` is called at end of each sash drag: `proportions[i] = viewItems[i].size / contentSize`
- On window resize, `layout(newSize)` applies: `newViewSize = proportions[i] * newSize`, clamped

**Key constraint values (VS Code editors):**
- `minimumWidth = 220 px` (hardcoded in `EditorGroupView`, referenced from `editorPane.minimumWidth`)
- `minimumHeight = ~34 px` (height of the tab bar alone)
- No explicit maximum — the constraint is the container size

### How sash resizing works in our app today

We use `allotment` (npm package, itself based on `react-split-pane`). Allotment implements a very similar SplitView pattern. It:
- Places sash dividers between `<Allotment.Pane>` children
- Emits `onChange(sizes)` where `sizes` is an array of pixel sizes
- We convert to ratio: `ratio = sizes[0] / (sizes[0] + sizes[1])`
- We store `ratio` on the `PaneSplit` node via `updatePaneRatio(splitId, ratio)`

**Allotment iframe problem**: Allotment does NOT disable iframe pointer-events during drag. This means when a user drags the sash and the cursor moves over an xterm.js terminal, the terminal captures mouse events and the drag breaks. This must be fixed.

---

## 6. Our Binary-Tree Model vs VS Code's Grid Model

### Key structural differences

| Aspect | VS Code Grid | Our Binary Tree |
|--------|-------------|-----------------|
| Branch arity | N children per node | Exactly 2 children |
| Orientation storage | Stored per BranchNode | Implied by `PaneSplit.direction` |
| Size storage | Pixel sizes in SplitView proportions | Single `ratio: 0–1` on `PaneSplit` |
| Sash storage | `SplitView.sashes[]` — separate from tree | Inside `<Allotment>` (stateful component) |
| Serialization | `ISerializedGrid` with recursive nodes | `Tab.rootNode` (recursive PaneNode) |
| Group concept | `IEditorGroupView` has tabs + active editor | `PaneLeaf` has exactly one PTY |
| Cross-tab drag | Groups can be moved between split areas | No cross-pane tab bar |
| Multi-view tabs | Each group has a tab strip with N editors | Each tab has one pane tree (no inner tabs) |

### Key equivalences

- Our `PaneSplit` ≈ VS Code's `BranchNode` with exactly 2 children
- Our `PaneLeaf` ≈ VS Code's `LeafNode` wrapping an `IEditorGroupView`
- Our `Tab` ≈ VS Code's `EditorPart` (each tab is an independent layout)
- Our `PaneSplit.ratio` ≈ VS Code's `SplitView.proportions[0]` (when there are 2 children)

### What VS Code can do that we cannot (yet)

1. **Drag a tab to a split zone** — creates a new split from a drag gesture
2. **Sash drag without iframe capture** — we need to disable pointer-events on xterm during sash drag
3. **Move a pane between tabs** — drag a pane out of one tab's layout into another
4. **Resize sash without breaking xterm** — pointer capture + iframe shield

---

## 7. Required Refactoring — Store, Types, Components

### 7a. Types (`src/shared/types.ts`)

No structural changes to `PaneNode` / `PaneSplit` / `PaneLeaf` are needed for a Phase 1 implementation. The binary-tree model is sufficient.

**Add a drag state type** for global drag tracking:

```typescript
// Drag state for pane splitting
export interface PaneDragState {
  isDragging: boolean
  sourceTabId: string | null    // which Tab the drag started in
  sourcePaneId: string | null   // which PaneLeaf is being dragged (future: pane-to-pane)
  sourceTabIndex: number | null // for tab strip reorder
}
```

This does NOT need to go into `AppState` (it's transient UI state). Keep it in a separate React context or a small Zustand slice, or just a React ref in the drag-aware component.

### 7b. Zustand store (`src/renderer/src/store/panes.ts`)

**Add `moveTab(fromIndex, toIndex)`** — already done via direct `setState` in `TabBar`, but should be a named action for clarity.

**Add `movePaneToSplit(paneId, direction)`** — for the future case of dragging a pane to a split zone of another pane. This is:
```typescript
// Pseudo-code:
// 1. Get the source pane leaf
// 2. Remove it from the tree (removeLeaf)
// 3. Find the target pane leaf
// 4. Replace target leaf with a new PaneSplit containing target + source
movePaneToSplit: (sourcePaneId, targetPaneId, direction) => { ... }
```

No new fields needed on the Zustand store for sash resizing — `updatePaneRatio` already handles it.

### 7c. Components

#### `TabBar/index.tsx`

**Fix 1: `onDragEnd` handler** — currently if you start a drag and cancel (press Escape, or drag outside window), `dragIndex.current` is never cleared. Add:
```tsx
onDragEnd={() => { dragIndex.current = null; setDragOverIndex(null) }}
```

**Fix 2: insertion-point indicator** — instead of a dashed outline on the whole tab, show a vertical bar on the left or right edge:
```tsx
// In the tab's style:
borderLeft: dragOverIndex === idx && dragSide === 'left' ? '2px solid #4ade80' : undefined,
borderRight: dragOverIndex === idx && dragSide === 'right' ? '2px solid #4ade80' : undefined,
```
Where `dragSide` is computed in `onDragOver` from `e.clientX` vs. tab midpoint.

**Fix 3: scroll overflow** — the tab strip needs `overflowX: auto` with custom scrollbar, and the active tab should scroll into view on activation.

#### `PaneGrid/index.tsx`

**Fix 1: iframe pointer-events shield during sash drag** — Allotment exposes `ref.current.startDragging()` events. The fix is:
```tsx
// When allotment drag starts:
document.querySelectorAll('.xterm-screen').forEach(el => el.style.pointerEvents = 'none')
// When allotment drag ends:
document.querySelectorAll('.xterm-screen').forEach(el => el.style.pointerEvents = '')
```
Alternatively, add a full-size transparent `div` overlay over the pane grid only during drag (z-index above terminals, below sash handle).

A simpler approach: subscribe to Allotment's drag events. Allotment's `<Allotment>` component fires `onDragStart` and `onDragEnd` props (undocumented but present in source). Use these.

If Allotment does not expose those events, use a MutationObserver or add a `mousedown` handler on the `.allotment-sash` class.

**Fix 2: drop zone overlay** — new `PaneSplitDropTarget` wrapper component (see §8).

#### New component: `PaneSplitDropTarget`

```tsx
// Wraps PaneContainer, shows split zone overlay during drag
function PaneSplitDropTarget({ pane, children }) {
  const [dropZone, setDropZone] = useState<'up'|'down'|'left'|'right'|'center'|null>(null)

  // Only activate when a tab drag is in progress
  const isDragging = useDragState(s => s.isDragging)

  function onDragOver(e) {
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const w3 = rect.width / 3
    const h3 = rect.height / 3
    // same threshold logic as VS Code's positionOverlay()
    let zone: typeof dropZone
    if (x < w3) zone = 'left'
    else if (x > w3 * 2) zone = 'right'
    else if (y < h3) zone = 'up'
    else if (y > h3 * 2) zone = 'down'
    else zone = 'center'
    setDropZone(zone)
  }

  function onDrop(e) {
    e.preventDefault()
    if (!dropZone || dropZone === 'center') { /* move into same position */ }
    else {
      const direction: SplitDirection = (dropZone === 'left' || dropZone === 'right') ? 'vertical' : 'horizontal'
      splitPane(pane.id, direction)
      // then close/move source pane
    }
    setDropZone(null)
  }

  return (
    <div style={{ position: 'relative', ...}} onDragOver={onDragOver} onDrop={onDrop} onDragLeave={() => setDropZone(null)}>
      {children}
      {isDragging && dropZone && (
        <div style={{
          position: 'absolute',
          pointerEvents: 'none',
          backgroundColor: 'rgba(74,222,128,0.15)',
          border: '2px solid #4ade80',
          ...overlayStyle(dropZone),  // computes top/left/width/height per table in §4
        }} />
      )}
    </div>
  )
}
```

---

## 8. Implementation Plan

### Phase 1: Fix existing tab drag (1–2 hours)

1. **`TabBar/index.tsx`**: add `onDragEnd` to clear `dragIndex.current` (prevents ghost drags after cancel)
2. **`TabBar/index.tsx`**: compute `dragSide` in `onDragOver` (compare `e.clientX` to tab midpoint) and render a left/right border instead of a whole-tab dashed outline
3. **`TabBar/index.tsx`**: auto-scroll the active tab into view on `setActiveTab` using `tabRef.scrollIntoView({ block: 'nearest', inline: 'nearest' })`

### Phase 2: Fix sash + xterm pointer capture (2–4 hours)

The fix prevents xterm.js from stealing mouse events during sash resize:

1. Create a `useSashDragShield` hook:
   ```tsx
   // Adds/removes a transparent full-size overlay div during drag
   // overlay sits above xterm (z-index: 1) but below sash (z-index: 2 if needed)
   ```
2. In `PaneGrid/index.tsx`, add `onMouseDown` on the `.allotment-module-sash` class elements. Use event delegation on the grid container:
   ```tsx
   <div
     onMouseDownCapture={(e) => {
       if ((e.target as HTMLElement).classList.contains('sash-horizontal') ||
           (e.target as HTMLElement).classList.contains('sash-vertical')) {
         setIsSashDragging(true)
         const up = () => { setIsSashDragging(false); window.removeEventListener('mouseup', up) }
         window.addEventListener('mouseup', up)
       }
     }}
   >
   ```
3. When `isSashDragging === true`, render `<div style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'all' }} />` over the pane grid. This shields all xterm iframes.
4. Alternatively, add `pointer-events: none` to `.xterm-helper-textarea, .xterm-screen` in CSS when a `data-dragging` attribute is set on the grid container. Less React, same effect.

### Phase 3: Pane-split drop zones (4–8 hours)

1. **Create drag state store** — a small Zustand slice or React context:
   ```tsx
   interface DragState { isDragging: boolean; sourceTabIndex: number | null }
   const useDragState = create<DragState>(...)
   ```
2. **Wire `TabBar` drag events** to update drag state:
   - `onDragStart`: `setDragState({ isDragging: true, sourceTabIndex: idx })`
   - `onDragEnd`/`onDrop`: `setDragState({ isDragging: false, sourceTabIndex: null })`
3. **Build `PaneSplitDropTarget`** component (stub above in §7c) and wrap each `PaneContainer` in `PaneGrid/index.tsx`
4. **Add `movePaneToSplit` to store** (see §7b)
5. **Test drop zones**: UP/DOWN/LEFT/RIGHT must produce correct `PaneSplit.direction`:
   - `up`/`down` drops → `direction: 'horizontal'` (top/bottom split)
   - `left`/`right` drops → `direction: 'vertical'` (left/right split)
6. **Handle CENTER drop** — for now, do nothing (or move to same position if cross-tab drag is implemented later)

### Phase 4: Cross-tab pane drag (4–8 hours, optional)

This requires dragging a **pane** (not just a tab label) between different tabs:

1. Set `dragData = { type: 'pane', paneId, sourceTabId }` in a global ref on pane-header drag start
2. In `PaneSplitDropTarget`, detect when `dragData.type === 'pane'`
3. On drop:
   - Call `movePaneToSplit(sourcePaneId, targetPaneId, direction)`
   - If source tab becomes empty, close it
4. Tab-to-tab: if dropped on the tab bar itself (not a pane), move the pane to that tab as a new split

### Phase 5: Tab strip inside each pane (optional, VS Code style, 8–16 hours)

This is a large refactor: add a tab strip to each `PaneLeaf` so one leaf can hold multiple sessions. This requires:
- Changing `PaneLeaf` to hold `tabs: { id, ptyId, sessionId, cwd, ... }[]` and `activeTabId`
- Rendering a mini `TabBar` inside each `PaneContainer`
- Updating all store methods to work on the nested tab index
- This mirrors VS Code's `IEditorGroupView` (which holds N editors) vs. their `LeafNode`

**Recommendation**: Phases 1–3 first. Phase 5 is a significant architecture change and may not be needed if the outer tab model (one session = one tab) remains the primary UX.

### Edge cases to handle in each phase

**Tab drag (Phase 1)**:
- Single tab (no reorder needed, disable drag or no-op)
- Drag to same position (no-op, don't mutate array)
- Drag outside the window (must clear drag state in `onDragEnd`, not just `onDrop`)
- Very fast drag (dragIndex.current set before drop, onDrop fires before onDragEnd)

**Sash drag (Phase 2)**:
- User drags sash while xterm is focused (xterm captures pointer without the shield)
- Window resize after sash drag (allotment uses `defaultSizes` not `sizes`, so re-rendering resets ratios — we use `onChange` + `ratio` state to persist, but check that `defaultSizes` is not re-applied on re-render)
- Minimum pane size: set `<Allotment.Pane minSize={80}>` to prevent the pane from collapsing to zero
- Zoom mode interacts with sash: when `zoomedPaneId` is set, the Allotment is not rendered so no sash issue

**Drop zones (Phase 3)**:
- Drag from same pane onto itself (no-op)
- Drag from the only tab in the app (cannot create an orphan — either disallow or create new tab first)
- Fast mouse movement crossing zone boundaries (debounce or accept the last zone before drop)
- Drag that starts with `isDragging = false` (stale state from incomplete previous drag) — always reset on `dragstart`

---

## 9. Electron / Windows / xterm.js Gotchas

### Gotcha 1: xterm.js captures pointer events during sash drag

**Problem**: xterm.js renders into a `<canvas>` and attaches its own mouse listeners directly on the DOM. When the mouse moves over the terminal during a sash drag, xterm receives the events instead of the sash handler, breaking the drag.

**VS Code's fix**: Sash.ts L430–523 explicitly calls `document.querySelectorAll('iframe')` and sets `pointer-events: none` during drag. xterm in VS Code runs in a WebWorker/iframe context, so this works. In our app xterm renders directly in the renderer (no iframe), so we need to target the xterm canvas directly.

**Our fix**: Add a `data-sash-dragging` attribute to the grid root div on sash mousedown, remove on mouseup. Add CSS:
```css
[data-sash-dragging] .xterm-screen,
[data-sash-dragging] .xterm canvas {
  pointer-events: none !important;
}
```

### Gotcha 2: Allotment `defaultSizes` vs. controlled `sizes`

**Problem**: Allotment's `<Allotment defaultSizes={...}>` only sets initial sizes. On re-render (e.g., when `activeTabId` changes and the component re-mounts), `defaultSizes` is applied again, resetting to 50/50.

**Current code**: `PaneGrid` uses `defaultSizes={[split.ratio * 100, (1 - split.ratio) * 100]}` and updates `ratio` via `onChange`. This works IF the `Allotment` component is not unmounted and remounted. The `key={split.id}` prop should prevent spurious remounts, but verify with React DevTools.

**Safe approach**: If Allotment supports `sizes` as a controlled prop (check its API), switch to that. Otherwise, store the ratio in a ref and only write to Zustand on `onDragEnd` (not on every `onChange` mouse move) to avoid triggering re-renders that reset sizes.

### Gotcha 3: HTML5 drag API vs. pointer events on Windows

**Problem**: On Windows, the HTML5 drag API (`draggable`, `ondragstart`, `ondrop`) has known issues:
- `ondragover` fires with a 100–200 ms delay on the first event
- The drag cursor image is blurry on high-DPI displays
- `dataTransfer.setDragImage()` does not clip to the element's border-radius

**VS Code's workaround**: Uses custom pointer-event-based drag (`mousedown` → `mousemove` → `mouseup`) for the sash, not the HTML5 drag API. For tab reorder, it uses the HTML5 drag API but sets custom drag images via `setDragImage()` with a canvas-rendered label.

**Our current approach**: HTML5 `draggable`. For tab reorder this is fine (we just need the drop index, no OS interaction). For pane-split drop zones, we can also use HTML5 drag — the overlay just needs to appear on `onDragEnter` of the pane container.

**Recommendation**: Keep HTML5 drag for tab reorder. Use `mousedown`/`mousemove`/`mouseup` (pointer events) for sash resize (or rely on Allotment which already does this correctly). Do NOT use HTML5 drag for sash.

### Gotcha 4: Electron `ELECTRON_RUN_AS_NODE` and ptyWorker

**Problem**: The pty runs in a child process (`ptyWorker.ts`) spawned with `ELECTRON_RUN_AS_NODE=1`. This process has no renderer process. The drag/drop and sash logic is entirely in the renderer, so there is no interaction with ptyWorker. No changes needed to main process for any of Phases 1–3.

### Gotcha 5: Windows PowerShell 5.x and drag cursor

**Problem**: Windows uses the `col-resize` and `row-resize` CSS cursors for sash handles. On Windows 11, these render correctly. On older setups with high contrast mode, they may not render — use `ew-resize` and `ns-resize` as fallbacks.

### Gotcha 6: `process.env` in renderer

**Problem**: A previous bug was fixed (commit `9bfbe2b`) where `process.env` was accessed in the renderer. Do NOT access `process.env` in any new drag/drop components — use `window.homeDir` or constants defined in `preload/index.ts` and exposed via the `window.ipc` bridge.

### Gotcha 7: `allotment` sash class names (VERIFIED)

The exact allotment sash CSS class (from `node_modules/allotment/dist/style.css`) is:

```
.sash-module_sash__K-9lB          ← the sash element itself
.sash-module_vertical__pB-rs      ← vertical (left/right) sash
.sash-module_horizontal__kFbiw    ← horizontal (top/bottom) sash
```

The hash suffix (`K-9lB`, `pB-rs`, etc.) is content-addressable and will change if allotment updates. **Use `[class*="sash-module_sash"]` as the stable selector**, not the full class name.

Allotment does NOT expose `onDragStart`/`onDragEnd` props. Use event delegation on the grid container:

```tsx
<div
  ref={gridRef}
  onMouseDownCapture={(e) => {
    const target = e.target as HTMLElement
    if (target.closest('[class*="sash-module_sash"]')) {
      enableIframeShield()
    }
  }}
>
  ...
</div>
```

The `mouseup` event on `window` removes the shield. The sash container itself has `pointer-events: none`; only the individual sash children have `pointer-events: auto` — so `e.target` will always be the sash element directly, not the container.

### Gotcha 8: Tab drag on Electron's `frameless` window with `-webkit-app-region: drag` (VERIFIED — NOT AN ISSUE)

`TitleBar.tsx` has `WebkitAppRegion: 'drag'`, but `TabBar` is a **separate sibling component** in the layout — it does not inherit this property. The tab elements in `TabBar/index.tsx` have no `WebkitAppRegion` set at all, so HTML5 drag events on tabs will not conflict with Electron's window drag. No fix needed.

### Gotcha 9: `chokidar` (ESM-only) and renderer drag state

**Unrelated but worth noting**: Chokidar v5 in `SessionSpawner` uses dynamic `import()`. No interaction with drag/drop. No changes needed.

### Gotcha 10: Layout persistence with drag-created splits

When a new split is created via drag-and-drop, the new `PaneSplit` node is added to the tree with `ratio: 0.5`. The layout is persisted via `layout:save` IPC. On restore (`applyLayout`), the ratio will be restored and the Allotment will initialize with `defaultSizes` based on it. This round-trip should work correctly as long as:
- The `PaneSplit.id` is stable (it is — `uuid()` is called once at creation)
- The `Allotment key={split.id}` prop prevents remount on unrelated state changes

---

## Summary of Key GitHub URLs

| File | URL |
|------|-----|
| multiEditorTabsControl.ts | https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts |
| editorTabsControl.ts | https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/editor/editorTabsControl.ts |
| editorDropTarget.ts | https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/editor/editorDropTarget.ts |
| editorGroupView.ts | https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/editor/editorGroupView.ts |
| editorPart.ts | https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/editor/editorPart.ts |
| sash.ts | https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/sash/sash.ts |
| splitview.ts | https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/splitview/splitview.ts |
| grid.ts | https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/grid/grid.ts |
| gridview.ts | https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/grid/gridview.ts |
| dnd.ts (workbench) | https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/dnd.ts |
| dnd.ts (platform) | https://github.com/microsoft/vscode/blob/main/src/vs/platform/dnd/browser/dnd.ts |
