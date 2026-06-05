# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # start dev server (Electron + Vite HMR)
npm run build      # compile only (no packaging)
npm run typecheck  # TypeScript type-check without emitting
npm run dist       # build + package to dist\win-unpacked\ (requires Windows Developer Mode)
```

`postinstall` runs `electron-rebuild` automatically after `npm install`, rebuilding `node-pty` and `better-sqlite3` for the Electron ABI. Do not re-run it manually or add `--ignore-scripts`.

### Packaging notes

- `npm run dist` uses `electron-builder` with `npmRebuild: false` because postinstall already handles native module rebuilding.
- Output goes to `dist\win-unpacked\` — copy that folder to other machines for personal distribution (no installer, no signing, no admin required).
- `asarUnpack` is set for `**/*.node`, `**/node-pty/**`, and `**/better-sqlite3/**` so native modules are accessible outside the asar archive.

## Architecture

Three Electron processes:

1. **Main process** (`src/main/`) — IPC, PTY management, session indexing, browser panel
2. **Preload** (`src/preload/index.ts`) — typed `window.ipc` bridge (`invoke`/`on`/`send`)
3. **Renderer** (`src/renderer/`) — React + Zustand, xterm.js terminals, all UI

All IPC channel names and their signatures are the single source of truth in `src/shared/types.ts`.

### PTY isolation

`node-pty` runs in a child process (`src/main/pty/ptyWorker.ts`) spawned with `ELECTRON_RUN_AS_NODE=1`. This prevents Chromium's IPC handles from being inherited into ConPTY, which would crash Claude (a Bun binary). `PtyManager` communicates with the worker over Node IPC (`process.send`/`process.on('message')`).

On Windows, both shell and claude panes use `-EncodedCommand` (UTF-16LE base64) to inject a PowerShell prompt wrapper that emits OSC 7 (`\x1b]7;file:///path\x07`) on every prompt. Main process parses these in `parseOsc7()` (in `handlers.ts`) and fires `pty:cwd` events to the renderer for live CWD tracking. Use `[char]27`/`[char]7` in PowerShell scripts — backtick-e (`` `e ``) is unreliable in Windows PowerShell 5.x.

`createShell` and `createClaude` both delegate to `_shellCmd()` - never add branching logic between them.

### Pane layout model

The layout is a binary tree of `PaneNode = PaneLeaf | PaneSplit` (same model as tmux). Each `Tab` has a `rootNode` and a `focusedPaneId`. `PaneLeaf` holds `paneType` (`'shell'|'claude'`), `cwd`, optional `ptyId`, optional `sessionId`, and optional `customName` (user-set label prefix).

Display labels: `src/renderer/src/utils/tabLabels.ts` is the single source for label computation. `paneLabelText(pane, sessions)` returns `"customName · directory"` or just the directory. `computeLabels(tabs, sessions)` returns a `Map<tabId, string>` for the tab bar.

### Renderer state

Two Zustand stores:
- `usePanesStore` (`src/renderer/src/store/panes.ts`) — pane tree, tab list, focus, zoom, CWD updates via `setPaneCwd`
- `useSessionsStore` (`src/renderer/src/store/sessions.ts`) — session list synced from main via `sessions:updated`

IPC listeners are wired at module level after store creation (not inside components) to avoid multiple registrations.

### Session indexing

`SessionIndex` wraps better-sqlite3 with FTS5 for full-text search over session transcripts. `TranscriptScanner` reads `~/.claude/projects/**/*.jsonl` and extracts metadata. Sessions are polled every 5 seconds and pushed to the renderer on change.

### Browser panel (MCP)

`BrowserViewManager` embeds a `BrowserView` that an MCP server (`BrowserMcpServer`) can control via tools in `src/main/mcp/tools/`. The renderer shows/hides it via `browser:toggle`.
