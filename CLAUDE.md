# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Treat this as a living document. When features change, startup behavior changes, agent launch behavior changes, or you discover constraints that matter for future coding sessions, update this file with the durable lesson. Keep it concise and operational: document what future agents need to know to avoid repeating investigation or breaking user workflows.

## Planning Specs

Use `specs/pending/` for planned work that needs design before implementation. Name spec files with a three-digit global sequence and kebab-case title, e.g. `001-lazy-tab-hydration.md`. Before creating a new spec, check both `specs/pending/` and `specs/done/` and use the next unused number across both folders, preserving the number when moving the file to `specs/done/`. A pending spec should describe the problem, current behavior, intended behavior, implementation phases, risks, and verification steps. If the spec is intended as a handoff to another developer or agent, include a clear handoff contract with non-negotiables and a definition of done. Keep specs practical and delete or move them when they stop being useful; do not keep stale todos or historical investigation logs around.

Move completed specs to `specs/done/` only when they still provide durable context worth preserving. If the useful lesson is short, fold it into `CLAUDE.md` instead and delete the spec.

## Commands

```bash
npm run dev        # start dev server (Electron + Vite HMR)
npm run build      # compile only (no packaging)
npm run typecheck  # TypeScript type-check without emitting
npm run dist       # build + package to dist\win-unpacked\ (requires Windows Developer Mode)
```

`postinstall` runs the `electron-rebuild` CLI from `@electron/rebuild` automatically after `npm install`, rebuilding `node-pty` and `better-sqlite3` for the Electron ABI. Do not re-run it manually or add `--ignore-scripts`.

### Packaging Notes

- `npm run dist` uses `electron-builder` with `npmRebuild: false` because postinstall already handles native module rebuilding.
- Output goes to `dist\win-unpacked\` - copy that folder to other machines for personal distribution (no installer, no signing, no admin required).
- `asarUnpack` is set for `**/*.node`, `**/node-pty/**`, and `**/better-sqlite3/**` so native modules are accessible outside the asar archive.
- MCP templates under `src/main/mcp/templates/**/*` are included in packaged builds via `package.json` `build.files`. If templates move or new runtime templates are added, update the packaging list and verify they are present in `resources/app.asar`.

## Architecture

Three Electron processes:

1. **Main process** (`src/main/`) - IPC, PTY management, session indexing, browser panel
2. **Preload** (`src/preload/index.ts`) - typed `window.ipc` bridge (`invoke`/`on`/`send`)
3. **Renderer** (`src/renderer/`) - React + Zustand, xterm.js terminals, all UI

All IPC channel names and their signatures are the single source of truth in `src/shared/types.ts`.

### PTY Isolation

`node-pty` runs in a child process (`src/main/pty/ptyWorker.ts`) spawned with `ELECTRON_RUN_AS_NODE=1`. This prevents Chromium's IPC handles from being inherited into ConPTY, which would crash Claude (a Bun binary). `PtyManager` communicates with the worker over Node IPC (`process.send`/`process.on('message')`).

The terminal stack intentionally follows VS Code's integrated-terminal shape for agent panes. `node-pty` stays isolated in `src/main/pty/ptyWorker.ts`; `PtyManager` is the agent pty-host contract for create/input/resize/kill/data/exit/ready. The worker's ready event carries pid, initial cwd, and Windows ConPTY traits. The renderer must apply xterm `windowsPty` and the DA1 `\x1b[?61;4c` response only after `pty:ready`, not at xterm construction time.

Normal shell panes use `ShellPtyHost` + `shellWorker.ts`, a direct worker relay based on the proven in-app Bare Term path from spec 012. Do not route shell panes back through the agent `PtyManager` batching/ack path; that path repeatedly dropped short no-scroll output such as `git pull -> Already up to date.` on the target Windows machine. Shell panes still use normal pane IDs, `pty:*` IPC, `pty:ready`, `pty:cwd`, window routing, and close/transfer plumbing.

**The dedicated `shellWorker` *process* is load-bearing — not just the direct (seq=0) data policy.** A unification attempt (commit `27ec130`, reverted) kept the exact seq=0 direct relay and identical ConPTY spawn config but moved shell PTYs into the shared `ptyWorker` process; the `git pull -> Already up to date.` no-scroll drop returned immediately. This matches spec 012's finding that a direct send through the `ptyManager`/`ptyWorker` path still dropped. So shell and agent panes must keep **separate worker processes**: shell on `shellWorker`, agents on `ptyWorker`. Do not merge them into one worker. You may share host *contracts*/types and renderer code, but not the worker process.

On Windows, shell panes inject `src/main/pty/shellIntegration.ps1`, emitted beside `out/main/index.js` by `electron.vite.config.ts`. The script uses VS Code-style OSC 633 (`OSC 633;P;Cwd=...`) for CWD reporting; main parses it in `handlers.ts` and sends `pty:cwd`. OSC 7 parsing remains only as compatibility fallback. Do not reintroduce ad hoc prompt wrapping or the removed `shellterm:*`/Bare Term scaffolding as a production terminal path.

Renderer resize uses the VS Code principle: immediate resize for first/small-buffer changes, vertical updates immediately once established, and horizontal reflow debounced with a deterministic flush. Avoid raw `ResizeObserver -> pty.resize` loops.

`createShell` uses `_shellCmd()` for the interactive prompt/CWD wrapper. Agent panes must not start an interactive shell and then wait for a prompt before typing `codex`/`claude`; `SessionSpawner` launches the agent command immediately through a non-profile shell command. Keep this direct launch path so restored Codex panes do not pay the old 10s prompt-detection fallback.

Codex panes pass `--no-alt-screen`, `-c tui.animations=false`, and `-c tui.terminal_title=[]` to reduce cursor redraw/flicker in xterm panes. `tui.terminal_title=[]` suppresses OSC title sequences that serve no purpose in an embedded pane. Keep these flags unless verified against current Codex behavior.

PTY output flow control uses a sequence-numbered ack model in `src/main/ipc/handlers.ts` and `src/renderer/src/components/Terminal/index.tsx`: main batches raw PTY data for 5ms or 256 KiB, sends `pty:data` payloads with monotone sequence numbers, tracks in-flight bytes, and pauses/resumes node-pty around high/low byte watermarks. The renderer writes each payload to xterm in bounded slices and sends `pty:data-ack` only after xterm's write callback accepts the final slice for that payload. Treat xterm write callbacks as parser/backpressure signals, not proof that a GPU frame has painted. The coalesce buffer is flushed explicitly on PTY exit and before every resize; terminal resize uses one-way `window.ipc.send('pty:resize', ...)`, not `invoke`.

### Pane Layout Model

The layout is a binary tree of `PaneNode = PaneLeaf | PaneSplit` (same model as tmux). Each `Tab` has a `rootNode` and a `focusedPaneId`. `PaneLeaf` holds `paneType` (`'shell'|'agent'`), optional `agentKind` (`'claude'|'codex'`), `cwd`, optional `ptyId`, optional `sessionId`, and optional `customName` (user-set label prefix).

Display labels: `src/renderer/src/utils/tabLabels.ts` is the single source for label computation. `paneLabelText(pane, sessions)` returns `"customName - directory"` or just the directory. `computeLabels(tabs, sessions)` returns a `Map<tabId, string>` for the tab bar.

Layouts are auto-restored on startup without prompting. `App.tsx` guards restore with a ref so React StrictMode cannot start duplicate restores, and layout saving is disabled until `layoutReady` to avoid overwriting a saved layout with an empty initial state. Saved layout includes `activeTabId`, `sidebarSectionOpen`, and `sidebarPanelSizes`; `layout:save` and `applyLayout` normalize every saved tab to `detached: false` because detached BrowserWindows are not recreated on cold start. `applyLayout` validates focused pane IDs, restores tab/pane metadata and sidebar section expansion state, clears stale detached-window ownership maps, and hydrates only the restored active tab. Inactive restored tabs stay visible in the tab bar/sidebar from metadata but their pane trees, shell PTYs, xterms, and agent resumes are deferred until first focus. Once a tab has hydrated, keep it mounted while inactive so scrollback and live PTY/session state survive tab switches. Startup resume should feel exactly like "where we left off"; do not collapse, expand, or focus UI sections implicitly unless that state was not present in an older saved layout. Any new resizable/collapsible sidebar panel must use a stable panel id and persist its size through `sidebarPanelSizes`.

Terminal scrollback defaults to `250_000` lines because panes host long-running Codex/Claude chats and users need access to full visible history. Users can adjust this in Settings -> General; the value is persisted in `useSettingsStore.terminalScrollbackLines` and applied to both new and existing xterm instances through `xtermRegistry.setScrollbackLines()`. Lowering the value can trim existing scrollback, so do not silently lower the default as a performance fix.

### Renderer State

Two Zustand stores:

- `usePanesStore` (`src/renderer/src/store/panes.ts`) - pane tree, tab list, focus, zoom, CWD updates via `setPaneCwd`
- `useSessionsStore` (`src/renderer/src/store/sessions.ts`) - session list synced from main via `sessions:updated`

IPC listeners are wired at module level after store creation (not inside components) to avoid multiple registrations.

### Multi-Window State Invariants

The primary window owns the sidebar and shows local plus detached tabs. Detached windows have content and a tab bar, but no sidebar. Multi-window tab and pane movement should preserve a single coherent ownership model across main, source renderer, target renderer, and PTY routing.

User-level focus transitions must be atomic. Do not compose primitive actions such as `setActiveTab()` followed by `focusPane()` when the UI expects one focus change; use tab-aware transition actions such as `focusPaneInTab(tabId, paneId)`. Primitive setters should stay side-effect-light, and named transition actions should own any paired state update plus IPC broadcast.

PTY routing must not move ahead of renderer ownership. For cross-window pane or tab movement, the destination should commit and ack before main reroutes PTYs, and the source should not delete its last good copy until the transfer is committed or rollback is possible. This is especially important for `tab:absorb`: a release timeout after the source has already removed the tab can lose the tab from all windows and orphan its PTYs.

Detached sync and focus messages should be versioned or generation-checked. Stale `tab:state-sync` or focus acks must not reclaim moved tabs or focus a window that no longer owns the tab.

### UI Consistency

Keep overlay surfaces visually aligned. Settings, Session Browser, and Command Palette should share the same application modal language: centered dark overlay, `#1a1b1e` panel, `#2a2b2e` borders, 10px radius, `0 24px 64px rgba(0,0,0,0.6)` shadow, muted section labels, and green `#4ade80` active accents. Do not introduce VS Code-specific colors or layout treatments in one overlay unless the rest of the app is intentionally updated to match.

Buttons should use image icons from `src/renderer/src/assets/` instead of visible text characters or emojis. If a needed button icon is missing, ask the user to provide a new `.png` asset before implementing the button.

Renderer styling should start from `src/renderer/src/styles/theme.ts` for palette, borders, shadows, z-indexes, and reusable sidebar/menu/control style fragments. Add new shared tokens there when a value is meant to become a convention; avoid copying raw hex values or ad hoc menu/sidebar styles into new components.

When one UI has multiple presentation modes, keep the shared pieces structurally shared. For example, tab overflow modes may change only the container behavior (scroll vs wrap); tab cards, add-tab controls, row metrics, padding, and interaction semantics should come from the same constants/components. Before fixing a mode-specific visual or hit-test bug, compare both render paths and remove duplicated branches that let sizing, placement, or behavior drift. In Electron chrome, default top chrome regions to draggable and explicitly exempt real controls; avoid native `no-drag` rectangles on horizontally scrolled children because Chromium/Electron hit regions can leak when scrolled.

All non-terminal scrollable renderer surfaces should use the shared `dark-scrollbar` class from `src/renderer/src/assets/main.css`. Terminal scrollbars are styled separately through `.xterm .xterm-viewport`. When adding a reusable component that owns an internal scroll container, expose a className hook instead of forcing callers to accept an unstyled native scrollbar.

### Session Indexing

`SessionIndex` wraps better-sqlite3 with FTS5 for full-text search over session transcripts. `TranscriptScanner` reads `~/.claude/projects/**/*.jsonl` and `CodexSessionScanner` reads `~/.codex/sessions/**/*.jsonl`; both extract metadata into the same index. Sessions are polled every 5 seconds and pushed to the renderer on change. Closing an agent pane with a known `sessionId` also triggers an immediate `sessions:refresh` scan so the session can move from the live pane list to Recent without waiting for the next poll.

`SessionIndex.search(query)` is summary-only FTS5 over `projectName`, `displayName`, `firstMessage`, and `lastMessage`. It is **not** a full transcript search.

`DeepSearcher` (`src/main/sessions/DeepSearcher.ts`) implements full transcript search via a pure Node.js streamer (no PATH-provided `rg`). It walks both Claude and Codex JSONL roots, reads each file line-by-line, matches each line against the query, parses matching lines to extract human-readable text (not raw JSON), groups results by `agentKind:sessionId`, hydrates from `SessionIndex` (scans and upserts unindexed files on demand), ranks by role quality + recency + match count, and caps at 50 sessions / 5 matches per session. The IPC channel is `sessions:search-deep` (invoke, receives a `SessionSearchRequest`, returns `SessionSearchResult[]`). Default mode is literal (not regex); `caseSensitive` and `regex` flags are opt-in per request.

Session Browser UI has two modes: **Summary** (instant in-memory filter over loaded metadata) and **Deep** (300ms debounced call to `sessions:search-deep`). Deep mode shows match snippets inline under each session row with role badges (user/assistant/tool) and timestamps. Stale results are discarded via a generation counter — a new query increments the counter and any response from an older generation is dropped.

Session cwd corrections are app-owned metadata first. `SessionIndex` keeps per-session cwd overrides in SQLite and applies them during scanner upserts so a repaired directory is not undone by the 5s transcript rescan. Session rows include `cwdExists`; UI should mark missing directories as severed/recoverable. Missing cwd repair is project-level: all sessions from the old cwd move together. Claude Code is directory-scoped, so repairing a Claude cwd copy/merges the old `~/.claude/projects/<encoded-old-cwd>/` transcript directory into the new encoded cwd directory and updates indexed file paths. Do not rewrite whole transcript JSONL files for normal repair; Codex does not need transcript copying for cwd changes.

### Session Detection

`SessionSpawner` detects which session belongs to a newly spawned PTY differently by agent. Claude is assigned up front: new Claude panes generate a UUID and launch `claude --session-id <uuid>`, so the renderer receives the session id immediately. Codex cannot be assigned a new rollout id at launch, so Codex detection watches for user input, snapshots the existing `~/.codex/sessions/` files, then polls new rollout JSONL files every second and claims only one unambiguous cwd/time-matching candidate. Codex resume still needs this detection because interactive `codex resume` can fork to a new rollout id.

Key constraints:

- Do not reintroduce Claude filesystem matching for new panes; preserve the launch-time `--session-id` path unless Claude removes that flag.
- Codex detection starts polling only after the pane submits its first real message; opening and closing a never-messaged Codex pane usually leaves no rollout transcript to index.
- Codex candidates are matched by normalized cwd, baseline snapshot diff, and start-time grace. Ambiguous matches are ignored rather than assigned.
- Codex resume still needs detection because interactive `codex resume` can fork to a new rollout id; preserve the cwd/time-constrained scanner path unless Codex behavior is re-verified.
- Startup should default to resume. Do not reintroduce a restore prompt unless explicitly requested.
- New agent panes persist `sessionDetectionState`, `sessionDetectionStartedAt`, and `sessionDetectionCwd` while detection is pending. On startup, panes with a pending marker and no `sessionId` may recover only from an exact single cwd/time transcript match; otherwise they remain visible as agent recovery placeholders. Legacy agent panes with no `sessionId` and no pending marker are still converted back to shell panes.
- `hydrateTabRuntime` calls `sessions:validate(agentKind, sessionId, cwd)` before `session:resume`. If the transcript is missing, the pane gets `resumeError` and no CLI process is spawned. This prevents repeated doomed-spawn loops on startup when a session was deleted or moved.
- On primary window close, main intercepts the `close` event once (via `isShutdownSaveComplete` flag), sends `layout:request-state` to the primary renderer and `layout:collect-detached-state` to each detached window (up to 1000ms timeout each), merges the fresh detached snapshots into the primary's tab list, and writes a final `layout.json`. This ensures detached-window changes made immediately before shutdown are preserved despite the 300ms sync debounce. New IPC channels: `layout:request-state`, `layout:collect-detached-state` (EventChannels); `layout:state-response`, `layout:detached-state-response` (SendChannels).

### Agent MCP Injection

The app must not mutate user or project agent config files. Do not write to `~/.claude.json`, `~/.codex/config.toml`, `.mcp.json`, or similar files as part of startup. MCP injection is process-scoped only.

`BrowserMcpServer.startHttp()` exposes the browser MCP server. Both Claude and Codex should use the streamable HTTP endpoint at `http://127.0.0.1:{port}/mcp` via templates in `src/main/mcp/templates/`:

- `claude-mcp.json` - JSON config for Claude Code, with `{port}` replaced at runtime.
- `codex-mcp.toml` - TOML snippet for Codex CLI config overrides, with `{port}` replaced at runtime.

`McpInjector` resolves these templates on startup. Claude Code on Windows requires a real file path for `--mcp-config`; inline JSON is unreliable and has been observed to be treated as a mangled file path. Therefore Claude uses a PID-scoped temp file under `%TEMP%`, passed as `--mcp-config <path>` (no `--strict-mcp-config`), and cleaned up by `McpInjector`. Omitting `--strict-mcp-config` is intentional — it allows Claude to still load user-level and project-level MCP servers from its normal config locations alongside the injected browser server.

Codex does not need a temp file. It receives the MCP server process-scoped through CLI `-c` overrides generated from the template, along with the TUI flags noted above.

### Browser Panel (MCP)

`BrowserViewManager` embeds a `BrowserView` that an MCP server (`BrowserMcpServer`) can control via tools in `src/main/mcp/tools/`. The renderer shows/hides it via `browser:toggle`.

Available MCP tools (server name `multiagent-browser`):

| Tool | Description |
|---|---|
| `browser_navigate` | Navigate to a URL |
| `browser_go_back` | Go back one step in history |
| `browser_go_forward` | Go forward one step in history |
| `browser_click` | Click an element by CSS selector |
| `browser_click_text` | Click the first visible element whose text matches a string (case-insensitive substring by default; set `exact: true` for full match). Preferred when you know the label but not the selector. |
| `browser_click_at` | Click at specific `(x, y)` pixel coordinates - use when selectors are ambiguous or elements overlap |
| `browser_type` | Type text into an element |
| `browser_hover` | Hover over an element by CSS selector (fires native mouse-move + `mousemove`/`mouseover`/`mouseenter` JS events) |
| `browser_hover_at` | Hover at specific `(x, y)` pixel coordinates - use when `browser_hover` hits the wrong element |
| `browser_keyboard` | Send a key press - e.g. `Return`, `Escape`, `Tab`, `F5` - with optional modifiers |
| `browser_select` | Set a `<select>` dropdown value by CSS selector |
| `browser_scroll` | Scroll the page by x/y pixels |
| `browser_screenshot` | Capture a base64 PNG of the current view |
| `browser_get_content` | Get visible text. Optional `selector` scopes to one element; optional `max_chars` truncates output while reporting full size metadata. Use unscoped whole-page text sparingly for orientation or broad audits. |
| `browser_get_url` | Get the current URL |
| `browser_get_elements` | Query all elements matching a CSS selector; returns tag, text, value, id, classes, **href**, **role**, and bounding box `(x/y/width/height)`. Use to inspect the DOM or find coordinates before `browser_click_at` / `browser_hover_at`. For link navigation, prefer `browser_get_links`. |
| `browser_get_links` | Return all visible `<a>` links on the page with `text`, `href`, and center `(x, y)`. Accepts optional `text_filter` for substring match. **Preferred pattern for navigating to a link**: get href here, then call `browser_navigate` directly. |
| `browser_evaluate` | Execute JavaScript and return the result |
| `browser_wait_for` | Wait for a CSS selector to appear |
| `browser_wait_for_text` | Wait for a text string to appear anywhere on the page (case-insensitive) |
| `browser_wait_for_load` | Wait for the page to finish loading |
| `browser_set_cookies` | Set cookies on the current session |

All tools are neutral primitives - no decision-making is embedded. To override JS dialogs (`alert`/`confirm`/`prompt`), use `browser_evaluate` to patch `window.confirm = () => true` etc. after navigation.

### Recommended Tool Selection Order

1. **Navigating to a link on the page** -> `browser_get_links(text_filter: "...")` -> pick `href` -> `browser_navigate(href)`. Most reliable - bypasses coordinate precision and nested-element issues entirely.
2. **Clicking a button or action** -> `browser_click_text` (e.g. "Log Out", "Submit", "Accept"). Also works for links; for `http(s)` links it navigates directly via href instead of coordinate clicking.
3. **Know a unique CSS selector** -> `browser_click` / `browser_hover`
4. **Selectors ambiguous or overlapping** -> `browser_get_elements` to find coordinates, then `browser_click_at` / `browser_hover_at`
5. **Need href/URL of an element without clicking** -> `browser_evaluate` with `document.querySelector('a[...]').href`
6. **Need to inspect/debug the DOM** -> `browser_get_elements` before reaching for `browser_evaluate`
