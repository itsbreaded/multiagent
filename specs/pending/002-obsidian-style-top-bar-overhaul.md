# Obsidian-Style Top Bar Overhaul

Status: Ready for implementation.

## Problem

The current app top bar feels like an internal toolbar instead of integrated application chrome. The requested direction is closer to Obsidian: a compact dark top band that combines window chrome, workspace controls, tabs, and lightweight global actions into one cohesive strip.

The visual reference shows:

- a full-width top band at the very top of the window
- left-aligned icon buttons for app/workspace navigation
- a tab well with active tab shape, close button, and new-tab affordance
- right-aligned window controls and overflow/actions
- a thin blue/active outline in the reference image, but the app should use the existing MultiAgent accent language unless explicitly changed

The goal is not to copy Obsidian exactly. The goal is to make MultiAgent's chrome feel similarly integrated, compact, and application-native while preserving the existing tab, pane, sidebar, and multi-window behavior.

Final design decisions:

- Windows should move to a frameless window with custom minimize/maximize/close controls.
- The top chrome spans the whole window width, similar to Obsidian and VS Code.
- The sidebar collapse control moves to the top-left of the new top bar.
- Command palette, search/session browser, and settings appear as icon buttons in the top bar.
- The active accent remains MultiAgent green.
- Detached windows use a slimmer tab-only chrome.
- Git branch badges are hidden in top tabs because branch context remains visible in the sidebar.

## Current Behavior

Relevant files:

- `src/main/index.ts`
- `src/main/window/WindowManager.ts`
- `src/shared/types.ts`
- `src/preload/index.ts`
- `src/renderer/src/App.tsx`
- `src/renderer/src/components/TabBar/index.tsx`
- `src/renderer/src/components/Sidebar/index.tsx`
- `src/renderer/src/styles/theme.ts`
- `src/renderer/src/assets/main.css`

Current structure:

1. `BrowserWindow` uses the standard Windows frame on Windows and frameless hidden-inset style only on macOS.
2. `App.tsx` renders a main horizontal row containing `Sidebar` and the content column.
3. The content column renders `TabBar` above `PaneGrid`.
4. The sidebar is outside the tab bar, so the tab bar spans only the pane/content area.
5. `TabBar` is a 36px-high React toolbar with:
   - sidebar toggle
   - local tab strip
   - tab rename
   - tab close
   - tab context menu
   - tab reordering
   - cross-window tab drag/drop
   - tab tear-off
   - pane drop onto tabs
   - git branch badges
   - new tab button
   - session browser, command palette, and settings buttons
6. Detached windows use the same `TabBar` but do not render the primary sidebar.

Important current constraints:

- `TabBar` owns substantial behavior and should not be replaced with a purely visual component.
- Multi-window tab drag/drop and tear-off behavior must continue to work.
- Focus transitions should remain atomic. Do not split user-visible tab activation into separate store updates.
- Renderer styling should start from `src/renderer/src/styles/theme.ts`.
- Non-terminal scroll surfaces should use the shared dark scrollbar approach.

## Intended Behavior

Create a new app chrome layer that visually acts as the window's top bar.

Baseline target:

- One compact top chrome band, approximately 42px high on Windows/Linux and compatible with macOS hidden-inset traffic lights.
- The band spans the full app width in the primary window.
- The left area contains workspace-level icon controls:
  - sidebar collapse/expand toggle at the far top-left
  - session browser/search
  - command palette
  - settings
- The center/remaining area contains the tab strip:
  - active tab styled as a connected dark tab surface
  - inactive tabs visually quieter
  - close button visible on active/hovered tabs
  - plus button adjacent to tabs
  - drag insertion indicators preserved
  - pane-drop and tab-drop affordances preserved
- The right area contains window/app controls:
  - on Windows/Linux, custom minimize, maximize/restore, and close controls
  - on macOS, reserve native traffic-light space and avoid duplicating native controls
  - optional overflow/menu button for future app-level actions
- `PaneGrid` should begin directly under this top chrome.
- The primary sidebar starts below the top chrome so the top bar spans the whole app width.
- Detached windows should use a slimmer tab-only chrome, omitting primary-window-only sidebar/search/command/settings controls unless a future detached-window workflow needs them.

Visual direction:

- Keep the existing dark palette and green `#4ade80` active accent unless the product palette is intentionally changed.
- Use icon buttons rather than text buttons for top chrome actions.
- Use stable fixed dimensions for chrome controls so hover states, badges, and tab labels cannot shift layout.
- Hide git branch badges in top-bar tabs. Branch context remains available in the sidebar.
- Avoid large rounded cards, hero-like styling, gradients, or decorative background effects.
- Keep the design dense, calm, and work-focused.

## Proposed Architecture

Introduce an explicit chrome component rather than continuing to grow `TabBar` as a mixed toolbar.

Suggested component split:

- `src/renderer/src/components/AppChrome/index.tsx`
  - owns the full-width top band layout
  - composes navigation controls, tab strip, global actions, and window controls
- `src/renderer/src/components/AppChrome/ChromeButton.tsx`
  - reusable icon button with tooltip/title and active state
- `src/renderer/src/components/AppChrome/TabStrip.tsx`
  - extracted tab-strip behavior from the current `TabBar`
  - preserves reorder, rename, context menu, drag/drop, tear-off, plus button, badges
- `src/renderer/src/components/AppChrome/WindowControls.tsx`
  - custom controls for frameless Windows/Linux windows
  - hidden or platform-adjusted on macOS

Do not rewrite tab behavior from scratch. Extract and reshape the existing `TabBar` behavior incrementally.

Renderer layout target:

```tsx
<div className="app-root">
  <AppChrome />
  <div className="workspace-row">
    <Sidebar />
    <PaneGrid />
  </div>
  <Overlays />
</div>
```

The actual code can remain inline-styled if the existing app does, but shared values should move into `theme.ts` when they become conventions.

## Electron Chrome Requirements

For a true Obsidian-like Windows top bar, implement frameless windows on Windows/Linux:

- update `BrowserWindow` options in `src/main/index.ts`
- update detached window options in `src/main/window/WindowManager.ts`
- use `frame: false` on Windows/Linux
- consider `titleBarStyle: 'hiddenInset'` on macOS as currently used
- optionally use `titleBarOverlay` only if tested against Electron 39 and it does not conflict with custom React controls

- add IPC invoke channels for:
  - minimize
  - maximize/restore
  - close
  - query maximized state if the icon must reflect current state
- expose typed channels through `src/shared/types.ts` and `src/preload/index.ts`
- mark draggable regions with `app-region: drag`
- mark interactive controls and tabs with `app-region: no-drag`
- preserve tab dragging behavior; tab drag/drop must not be swallowed by window drag regions
- verify resizing, maximizing, snapping, and multi-window movement on Windows

## Interaction Requirements

The overhaul must preserve:

- creating a new tab
- closing tabs with the close button and middle click
- renaming tabs by double-click
- tab context menu actions:
  - rename
  - set/change default directory
  - move tab to new window
  - reattach to main window
  - close tab
  - close other tabs
  - close tabs to the right
  - duplicate tab
- tab reorder within a window
- tab tear-off to a new detached window
- cross-window tab absorption
- pane drop onto a tab
- hover-activation during pane drag
- branch labels in the sidebar; top tabs should not show branch badges
- global actions for session browser, command palette, and settings
- primary-window-only behavior for sidebar and workspace tools
- detached-window content-only behavior

Keyboard behavior should remain unchanged unless explicitly redesigned.

## Implementation Phases

### Phase 1: Design Tokens And Component Shell

1. Add top-chrome color, sizing, and control tokens to `theme.ts`.
2. Create `AppChrome` with the same controls as `TabBar`, but still backed by current behavior.
3. Move the app layout in `App.tsx` so chrome spans the full width.
4. Keep the existing standard window frame only during initial component extraction if useful; the final implementation must move Windows/Linux to frameless chrome.

### Phase 2: Extract Tab Strip Safely

1. Extract tab-strip logic from `TabBar` into `AppChrome/TabStrip`.
2. Keep current data flow and Zustand actions unchanged.
3. Preserve context menu and directory picker behavior.
4. Verify tab reorder, close, rename, and new-tab behavior before changing Electron frame options.

### Phase 3: Obsidian-Like Visual Pass

1. Restyle tab shapes, spacing, separators, active state, close button, and plus button.
2. Move sidebar collapse, search/session browser, command palette, and settings into the top bar.
3. Ensure labels truncate cleanly and hidden branch badges do not leave dead spacing.
4. Make all chrome controls fixed-size and `app-region: no-drag` compatible.

### Phase 4: Frameless Window Controls

1. Add typed IPC channels for window minimize, maximize/restore, close, and maximized-state reporting.
2. Change primary and detached `BrowserWindow` creation to frameless on Windows/Linux.
3. Add custom window controls in `WindowControls`.
4. Add draggable regions to unused chrome space.
5. Verify native OS behaviors: drag, double-click maximize, minimize, restore, close, snap, and resize.

### Phase 5: Multi-Window And Regression Pass

1. Verify primary window and detached windows both render correct chrome.
2. Verify cross-window tab and pane drag/drop with `app-region` in place.
3. Verify snap zones still appear and apply correctly.
4. Verify layout restore and lazy tab hydration are unaffected.
5. Run `npm run typecheck` and `npm run build`.

## Handoff Contract

The implementer should treat this as a chrome/layout refactor with strict behavior preservation.

Non-negotiables:

- Do not remove or regress existing tab lifecycle behavior.
- Do not regress multi-window tab transfer, pane transfer, or tear-off behavior.
- Do not break detached windows.
- Do not use untyped IPC channels.
- Do not introduce app chrome colors ad hoc when they should be shared theme tokens.
- Do not let draggable regions overlap tabs, close buttons, toolbar buttons, menus, inputs, or drag/drop targets.
- Do not make the sidebar or pane grid shift size during tab hover, branch-badge loading, or window-control hover.
- Do not use VS Code-specific visual language unless the whole app is intentionally moved in that direction.

Definition of done:

- The top chrome visually resembles the provided Obsidian-style reference while fitting MultiAgent's existing dark theme.
- The primary top bar spans the full window width.
- Tabs remain fully functional.
- Global controls remain discoverable as icon buttons with titles/tooltips.
- Detached windows have slimmer tab-only chrome and still transfer tabs correctly.
- Window controls and dragging behave correctly on Windows frameless windows.
- TypeScript and production build pass.

## Verification Plan

Automated:

- `npm run typecheck`
- `npm run build`

Manual:

- Start the app with multiple saved tabs.
- Confirm the active tab is visible in the new chrome and restored correctly.
- Create a tab from the chrome plus button.
- Rename a tab.
- Close a tab from the close button and by middle click.
- Open tab context menu and exercise each action.
- Reorder tabs within one window.
- Tear off a tab to a detached window.
- Drag a tab from a detached window back into the primary window.
- Drag a pane onto another tab.
- Confirm hover-activation during pane drag still works.
- Toggle sidebar from the chrome.
- Open session browser, command palette, and settings from the chrome.
- Confirm branch badges are absent from top tabs and branch context remains available in the sidebar.
- On Windows:
  - drag the frameless window by empty chrome space
  - double-click empty chrome to maximize/restore
  - minimize, maximize/restore, and close from custom controls
  - snap the window at screen edges
  - resize from all edges/corners
- Confirm no text/control overlap at narrow widths.

## Risks And Tradeoffs

- `TabBar` is behavior-heavy. A visual rewrite without careful extraction could break tab transfer or pane drop behavior.
- Frameless Windows chrome increases responsibility for native window behaviors.
- `app-region: drag` can conflict with custom drag/drop. This is the highest-risk part of copying Obsidian-like chrome.
- Keeping a standard Windows frame is lower risk but cannot fully match the reference.
- Moving global actions into a compact chrome may reduce discoverability if icons are unclear.
- Putting the sidebar below full-width chrome changes vertical alignment versus the current content-only tab bar.

## Out Of Scope

- Redesigning the sidebar contents.
- Redesigning pane headers.
- Changing keyboard shortcuts.
- Changing layout persistence semantics.
- Replacing the current tab data model.
- Adding a command/menu system beyond existing session browser, command palette, and settings actions.
