# Lazy Tab Hydration Plan

## Problem

Startup currently restores every saved tab into renderer state and mounts every pane grid immediately. Inactive tab grids are hidden with `visibility: hidden`, but they are still mounted. That means restored panes initialize xterm instances, resize observers, terminal handlers, shell PTYs, and agent resumes even when the user never focuses those tabs during the session.

This is risky for layouts with many long-running Claude/Codex chats:

- startup CPU and memory scale with total restored panes, not the initially focused tab
- shell panes can create PTYs before the user needs them
- agent panes can resume sessions before the user needs them
- hidden xterm instances still allocate DOM and scrollback state

The app should restore layout metadata eagerly so the sidebar and tab bar are accurate, but defer terminal/session initialization until a tab is actually focused.

## Current Behavior

Relevant files:

- `src/renderer/src/App.tsx`
- `src/renderer/src/store/panes.ts`
- `src/renderer/src/components/PaneGrid/index.tsx`
- `src/renderer/src/components/PaneGrid/PaneContainer.tsx`
- `src/renderer/src/components/Terminal/index.tsx`

Current startup path:

1. `App.tsx` loads saved layout.
2. `usePanesStore.getState().applyLayout(data)` restores all saved tabs and panes.
3. `applyLayout` loops through all agent leaves and invokes `session:resume` for every restorable agent pane.
4. `PaneGrid` maps over every tab with a `rootNode` and renders all pane trees.
5. Inactive tab grids are hidden, but still mounted.
6. `Terminal` creates/attaches xterm for each mounted pane. Shell panes without `ptyId` create PTYs on mount.

Existing reason for keeping inactive tabs mounted:

- once a terminal has been visited/created, keeping it mounted preserves scrollback and avoids xterm detach/recreate issues

That reason is valid after hydration, but it should not force all restored tabs to hydrate at startup.

## Desired Behavior

At startup:

- restore tab metadata, pane tree metadata, labels, default CWDs, focused pane ids, sidebar state, and active tab id
- hydrate only the active tab
- do not mount pane trees for inactive tabs until first focus
- do not create shell PTYs for inactive tabs until first focus
- do not resume agent sessions for inactive tabs until first focus

After a tab has been focused once:

- keep that tab hydrated and mounted when inactive
- preserve xterm scrollback and live PTY/session state
- do not dehydrate tabs automatically unless a future explicit memory-management feature is designed

For detached windows:

- a newly created detached window should hydrate its initial tab immediately because that window exists to show that tab
- tabs created or absorbed inside a detached window should hydrate when they become active, following the same rule

## Handoff Contract

The implementer should treat this as a startup-performance refactor with strict behavior preservation after first focus.

Non-negotiables:

- The active tab must always be hydrated before it is rendered as active.
- A tab must hydrate at most once per renderer session unless it is closed and recreated.
- After a tab hydrates, keep its pane tree mounted while inactive to preserve xterm scrollback and live PTY/session state.
- Unhydrated tabs must still appear correctly in the tab bar and primary sidebar using saved metadata.
- `applyLayout` must not start every saved agent session.
- Shell PTY creation should remain owned by `Terminal`, and only mounted/hydrated shell panes should create PTYs.
- Hydration must be part of tab activation/focus transitions, not a follow-up effect that can publish an active-but-unmounted tab.
- Do not persist hydration state in the saved layout.

Definition of done:

- With a saved multi-tab layout, startup mounts/initializes only the restored active tab.
- Focusing a previously inactive restored tab hydrates it once and keeps it mounted afterward.
- Restored inactive agent tabs do not call `session:resume` until first focus.
- Restored inactive shell tabs do not call `pty:create` until first focus.
- Existing scrollback preservation still works after a tab has been hydrated.

## Proposed Model

Add a hydration concept to the panes store:

```ts
hydratedTabIds: Record<string, true>
hydrateTab: (tabId: string) => void
isTabHydrated: (tabId: string) => boolean
```

Rules:

- `applyLayout` sets `hydratedTabIds` to include only the restored `activeTabId`.
- `initDetached` hydrates the initial detached tab.
- `addTab`, `newSession`, `addShellPane`, `resumeSessionInNewTab`, and other user-created active tabs should mark the new/active tab hydrated immediately.
- `setActiveTab` / `focusPaneInTab` should hydrate the target tab before or in the same state transition as making it active.
- `receiveTab` should hydrate the received tab if it becomes active in the receiving window.
- Closing/removing a tab should remove its hydration flag.

Use an object map rather than a `Set` so Zustand selectors and persistence/debugging remain simple.

## Rendering Changes

Update `PaneGrid` so it renders:

- the active tab if it has a `rootNode`
- any inactive tab whose id is in `hydratedTabIds`
- no pane tree for inactive unhydrated tabs

Pseudo-shape:

```tsx
{tabs.map((tab) => {
  if (!tab.rootNode) return null
  const isActive = tab.id === activeTabId
  const hydrated = hydratedTabIds[tab.id] === true
  if (!isActive && !hydrated) return null
  ...
})}
```

Important:

- active tab hydration must happen before render or as part of the active-tab transition, so the active pane tree is not missing for a frame
- once a tab renders, existing hidden-but-mounted behavior should continue for that tab

## Agent Resume Changes

Move eager resume out of `applyLayout`.

Instead:

- `applyLayout` should sanitize and restore pane metadata only
- create a helper like `hydrateTabRuntime(tabId)`
- when a tab hydrates, scan only that tab's leaves:
  - agent pane with `sessionId` and no `ptyId`: invoke `session:resume`
  - shell pane with no `ptyId`: let `Terminal` create PTY on mount, as it does today

Avoid duplicate resume calls:

- track pending runtime hydration per pane id, e.g. `hydratingPaneIds: Record<string, true>` or a module-local set
- before invoking `session:resume`, check that the pane still exists, still has the same `sessionId`, and still lacks `ptyId`
- when resume returns, patch only the target pane if it is still valid

Failure behavior:

- if agent resume fails, convert that pane to shell only if the pane is still valid and still represents the same session
- this conversion should happen only for hydrated tabs, not during startup for every saved tab

## Sidebar And Labels

Sidebar and tab labels should continue to work for unhydrated tabs.

Requirements:

- label computation must use saved pane metadata without requiring terminal mount
- CWD shown for unhydrated panes is the saved CWD until the pane hydrates and emits live OSC 7 updates
- branch badges should not trigger expensive refreshes for unhydrated/inactive panes unless currently focused or explicitly visible

## Persistence

Do not persist `hydratedTabIds` as durable layout state. It is a per-process performance detail.

Layout save should continue saving all tabs and pane metadata.

Guard against accidentally saving runtime-only hydration fields if the app later persists the whole store.

## State Transition Requirements

Hydration and focus should be atomic:

- do not call `hydrateTab(tabId)` and then `setActiveTab(tabId)` as separate visible transitions
- `setActiveTab` should include the hydration flag update
- `focusPaneInTab(tabId, paneId)` should include the hydration flag update

This follows the existing multi-window invariant in `CLAUDE.md`: user-level focus transitions should publish one coherent state.

## Implementation Phases

### Phase 1: Store Hydration State

1. Add `hydratedTabIds` to `PanesStore`.
2. Add helper functions:
   - `markTabHydrated(tabId)`
   - `isTabHydrated(tabId)`
   - internal cleanup when tabs close/remove
3. Update tab creation and focus actions to maintain hydration:
   - `initDetached`
   - `receiveTab`
   - `addTab`
   - `setActiveTab`
   - `focusPaneInTab`
   - `returnTab`
   - `movePaneToNewTab`
   - `movePaneToTab`
   - any path that makes a tab active

### Phase 2: PaneGrid Lazy Rendering

1. Read `hydratedTabIds` in `PaneGrid`.
2. Render inactive tab grids only when hydrated.
3. Keep currently active tab rendered even if a bug leaves it unmarked, but also fix the store transition so that should not happen.
4. Verify that switching to an unhydrated tab mounts it once and then keeps it mounted afterward.

### Phase 3: Lazy Agent Runtime Resume

1. Remove the all-leaves resume loop from `applyLayout`.
2. Add `hydrateTabRuntime(tabId)` or equivalent store action.
3. Call runtime hydration when a tab becomes hydrated.
4. Add duplicate-resume protection per pane id/session id.
5. Keep shell PTY creation owned by `Terminal`.

### Phase 4: Edge Cases

Handle:

- tab close before pending resume returns
- pane moved to another tab before pending resume returns
- detached window init/adoption
- tab returned from detached window to primary
- pane transfer into an unhydrated tab
- zoomed pane on a tab that is not hydrated

Expected behavior:

- if a pane moves into the active tab, it hydrates because the active tab is hydrated
- if a pane moves into an inactive unhydrated tab, do not mount/resume it until that tab is focused
- if a pending resume returns after the pane moved, patch by pane id only if the pane still matches the original session

### Phase 5: Cleanup And Documentation

1. Update comments in `PaneGrid` to clarify:
   - unhydrated tabs are not mounted
   - hydrated inactive tabs stay mounted for scrollback
2. Update `CLAUDE.md` startup behavior after implementation:
   - layout metadata restores eagerly
   - terminal/session runtime hydrates on first focus
3. Move this spec to `specs/done/` if it remains useful after implementation; otherwise fold the durable lesson into `CLAUDE.md` and delete it.

## Verification Plan

Manual checks:

- Start with a saved layout containing many tabs; only the active tab should create terminal DOM/xterm instances immediately.
- Confirm inactive restored shell tabs do not create PTYs until focused.
- Confirm inactive restored agent tabs do not call `session:resume` until focused.
- Focus an unhydrated tab; it should mount once, resume/create runtime, and then remain mounted when switching away.
- Switch repeatedly among hydrated tabs; scrollback should persist.
- Create a new tab/session; it should hydrate immediately because it is active.
- Tear off a tab; the detached window's initial tab should hydrate immediately.
- Move a pane into an inactive tab; it should not initialize runtime until the target tab is focused.

Instrumentation ideas:

- temporarily log `Terminal` mount/create events by pane id
- temporarily log `session:resume` and `pty:create` IPC calls
- count `.xterm` DOM nodes after startup with multiple restored tabs

Automated checks:

- `npm run typecheck`
- `npm run build`

If component tests are added later, cover:

- `PaneGrid` does not render inactive unhydrated tabs
- focusing a tab marks it hydrated
- `applyLayout` hydrates only the active tab
- lazy resume skips stale panes when IPC returns late

## Risks And Tradeoffs

- Sidebar data must remain accurate for unhydrated tabs. Avoid coupling labels to mounted terminals.
- Some code may assume every tab pane tree is mounted. Search for direct DOM/xterm assumptions before changing rendering.
- Delaying agent resume means inactive chats are not live until opened. This is intended for startup performance, but it changes background behavior.
- If users expect all restored agents to continue running immediately, consider a future setting:
  - `Resume all tabs on startup`
  - default off for performance

## Out Of Scope

- Automatic dehydration of idle tabs.
- Persisting scrollback for unhydrated tabs.
- Background preloading after startup.
- User-facing settings for hydration policy.
