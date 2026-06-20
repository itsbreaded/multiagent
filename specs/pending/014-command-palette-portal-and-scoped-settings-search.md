# 014 — Command Palette as App Portal + Scoped Settings Search

## Problem

The command palette (`Ctrl+Shift+P`) is currently a narrow tool: it offers six
hardcoded pane/session actions plus resumable sessions. It is not the VS Code-style
"portal to everything" the app wants — there is no way to open Settings, the Session
Browser, the browser panel, manage tabs, zoom panes, or run most of the app's
existing commands from it.

Two related gaps:

1. **Command palette coverage.** Most user-reachable actions (Settings, Session
   Browser toggle, new/close tab, close/zoom pane, browser panel, hotkey-bound
   actions) are invisible to the palette. There is no shared command registry —
   the action list is a hardcoded `useMemo` array inside the palette component, so
   every surface (palette, menus, hotkeys) defines its own copy of "what can be
   done."

2. **Settings search semantics.** The Settings form already filters settings within
   the active section, but the behavior must be made explicit and correct as a
   requirement:
   - Search is **scoped to the currently highlighted section** (it filters only the
     settings shown for that section).
   - Search must **never filter the section list** (the left nav). All sections stay
     visible and selectable while a query is active; only the settings rows in the
     content pane are filtered.

## Current Behavior

### Command palette

- `src/renderer/src/components/CommandPalette/index.tsx`
  - `ActionEntry` interface (lines 15–23): `{ kind, label, shortcut?, icon, agentKind?, shellIcon?, run }`.
  - Actions are a hardcoded `useMemo` array (lines 47–110): New Claude session, New
    Codex session, New shell pane, Split vertical, Split horizontal, Toggle sidebar.
  - Filtering (lines 112–115): case-insensitive substring on `label` for actions;
    sessions go through `useSessions().search()`. No fuzzy match, no grouping beyond
    "Sessions" / "Commands".
  - Each `run` reads `getFocusedPane()` for cwd context and calls `closeOverlays()`.
- Opened via `usePanesStore.toggleCommandPalette()` (panes.ts:392), wired in
  `App.tsx` global keyboard dispatch from `DEFAULT_HOTKEYS.commandPalette`
  (`utils/hotkeys.ts:21`).
- Store actions available but NOT exposed in the palette today (panes.ts):
  `toggleSettings` (393), `toggleSessionBrowser` (391), `addTab` (344/711),
  `closeTab` (348/728), `closePane` (363), `zoomPane` (364/1024), plus the browser
  panel toggle (`browser:toggle` IPC). Hotkeys defined but not all palette-exposed:
  `newTab`, `closeTab`, `closePane`, `zoomPane`, `sessionBrowser` (hotkeys.ts:14–22).

### Settings search

- `src/renderer/src/components/SettingsPanel/index.tsx`
  - Sections are a hardcoded array (lines 55–60): `appearance`, `hotkeys`, `mcp`,
    `general`. Active section tracked by `useState<SettingsSection>('appearance')`
    (line 47). Section nav buttons at lines 177–217.
  - Search query is local state `query` (line 48). Filtering is per-section and
    keyword-string based:
    - `showBranchSetting` / `showOverflowSetting` / `showScrollbackSetting`
      (lines 126–128) test `'keywords...'.includes(normalizedQuery)`.
    - `visibleHotkeys` (lines 131–133) filters `HOTKEY_ORDER` by label substring.
  - The section nav itself is **already not filtered** by `query` (good — this spec
    formalizes and guarantees that). Each section body renders only when
    `activeSection === <id>`, so search already only affects the highlighted section.
  - Fields are hardcoded JSX per section; no declarative settings registry.
  - Settings store: `src/renderer/src/store/settings.ts` — keys `showGitBranchBadges`,
    `tabOverflowMode`, `terminalScrollbackLines`, `hotkeyOverrides`, `mcpSettings`.

### Styling

Both overlays already follow the shared modal language (centered dark overlay,
`#1a1b1e` panel, `#2a2b2e` borders, 10px radius, `0 24px 64px rgba(0,0,0,0.6)`
shadow, `#4ade80` green accent), but use hardcoded hex inline rather than
`styles/theme.ts` tokens.

## Intended Behavior

### A. Shared command registry

Introduce a single declarative command registry as the source of truth for app
commands, consumed by the command palette (and reusable later by menus/hotkeys).

- New file: `src/renderer/src/commands/registry.ts` (or `.tsx`).
- A `Command` type, roughly:
  ```ts
  interface Command {
    id: string                 // stable, e.g. 'settings.open'
    title: string              // 'Open Settings'
    category: string           // 'General' | 'Panes' | 'Tabs' | 'View' | 'Session'
    keywords?: string[]        // extra search terms ('preferences', 'config')
    icon?: string              // existing asset/glyph convention
    agentKind?: AgentKind      // for agent-typed entries (reuse AgentIcon)
    shellIcon?: boolean
    shortcut?: () => string | undefined   // resolve from effective hotkeys at render
    enabled?: (ctx: CommandContext) => boolean   // hide/disable when N/A
    run: (ctx: CommandContext) => void | Promise<void>
  }
  ```
- `CommandContext` provides `getFocusedPane()`, the active tab id, and cwd resolution
  (`pane?.cwd ?? window.homeDir ?? 'C:\\'`) so command `run`s do not each re-derive it.
- Commands are defined against existing store actions / IPC — no new business logic.
  `run`s call `closeOverlays()` (or rely on the palette to close after dispatch).

Initial command set (migrate the existing 6, then add the portal entries):

| id | title | category | dispatch |
|---|---|---|---|
| `session.newClaude` | New Claude Session | Session | `newSession(cwd,'vertical','claude')` |
| `session.newCodex` | New Codex Session | Session | `newSession(cwd,'vertical','codex')` |
| `pane.newShell` | New Shell Pane | Panes | `addShellPane(cwd)` |
| `pane.splitVertical` | Split Pane Vertical | Panes | `splitPane(id,'vertical')` |
| `pane.splitHorizontal` | Split Pane Horizontal | Panes | `splitPane(id,'horizontal')` |
| `pane.close` | Close Pane | Panes | `closePane(focused)` |
| `pane.zoom` | Toggle Zoom Pane | Panes | `zoomPane(focused)` |
| `tab.new` | New Tab | Tabs | `addTab()` |
| `tab.close` | Close Tab | Tabs | `closeTab(active)` |
| `view.toggleSidebar` | Toggle Sidebar | View | `toggleSidebar()` |
| `view.sessionBrowser` | Open Session Browser | View | `toggleSessionBrowser()` |
| `view.browserPanel` | Toggle Browser Panel | View | `browser:toggle` IPC |
| `settings.open` | Open Settings | General | `toggleSettings()` |
| `settings.open.appearance` | Settings: Appearance | General | open Settings → `appearance` |
| `settings.open.hotkeys` | Settings: Hotkeys | General | open Settings → `hotkeys` |
| `settings.open.mcp` | Settings: MCP | General | open Settings → `mcp` |
| `settings.open.general` | Settings: General | General | open Settings → `general` |

`shortcut` resolves from `buildHotkeys(hotkeyOverrides)` so palette chips reflect
user-customized bindings, not the static `HOTKEYS` display strings.

### B. Command palette uses the registry

- Replace the hardcoded `actions` array with `getCommands(ctx).filter(c => c.enabled?.(ctx) ?? true)`.
- Filtering matches against `title`, `category`, and `keywords`. Keep current
  substring matching for v1 (no fuzzy lib); group results by `category` with the
  existing `SectionLabel` style, plus the "Sessions" group as today.
- Sessions remain first (recents when query empty), commands below. Keyboard
  nav / selection index logic is unchanged.
- Deep-linking into Settings sections: extend `toggleSettings` (or add
  `openSettings(section?: SettingsSection)`) so a target section can be passed.
  Store an `initialSettingsSection` (or reuse a settings store field) that
  `SettingsPanel` reads to seed `activeSection` on open. The `settings.open.*`
  commands set this; plain `settings.open` opens the last/default section.

### C. Scoped settings search (formalized)

- The section nav (left list) is rendered from `sections` and must remain
  **independent of `query`** — never filter, hide, or reorder section buttons based
  on the search text. (Current code already satisfies this; add a code comment
  documenting the invariant so it is not "optimized" into filtering the nav.)
- Search filters **only the rows of the active section**. Keep the existing
  per-section filtering pattern; ensure every section shows a consistent
  "No settings match your search." empty state when its visible rows are all
  filtered out (Appearance/General already have this via `EmptyMessage`; verify
  Hotkeys shows it when `visibleHotkeys` is empty).
- Switching sections while a query is active keeps the query and re-applies it to
  the newly highlighted section (current behavior — preserve it).

## Implementation Phases

1. **Command registry.** Add `src/renderer/src/commands/registry.ts` with the
   `Command`/`CommandContext` types and `getCommands(ctx)`. Migrate the 6 existing
   palette actions verbatim into it. No UI change yet.
2. **Settings deep-link plumbing.** Add `openSettings(section?)` (or extend
   `toggleSettings`) in `panes.ts` + an `initialSettingsSection` field consumed by
   `SettingsPanel` to seed `activeSection`. Add the `view.*` and `settings.open*`
   commands.
3. **Palette refactor.** Rewrite `CommandPalette` to render from the registry with
   category grouping and hotkey-aware shortcut chips; keep session results and
   keyboard nav intact.
4. **Settings search invariant.** Add the documenting comment on the section nav,
   confirm Hotkeys empty-state, and confirm section-scoped filtering across all four
   sections including MCP (decide whether MCP participates in search or is exempt —
   default: exempt for v1 since it is a sub-component, and note that in the spec/code).
5. **Theme tokens (optional cleanup).** Where touched, prefer `styles/theme.ts`
   tokens over inline hex for the palette to reduce drift (non-blocking).

## Risks

- **Focus context at dispatch time.** Commands that act on "the focused pane/tab"
  must resolve context when `run` fires, not when the palette renders, or they will
  act on stale targets. Resolve inside `run` via `CommandContext`.
- **Deep-link race.** Opening Settings and setting the section must be atomic (one
  state transition), per the multi-window/atomic-focus guidance in CLAUDE.md — avoid
  `toggleSettings()` then a separate `setActiveSection()` that the panel might miss
  on first mount. Seed from store state read during `SettingsPanel` init instead.
- **Enabled/disabled commands.** `pane.close`/`pane.zoom`/`tab.close` should be
  hidden or disabled when there is no focused pane / only one tab, so the palette
  never dispatches a no-op that confuses users.
- **Detached windows.** Settings/Session Browser only render in the primary window
  (`!isDetachedWindow` guards in `App.tsx`). Either gate those commands out of the
  palette in detached windows or route them to the primary window. Default v1: hide
  primary-only commands when `isDetachedWindow`.
- **Search regression in Settings.** Do not let the registry/search refactor change
  the rule that the section nav is never filtered.

## Verification

- `npm run typecheck` passes.
- `Ctrl+Shift+P` lists Sessions plus grouped command categories (General, Panes,
  Tabs, View, Session). Typing "settings" surfaces "Open Settings" and the four
  "Settings: <section>" entries; selecting one opens Settings on that section.
- Shortcut chips in the palette reflect a customized hotkey (rebind Split Vertical in
  Settings → Hotkeys, reopen palette, confirm the chip updated).
- Palette commands act on the currently focused pane/tab (split/close/zoom hit the
  right target after switching focus).
- In Settings, typing a query filters only the active section's rows; all four
  section buttons stay visible and clickable; switching sections re-applies the query
  to the new section; an over-narrow query shows the per-section empty state.
- In a detached window, primary-only commands (Settings, Session Browser) are absent
  (or correctly routed), and the palette still works for pane/tab commands.

## Notes / Extension Points (file:line)

- Palette: `src/renderer/src/components/CommandPalette/index.tsx` — `ActionEntry`
  (15–23), action array (47–110), filtering (112–120), grouping (214–302).
- Settings: `src/renderer/src/components/SettingsPanel/index.tsx` — sections (55–60),
  `activeSection` (47), `query` (48), per-section filters (125–133), nav (177–217).
- Store: `src/renderer/src/store/panes.ts` — `toggleSettings` (393),
  `toggleSessionBrowser` (391), `toggleCommandPalette` (392), `closeOverlays` (394),
  `addTab` (344), `closeTab` (348), `closePane` (363), `zoomPane` (364),
  `toggleSidebar` (388/1656), `newSession` (377/1283), `addShellPane` (378/1328),
  `splitPane` (361/932), `getFocusedPane`.
- Hotkeys: `src/renderer/src/utils/hotkeys.ts` — `DEFAULT_HOTKEYS` (13–23),
  `buildHotkeys` (40–51). Add a `settings` hotkey here if a direct binding is wanted.
- Settings store: `src/renderer/src/store/settings.ts`.
- Theme tokens: `src/renderer/src/styles/theme.ts`.
