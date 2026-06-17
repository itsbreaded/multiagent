# 004 — Tab Overflow Modes

## Problem

The tab bar silently overflows when many tabs are open. `overflowX: 'auto'` is already applied and the scrollbar is CSS-hidden, so tabs scroll horizontally but there is no visual affordance and no way for users to switch to a multi-row layout. Users from other applications expect to choose between scrollable single-row tabs and expanding multi-row tabs.

## Current Behavior

- Tab strip height is fixed at 42px (34px detached). Individual tabs are 28px tall, centered in the 42px container.
- `overflowX: 'auto'` + `scrollbar-width: none` means tabs scroll silently with no affordance.
- `scrollIntoView` keeps the active tab visible on tab switch.
- Tabs do not wrap; multi-row layout is impossible today.
- The tab strip root container has `overflow: 'hidden'` and a hard-coded `height`, which clips anything that would overflow vertically.
- Sibling chrome elements (left cluster, drag spacer, `<WindowControls>`) all use `height: '100%'`.

## Intended Behavior

A new setting `tabOverflowMode: 'scroll' | 'wrap'` controls how the tab bar handles overflow:

### Mode A — Scroll (default)
Single-row tab bar. Tabs scroll horizontally when they exceed the available width.
- Tab strip root container keeps its fixed height (42px / 34px).
- Add left/right arrow buttons that appear only when there is off-screen tab content on the respective side. Buttons are styled using the existing `BarButton` component and `theme.ts` tokens — do not hand-roll new button styles. Buttons are absolutely positioned at the left and right edges of a new relative-positioned wrapper (see Phase 2). The `+` new-tab button lives outside the scroll region so it is never occluded.
- Arrows include a gradient fade (e.g. `box-shadow` or a sibling `::after` pseudo-element) so truncated tab content is visible beneath them.
- On click, `strip.scrollBy({ left: ±strip.clientWidth * 0.8, behavior: 'smooth' })`.
- `scrollIntoView` on active tab change is kept as-is (arrows and `scrollIntoView` serve different user gestures and do not conflict in practice; arrow clicks use `'smooth'` consistently).
- The hidden scrollbar CSS remains (no native scrollbar visible).

### Mode B — Wrap (grow to new row)
Tab strip grows vertically to accommodate all tabs. No horizontal scroll.
- **Root container**: `height: 'auto'`, `minHeight: isDetachedWindow ? ui.chrome.detachedHeight : ui.chrome.height`, `overflow: 'visible'`, `alignItems: 'flex-start'`.
- **Sibling chrome elements** (left cluster, drag spacer, `<WindowControls>`): set `alignSelf: 'flex-start'` and explicit `height` equal to the per-row height constant so they pin to the first row and do not stretch to the full multi-row height.
- **Tab strip**: `flexWrap: 'wrap'`, `height: 'auto'`, `overflowX: 'visible'`, `overflowY: 'visible'`. Remove the fixed `height` style.
- **Row height**: Each row is produced by giving every tab element a fixed `height` of 28px plus vertical padding totaling the per-row height (42px / 34px). The container's natural height becomes `n-rows × per-row-height`. Do not rely on `alignItems: 'center'` on the container to center tabs in the row — individual tab items carry their own alignment.
- No cap on number of rows — the strip expands as far as needed. Degenerate case (30+ tabs filling most of the window) is a known non-goal for this spec; a row cap or max-height can be added later.
- `overflowX: 'visible'`; no scroll. `scrollIntoView` is not needed; all tabs are visible.
- **Window drag region**: In wrap mode the tab bar rows are not draggable (tabs carry `appRegion: 'no-drag'` and the strip background has no explicit drag region). This means the frameless window cannot be dragged from the tab bar area in wrap mode. This is an accepted limitation for the initial implementation; document it in the UI as-is and revisit if users report friction.
- **Bottom border**: The `border-bottom` is applied on the root container, not on individual rows, so it always renders at the bottom of the last row regardless of how many rows exist.
- The content area below uses `flex: 1` and will correctly fill remaining space as the tab bar grows.

## Setting Persistence

Add `tabOverflowMode: 'scroll' | 'wrap'` to `src/renderer/src/store/settings.ts`:

1. **`Persisted` type**: add `tabOverflowMode: 'scroll' | 'wrap'`.
2. **`initialSettings`**: `tabOverflowMode: 'scroll'`.
3. **`loadSettings`**: add a whitelist guard — `parsed.tabOverflowMode === 'wrap' ? 'wrap' : 'scroll'` — matching the existing defensive validation style for other fields.
4. **All 6 `saveSettings` call sites** (lines 64, 71, 79, 86, 92, 102 as of writing): each spreads the full settings object, so adding the field to `Persisted` and `initialSettings` covers them automatically — verify no call site constructs a partial object.
5. Add a `setTabOverflowMode(mode: 'scroll' | 'wrap')` action following the existing setter pattern.

No IPC sync needed — this is renderer-only state.

## Settings UI

Add a row in **Settings → Appearance** section (`src/renderer/src/components/SettingsPanel/index.tsx`), below the Git branch badges row:

- **Label**: "Tab overflow"
- **Description**: "Scroll keeps tabs in a single row; Wrap grows to additional rows."
- **Control**: Two-button segmented control — `[Scroll]` / `[Wrap]` — reusing the `BarButton` component or an equivalent inline pattern already present in the panel. Do not introduce new hex values; use `theme.ts` tokens.
- **Search match string**: add `'tab overflow scroll wrap rows'` so the setting appears in search results.
- **Section badge count**: bump Appearance `count` from `1` to `2`.
- **Empty-state logic**: the "No settings match" check for the Appearance section must only hide the section when *both* the branch row and the overflow row are filtered out, not just one.

## Implementation

### Phase 0 — Root container audit
Before any visible changes: read `TabBar/index.tsx` and identify every element that uses `height: '100%'` or derives height from the root container. Catalog them. This informs Phase 3.

### Phase 1 — Setting plumbing
1. Add `tabOverflowMode` to `Persisted`, `initialSettings`, `loadSettings` (with whitelist guard), and add `setTabOverflowMode` action in `settings.ts`.
2. Add the segmented control row in `SettingsPanel/index.tsx` Appearance section, including search string and count bump.

### Phase 2 — Scroll mode arrow buttons
1. Wrap the existing `.tab-strip` div in a new `position: 'relative'` container div inside `TabBar/index.tsx`. This wrapper takes the height and flex properties previously on the strip; the strip itself becomes `flex: 1` inside the wrapper.
2. Move the `+` new-tab button outside the scroll region (after the wrapper, not inside the strip) so it is never occluded by an arrow.
3. Attach a `scroll` listener and a `ResizeObserver` to the strip element. Also recompute in a `useEffect` keyed on `[tabs.length, sidebarOpen, tabOverflowMode]` (tab additions/closures and sidebar toggles change available width without triggering a scroll event).
4. Derive `canScrollLeft` (`strip.scrollLeft > 0`) and `canScrollRight` (`strip.scrollLeft < strip.scrollWidth - strip.clientWidth - 1`). Use a 1px tolerance to avoid float precision false positives.
5. Render `<BarButton>` arrow elements (left `‹`, right `›`) absolutely positioned at the strip edges, visible only when the respective boolean is true and `tabOverflowMode === 'scroll'`.
6. Apply a gradient fade behind each arrow so truncated tabs are visually indicated.

### Phase 3 — Wrap mode layout
1. Branch the root container and strip inline styles on `tabOverflowMode`:
   - **`'scroll'`**: existing styles unchanged.
   - **`'wrap'`**: root → `height: 'auto'`, `minHeight`, `overflow: 'visible'`, `alignItems: 'flex-start'`; strip → `flexWrap: 'wrap'`, `height: 'auto'`, `overflowX: 'visible'`.
2. Set `alignSelf: 'flex-start'` + fixed per-row height on all sibling chrome elements that currently use `height: '100%'` (catalogued in Phase 0).
3. Ensure tab elements carry sufficient vertical padding to produce the full per-row height (42px / 34px) naturally, so rows size themselves without relying on the container's `alignItems`.
4. Apply `border-bottom` on the root container.
5. Verify the content area still fills remaining space via `flex: 1`.

## Known Limitations

- **Window drag in wrap mode**: The frameless window cannot be dragged from the tab bar area when more than one row is occupied. Workaround: drag from the sidebar or any other drag-region surface.
- **Drag-drop drop indicator at row boundaries**: The insertion indicator renders as left/right tab borders using horizontal midpoint math only. In wrap mode, drops at the end of one row vs. start of the next are ambiguous visually. The index-based reorder logic is unchanged; the visual may look odd across row boundaries. Accepted limitation for initial implementation.
- **Arrow buttons are pointer-only**: No keyboard affordance beyond the existing tab-switch hotkeys (which already call `scrollIntoView`). No a11y regression — the scrolling mechanism was previously invisible.
- **Degenerate wrap**: No row cap. With 30+ tabs the bar could consume most of the window height. Row-cap with inner scroll is a follow-up, not in scope here.

## Verification

- Open 20+ tabs in scroll mode:
  - Left/right arrows appear when content is off-screen; disappear at the extremes.
  - Active tab scrolls into view on tab switch.
  - Toggling sidebar updates arrow visibility correctly.
  - Closing/adding tabs updates arrow visibility correctly.
  - `+` button is never occluded by an arrow.
- Open 20+ tabs in wrap mode:
  - Strip grows vertically; no horizontal scrollbar; all tabs visible.
  - Sibling chrome elements (window controls, left cluster) remain pinned to the first row.
  - Bottom border appears at the bottom of the last row.
  - Content area fills remaining vertical space.
  - Detached window uses 34px row height.
- Toggle between modes in Settings: tab bar updates immediately, no reload.
- Settings value survives app restart.
- Drag-and-drop tab reorder works in both modes; in wrap mode, test dragging across row boundaries.
- Cross-window tab drop onto a multi-row strip lands at the correct index.
- Renaming a tab to a long name updates arrow visibility in scroll mode.
