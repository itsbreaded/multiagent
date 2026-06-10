# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Treat this as a living document. When features change, startup behavior changes, agent launch behavior changes, or you discover constraints that matter for future coding sessions, update this file with the durable lesson. Keep it concise and operational: document what future agents need to know to avoid repeating investigation or breaking user workflows.

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

On Windows, shell and agent panes use `-EncodedCommand` (UTF-16LE base64) to inject a PowerShell prompt wrapper that emits OSC 7 (`\x1b]7;file:///path\x07`) on every prompt. Main process parses these in `parseOsc7()` (in `handlers.ts`) and fires `pty:cwd` events to the renderer for live CWD tracking. Use `[char]27`/`[char]7` in PowerShell scripts - backtick-e (`` `e ``) is unreliable in Windows PowerShell 5.x.

`createShell` and agent launch helpers delegate to `_shellCmd()` for PowerShell wrapping. Keep command differences in the agent command builders, not in PTY prompt/CWD plumbing.

Codex panes pass `--no-alt-screen`, `-c tui.animations=false`, and `-c tui.terminal_title=[]` to reduce cursor redraw/flicker in xterm panes. `tui.terminal_title=[]` suppresses OSC title sequences that serve no purpose in an embedded pane. Keep these flags unless verified against current Codex behavior.

PTY output flow control uses a sequence-numbered ack model: main process queues chunks with monotone sequence numbers, sends up to `MAX_IN_FLIGHT_PTY_BYTES` before waiting for renderer acks, and pauses/resumes node-pty around high/low byte watermarks. Before entering the queue, raw PTY data is coalesced over a 5ms window per PTY so rapid bursts reach xterm as fewer, larger writes — the xterm RAF render debouncer then coalesces dirty rows into a single frame rather than painting each chunk separately. The coalesce buffer is flushed explicitly on PTY exit and before every resize. Terminal behavior and flow control design draw on the microsoft/vscode GitHub repository as a reference.

### Pane Layout Model

The layout is a binary tree of `PaneNode = PaneLeaf | PaneSplit` (same model as tmux). Each `Tab` has a `rootNode` and a `focusedPaneId`. `PaneLeaf` holds `paneType` (`'shell'|'agent'`), optional `agentKind` (`'claude'|'codex'`), `cwd`, optional `ptyId`, optional `sessionId`, and optional `customName` (user-set label prefix).

Display labels: `src/renderer/src/utils/tabLabels.ts` is the single source for label computation. `paneLabelText(pane, sessions)` returns `"customName - directory"` or just the directory. `computeLabels(tabs, sessions)` returns a `Map<tabId, string>` for the tab bar.

Layouts are auto-restored on startup without prompting. `App.tsx` guards restore with a ref so React StrictMode cannot start duplicate restores, and layout saving is disabled until `layoutReady` to avoid overwriting a saved layout with an empty initial state. Saved layout includes `activeTabId` and `sidebarSectionOpen`; `applyLayout` validates focused pane IDs, restores the focused tab/pane and sidebar section expansion state when possible, and resumes agent sessions asynchronously so one failed resume does not block the whole layout. Startup resume should feel exactly like "where we left off"; do not collapse, expand, or focus UI sections implicitly unless that state was not present in an older saved layout.

Terminal scrollback is intentionally high (`TERMINAL_SCROLLBACK_LINES = 250_000` in `src/renderer/src/components/Terminal/index.tsx`) because panes host long-running Codex/Claude chats and users need access to full visible history.

### Renderer State

Two Zustand stores:

- `usePanesStore` (`src/renderer/src/store/panes.ts`) - pane tree, tab list, focus, zoom, CWD updates via `setPaneCwd`
- `useSessionsStore` (`src/renderer/src/store/sessions.ts`) - session list synced from main via `sessions:updated`

IPC listeners are wired at module level after store creation (not inside components) to avoid multiple registrations.

### UI Consistency

Keep overlay surfaces visually aligned. Settings, Session Browser, and Command Palette should share the same application modal language: centered dark overlay, `#1a1b1e` panel, `#2a2b2e` borders, 10px radius, `0 24px 64px rgba(0,0,0,0.6)` shadow, muted section labels, and green `#4ade80` active accents. Do not introduce VS Code-specific colors or layout treatments in one overlay unless the rest of the app is intentionally updated to match.

Renderer styling should start from `src/renderer/src/styles/theme.ts` for palette, borders, shadows, z-indexes, and reusable sidebar/menu/control style fragments. Add new shared tokens there when a value is meant to become a convention; avoid copying raw hex values or ad hoc menu/sidebar styles into new components.

All non-terminal scrollable renderer surfaces should use the shared `dark-scrollbar` class from `src/renderer/src/assets/main.css`. Terminal scrollbars are styled separately through `.xterm .xterm-viewport`. When adding a reusable component that owns an internal scroll container, expose a className hook instead of forcing callers to accept an unstyled native scrollbar.

### Session Indexing

`SessionIndex` wraps better-sqlite3 with FTS5 for full-text search over session transcripts. `TranscriptScanner` reads `~/.claude/projects/**/*.jsonl` and extracts metadata. Sessions are polled every 5 seconds and pushed to the renderer on change.

### Session Detection

`SessionSpawner` detects which Claude session file belongs to a newly spawned PTY. A single shared chokidar watcher (chokidar v5, ESM-only - must use dynamic `import()`) watches `~/.claude/projects/` for new `.jsonl` files. Pending detections are kept in a `Map<normalizedCwd, PendingDetection[]>` (FIFO queue per cwd). When a new JSONL appears, the watcher reads its `cwd` field and dispatches to the oldest waiting entry for that cwd, then sends `session:detected` IPC to the renderer.

Key constraints:

- One shared watcher (not one per session) - prevents concurrent watchers from racing on the same file.
- FIFO per cwd - guarantees the first session spawned in a directory claims the first JSONL written there.
- `readSessionInfo` scans up to 10 lines - `sessionId` and `cwd` may be on different records in the JSONL.
- Startup should default to resume. Do not reintroduce a restore prompt unless explicitly requested.
- Restored agent panes without a `sessionId` are converted back to shell panes because there is nothing valid to resume.

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
| `browser_get_content` | Get visible text content of the page |
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
