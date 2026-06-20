# 016 — Unified Spawn-Choice Menu (sidebar + pane header)

## Problem

There are two separate, duplicated UIs for starting a Claude/Codex/Shell pane,
both reimplementing the same "agent/shell × current-dir/choose-dir" choice menu:

1. **Sidebar** — two global split-buttons ("Session" and "Shell") at the top of
   the action row. They always target the **active tab** and carry "remember
   last choice" state (`lastAgentKind`, `lastShellSpawnMode`) so the main-action
   button can replay the previous choice.
2. **Pane header** — two buttons (split-vertical / split-horizontal), each
   opening its own direction-fixed `SplitDirMenu`.

This is awkward:

- Sidebar spawning is divorced from the project you're aiming at — you must
  first activate the right tab, then press the global button.
- The remembered-mode logic (`lastShellSpawnMode` + the persisted `lastAgentKind`
  icon on the Session button) adds state and branches for a feature the dropdown
  already covers.
- The agent-launch IPC is duplicated between `newSession` and `splitPane`.
- The pane header needs **two** buttons (one per direction) to reach a choice
  menu that could instead show direction inline; `SplitDirMenu` is a second copy
  of the same choice list the sidebar menu renders.

Each tab section in the sidebar (rendered by `TabSections.tsx`) is effectively a
**project** — it has its own `defaultCwd` and a pane tree. The natural place to
start a Claude/Codex/Shell pane "in this project" is on the project itself. And
both the project button and the pane header should open the **same** two-column
(vertical / horizontal) choice menu — one entry button, one shared component.

## Current Behavior

- `src/renderer/src/components/Sidebar/index.tsx`
  - Top `actionRow` renders two `SplitSpawnButton`s (Session, Shell) + a New-tab
    button.
  - `SplitSpawnButton` (main action + dropdown caret) and `SpawnMenuPopover`
    (the "Current Directory / Choose Directory" menu) live in this file.
  - `spawn()` dispatches to `newSession(cwd, dir, agentKind)` / `addShellPane(cwd, dir)`.
  - `spawnShellFromSavedMode()` reads `lastShellSpawnMode` to decide whether to
    open the `DirPicker` or spawn immediately.
- `src/renderer/src/store/panes.ts`
  - State: `lastAgentKind`, `lastShellSpawnMode`; setters `setLastAgentKind`,
    `setLastShellSpawnMode`; helpers `initialLastAgent`, `rememberAgent`,
    `initialLastShellSpawnMode`, `rememberShellSpawnMode`; type `ShellSpawnMode`.
  - `newSession`, `addShellPane`, `splitPane` each mutate **only the active tab**.
  - `newSession` and `splitPane` both contain the `session:new` IPC + result/patch
    + error handling (duplicated).
  - `lastAgentKind` is used (a) as the Session-button icon, (b) as the final
    fallback agent kind in `newSession`/`splitPane`, and (c) is re-remembered by
    the resume actions (lines ~1261/1303/1336/1372) and layout restore (~1861).
- `src/renderer/src/components/PaneHeader/index.tsx`
  - The pane split UI is the reference: two header buttons (split-right /
    split-down) each open `SplitDirMenu`, which lists `SplitSpawnChoice` rows
    (Claude Code / Codex CLI / Shell) under "Current Directory" and "Choose
    Directory" sections. Helpers: `splitChoiceLabel`, `splitChoiceKey`, type
    `SplitSpawnChoice`.

## Intended Behavior

Replace the two global spawn buttons with a per-project spawn control.

1. **Top action row** keeps only the **New-tab** button (creating a project is a
   global action). Remove both `SplitSpawnButton`s.

2. **Each local tab section** (project) gets a `[+]` button in its
   `SidebarSection` header (always visible; the existing three-dot/close stay on
   hover). Clicking `[+]` opens a popover menu anchored to the click, structured:

   ```
   In project directory
     Claude   [⊟ split-vertical] [⊞ split-horizontal]
     Codex    [⊟]                [⊞]
     Shell    [⊟]                [⊞]
   Choose directory
     Claude   [⊟] [⊞]
     Codex    [⊟] [⊞]
     Shell    [⊟] [⊞]
   ```

   - The split-vertical control uses `assets/splitright.png`; split-horizontal
     uses `assets/splitdown.png` (same icons PaneHeader uses).
   - **In project directory** spawns immediately in the project's cwd.
   - **Choose directory** opens the `DirPicker` first, then spawns in the chosen
     dir with the clicked direction.

3. **Spawn target & splitting.** Spawning from a project's `[+]`:
   - Activates that tab and splits its **focused pane** in the chosen direction.
   - If the tab has no focused pane (or the id is stale), split the **last leaf**
     in the tab.
   - If the tab has no `rootNode` (empty project), the new pane becomes the root.

4. **Project cwd resolution** for "In project directory":
   `tab.defaultCwd ?? focusedPaneCwd ?? lastPaneCwd ?? DEFAULT_CWD`.

5. **Remove "remember last choice".** The dropdown always specifies the exact
   agent/shell + directory + split direction, so:
   - Delete `lastShellSpawnMode` entirely (state, setter, helpers, localStorage
     key `multiagent:lastShellSpawnMode`).
   - Delete `lastAgentKind` state, its setter, persistence helpers
     (`initialLastAgent`/`rememberAgent`, key `multiagent:lastAgent`), and all
     `setLastAgentKind` calls in the resume/layout paths. Replace its use as a
     fallback default with the constant `'claude'` (a non-persisted
     `DEFAULT_AGENT_KIND`).

6. **Detached tab sections** (owned by another window) do **not** get a working
   `[+]` in this iteration — cross-window spawn is out of scope. Hide the `[+]`
   for `tab.detached === true` sections. (Documented non-goal; see Risks.)

7. **Pane header uses the same menu.** Replace the pane header's two split
   buttons (split-vertical / split-horizontal) and their direction-fixed
   `SplitDirMenu` with a **single** button using `assets/newwindow.png`. Clicking
   it opens the same two-column V/H `SpawnChoiceMenu` described above, anchored to
   the button. Each row's `[⊟]`/`[⊞]` splits the **current pane** vertically /
   horizontally; "Choose directory" rows open the `DirPicker` first. This drops
   the header from two split buttons to one and unifies both UIs on one component.

8. **One shared menu component.** The sidebar `[+]` and the pane header button
   render the exact same `SpawnChoiceMenu` (Phase 2). The `splitright.png` /
   `splitdown.png` assets are **kept** but repurposed: they are no longer pane
   header buttons — they become the per-row V (`splitright.png`) and H
   (`splitdown.png`) glyphs **inside** the shared menu. The old `SplitDirMenu`
   and the two header split buttons are removed.

## Implementation Phases

### Phase 1 — Store: unify spawn + add `spawnInTab`

In `src/renderer/src/store/panes.ts`:

1. Extract a private core helper used by all spawn paths, e.g.
   `async function spawnPaneCore(get, set, args)` where
   `args = { tabId: string; basePaneId: string | null; paneType: PaneType; agentKind?: AgentKind; cwd: string; direction: SplitDirection }`.
   - Build the leaf (`markSessionDetectionPending(makeLeaf(...))` for agents).
   - Insert into the tree **of `tabId`** (not `activeTabId`): if `basePaneId`
     resolves to a leaf in that tab, replace it with `makeSplit(direction, leaf, newLeaf)`;
     else if the tab has no `rootNode`, set the leaf as root; else split the last leaf.
   - Set `activeTabId = tabId`, the tab's `focusedPaneId = newLeaf.id`, mark the
     tab hydrated, ensure its sidebar section is open (mirror `newSession`).
   - Call `focusTerminalWhenMounted(newLeaf.id)`.
   - For agent panes, run the single shared `session:new` IPC + patch + error
     handling block (the logic currently duplicated in `newSession`/`splitPane`).
2. Reimplement existing actions as thin wrappers over the core (no behavior
   change for current callers):
   - `splitPane(paneId, dir, type, cwd, agentKind)` → resolve the tab that
     contains `paneId` (use `findPaneInAnyTab`/existing lookup), then
     `spawnPaneCore({ tabId, basePaneId: paneId, paneType: type ?? existing.paneType ?? 'shell', agentKind: agentKind ?? existing.agentKind ?? DEFAULT_AGENT_KIND (agent only), cwd: cwd ?? existing.cwd ?? tab.defaultCwd ?? 'C:\\', direction })`.
   - `newSession(cwd, dir, agentKind)` → `spawnPaneCore({ tabId: activeTabId, basePaneId: focusedPaneId, paneType: 'agent', agentKind: agentKind ?? DEFAULT_AGENT_KIND, cwd, direction })` (preserve the `tabs.length === 0` → create-first-tab branch).
   - `addShellPane(cwd, dir)` → same with `paneType: 'shell'`.
3. Add the public action
   `spawnInTab: (tabId: string, opts: { paneType: PaneType; agentKind?: AgentKind; cwd: string; direction: SplitDirection }) => Promise<void>`
   → resolves base pane as `tab.focusedPaneId` (if it points to a live leaf) else
   last leaf else `null`, then calls `spawnPaneCore`.
4. Remove `lastAgentKind` / `lastShellSpawnMode` state, setters, helpers, and
   types; add `const DEFAULT_AGENT_KIND: AgentKind = 'claude'`. Delete the
   `setLastAgentKind` calls in resume/layout paths. Update the store interface.

### Phase 2 — Shared `SpawnChoiceMenu` component

Create `src/renderer/src/components/SpawnChoiceMenu.tsx`. This is the single
two-column menu used by both the sidebar `[+]` and the pane header button.

- Export `type SpawnChoice = { paneType: PaneType; agentKind?: AgentKind }`
  (rename of `SplitSpawnChoice`), `SPAWN_CHOICES`
  `[{agent claude},{agent codex},{shell}]`, and `spawnChoiceLabel` /
  `spawnChoiceKey` (moved out of PaneHeader).
- Export the component:

  ```ts
  interface SpawnChoiceMenuProps {
    x: number
    y: number
    currentDirLabel: string   // e.g. "In project directory" | "In current directory"
    onClose: () => void
    onSpawn: (choice: SpawnChoice, direction: SplitDirection) => void   // current dir
    onBrowse: (choice: SpawnChoice, direction: SplitDirection) => void  // choose dir
  }
  ```

- Internals: the backdrop + viewport-clamping `useLayoutEffect` pattern lifted
  from `SpawnMenuPopover`/`SplitDirMenu`; `menuStyles` tokens only. Two labeled
  sections (`currentDirLabel`, then "Choose directory"). Each section maps
  `SPAWN_CHOICES` to a row: leading agent/shell icon + `spawnChoiceLabel`, then
  two trailing icon-buttons — V = `splitright.png` (title "Split vertical"),
  H = `splitdown.png` (title "Split horizontal"). V/H call
  `onSpawn(choice,'vertical'|'horizontal')` (current section) or
  `onBrowse(...)` (choose section).

### Phase 3 — Sidebar UI

In `src/renderer/src/components/Sidebar/index.tsx`:

- Delete `SplitSpawnButton`, `SpawnMenuPopover`, `MenuLabel` (if now unused
  here), the `SpawnMenu`/`DirPickerPending` plumbing for the global buttons,
  `spawnShellFromSavedMode`, and the `lastAgentKind`/`lastShellSpawnMode`
  selectors. Keep the New-tab button.
- The action row becomes just the New-tab button (full width or left-aligned).

In `src/renderer/src/components/Sidebar/TabSections.tsx`:

- Add a `ProjectSpawnButton` (the `[+]`) into each **local** tab section's
  `headerActions`, before/with `SidebarHoverActions`. Always visible.
- On click, open `SpawnChoiceMenu` with `currentDirLabel="In project directory"`:
  - `onSpawn(choice, direction)` → `spawnInTab(tab.id, { ...choice, cwd: projectCwd(tab), direction })`.
  - `onBrowse(choice, direction)` → open `DirPicker` (title
    ``Start ${spawnChoiceLabel(choice)} in…``); on confirm
    `spawnInTab(tab.id, { ...choice, cwd: dir, direction })`.
- `projectCwd(tab)` = `tab.defaultCwd ?? <focused/last pane cwd> ?? DEFAULT_CWD`.
- Detached sections: omit the `[+]`.

### Phase 4 — Pane header migration

In `src/renderer/src/components/PaneHeader/index.tsx`:

- Remove the two split `HeaderButton`s (split-vertical / split-horizontal), the
  `splitMenu` direction-fixed state, the local `SplitDirMenu` and `MenuLabel`
  functions, and the `splitChoiceLabel`/`splitChoiceKey`/`SplitSpawnChoice`
  local copies (now imported from `SpawnChoiceMenu`).
- Add one `HeaderButton` using `assets/newwindow.png` (title e.g. "Split pane /
  new session"), guarded by `!isZoomed` like the old buttons. On click open
  `SpawnChoiceMenu` with `currentDirLabel="In current directory"`:
  - `onSpawn(choice, direction)` → `splitPane(pane.id, direction, choice.paneType, pane.cwd, choice.agentKind)`.
  - `onBrowse(choice, direction)` → set `dirPickerForSplit = { direction, choice }`
    (keep the existing DirPicker block; it already splits on confirm).
- Drop the `splitRightIcon`/`splitDownIcon` imports from PaneHeader (they now
  live in `SpawnChoiceMenu`). Keep the `HOTKEYS.splitVertical/Horizontal`
  keyboard paths in `Terminal/index.tsx` and `usePanes.ts` unchanged.

### Phase 5 — Cleanup & verification

- Remove now-dead imports/asset references (`arrowDropdownIcon` if unused).
  `splitright.png` / `splitdown.png` are retained (used by `SpawnChoiceMenu`).
- `npm run typecheck` clean.
- Grep that `lastAgentKind`, `lastShellSpawnMode`, `ShellSpawnMode`,
  `SplitSpawnButton`, `SpawnMenuPopover`, `SplitDirMenu`, `SplitSpawnChoice`,
  `multiagent:lastAgent`, `multiagent:lastShellSpawnMode` have no remaining
  references.

## Risks

- **Spawn target tab vs. active tab.** Existing `splitPane`/`newSession`/
  `addShellPane` assume the active tab; the refactor must keep the
  `tabs.length === 0` first-tab creation branch and keep active-tab callers
  (hotkeys in `Terminal/index.tsx`, `usePanes.ts`, `PaneGrid`, `CommandPalette`)
  behaving identically. Verify split hotkeys still duplicate the focused pane's
  type.
- **Fallback agent kind.** Some callers (`splitPane` hotkeys) pass no
  `agentKind`; ensure `existing.agentKind ?? DEFAULT_AGENT_KIND` preserves "split
  keeps the same agent" and never silently switches Codex→Claude.
- **Activating a non-active project on spawn.** `spawnInTab` changes
  `activeTabId`; ensure this respects the focus invariants in CLAUDE.md (atomic
  focus transition, hydrate the tab, broadcast for detached windows is N/A here
  since only local tabs get the button).
- **Detached projects show no `[+]`.** Visible inconsistency vs. local projects;
  acceptable for v1 (the old global buttons also never spawned into detached
  tabs). If we later want it, route through `pane:transfer`-style cross-window IPC.
- **localStorage keys** `multiagent:lastAgent` / `multiagent:lastShellSpawnMode`
  become orphaned in users' storage — harmless; no migration needed.
- **Pane header menu anchoring.** The header button sits at the right edge of a
  narrow pane; the shared menu must keep the existing viewport-clamping so it
  never overflows off-screen (same `useLayoutEffect` math the old `SplitDirMenu`
  used). Verify in a thin right-most pane.
- **Single shared menu, two contexts.** `SpawnChoiceMenu` is driven only by props
  (`currentDirLabel`, `onSpawn`, `onBrowse`); it must not reach into store/tab
  state directly, so both the sidebar and the header can reuse it cleanly.

## Verification Steps

1. `npm run typecheck` passes; `npm run dev` launches.
2. Top action row shows only the New-tab button.
3. Each local project section shows a `[+]`; clicking opens the two-section menu
   with V/H controls on every row.
4. "In project directory" → Claude/Codex/Shell each spawn in the project's cwd;
   `[⊟]` splits vertically, `[⊞]` splits horizontally, of the project's focused
   pane. Spawning into a non-active project activates it and focuses the new pane.
5. With a project that has no focused pane (e.g. freshly hydrated), spawn splits
   the last pane; with an empty project the pane becomes the root.
6. "Choose directory" opens the DirPicker, then spawns in the chosen dir with the
   clicked direction.
7. The pane header shows a **single** `newwindow.png` button (no more two split
   buttons). Clicking it opens the same two-column menu; V/H rows split the
   current pane in the right direction; "Choose directory" routes through the
   DirPicker. Menu stays on-screen for the right-most/narrowest pane.
8. Split hotkeys (`HOTKEYS.splitVertical/Horizontal`) still split the focused
   pane and keep the source pane's agent kind.
9. New Claude/Codex/Shell from the Command Palette and the empty-pane grid still
   work.
10. Detached project sections show no `[+]`.

## Handoff Contract

**Non-negotiables**
- Do **not** reintroduce any persisted "last choice" state; the dropdown is the
  single source of the spawn choice.
- Keep one shared `session:new` IPC/error path; do not re-duplicate it across
  spawn actions.
- Exactly **one** spawn-choice menu component (`SpawnChoiceMenu`) backs both the
  sidebar `[+]` and the pane header button. Do not leave a second copy
  (`SplitDirMenu`) behind.
- Preserve all existing non-sidebar spawn callers' behavior (split hotkeys,
  command palette, empty-pane grid).
- Reuse `menuStyles` and `theme.ts` tokens; no new ad-hoc hex/menu styles. Use
  the existing split-right/split-down PNG assets for the V/H controls and
  `newwindow.png` for the pane-header entry button.
- Honor the startup/focus invariants in CLAUDE.md (atomic focus transitions,
  tab hydration on first focus).

**Definition of Done**
- Global Session/Shell buttons removed; New-tab button retained.
- Per-project `[+]` menu implemented per Phase 3 and passes all Verification
  Steps.
- Pane header has a single `newwindow.png` button opening the shared
  `SpawnChoiceMenu`; the two old split buttons and `SplitDirMenu` are gone.
- `lastAgentKind`/`lastShellSpawnMode` and their helpers fully removed;
  `DEFAULT_AGENT_KIND` is the only fallback.
- `spawnInTab` exists and is the path used by the sidebar; `splitPane`/
  `newSession`/`addShellPane` are thin wrappers over the shared core.
- `npm run typecheck` clean; grep for the removed symbols
  (`SplitDirMenu`, `SplitSpawnButton`, `SpawnMenuPopover`, `SplitSpawnChoice`,
  `lastAgentKind`, `lastShellSpawnMode`) returns nothing.
