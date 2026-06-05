# MultiAgent - Claude Code Terminal Multiplexer

A GUI-first terminal multiplexer purpose-built for managing Claude Code sessions, with an embedded browser that agents can control via a built-in MCP server.

---

## Vision

Warp-style terminal experience where Claude Code sessions are first-class citizens. Launch, resume, and organize Claude Code sessions across projects from a single UI. Agents spawned from the app get access to an embedded browser via a local MCP server built on Electron's native browser APIs.

**Non-goals (v1):** Inline AI command suggestions, cloud sync, mobile, plugin ecosystem.

---

## Target Platforms

- Windows 10/11
- macOS 13+

---

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                  Electron App                    │
│                                                  │
│  ┌──────────────┐   ┌────────────────────────┐  │
│  │  Renderer    │   │     Main Process        │  │
│  │  (React UI)  │◄──►  SessionManager        │  │
│  │              │   │  ProcessWatcher         │  │
│  │  - Sidebar   │   │  TranscriptScanner      │  │
│  │  - Pane grid │   │  MCP Browser Server     │  │
│  │  - Terminals │   │  PTY Manager            │  │
│  └──────────────┘   └────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │         WebContentsView (Browser)           │  │
│  │  Embedded browser panel visible to user,   │  │
│  │  controllable by agents via MCP tools      │  │
│  └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
         │                        │
    node-pty                 MCP stdio
    (PTYs for               (injected into
   terminals)             claude --mcp-server)
```

---

## Tech Stack

| Layer | Choice | Reason |
|-------|--------|--------|
| App shell | Electron 33+ | Cross-platform, WebContentsView API for embedded browser |
| UI framework | React 19 + TypeScript | Ecosystem, Electron tooling maturity |
| Build | Vite + electron-vite | Fast HMR, good Electron integration |
| Terminal rendering | xterm.js 5 | Industry standard (VS Code, Hyper) |
| PTY | node-pty | Native PTY binding for xterm.js |
| File watching | chokidar | Watching `~/.claude/projects/` for transcript changes |
| Local DB | better-sqlite3 | Session index, metadata cache |
| MCP SDK | @modelcontextprotocol/sdk | Building the browser MCP server |
| Styling | Tailwind CSS 4 | Utility-first, good for dense terminal UIs |
| IPC | Electron contextBridge + typed channels | Type-safe main/renderer communication |

---

## Core Features

### 1. Session Detection & Indexing

**Pre-flight findings (verified on actual machine):**

The `~/.claude/projects/` directory had 119 project folders. Only 8 had a `sessions-index.json` - so that file cannot be the primary source. We scan `.jsonl` files directly.

Live sessions are tracked separately in `~/.claude/sessions/<pid>.json` - one file per running Claude process. This is cleaner and more reliable than OS process scanning.

**JSONL record structure (each line):**
```json
{
  "type": "user" | "assistant" | "attachment" | "system" | "mode" | "file-history-snapshot" | "queue-operation",
  "sessionId": "bbf5708d-...",
  "cwd": "C:\\source\\nuget.ecentria.paymentapi.client",
  "gitBranch": "DZ-3875-extract-paymentapi-client",
  "timestamp": "2026-06-04T...",
  "isMeta": false,
  "message": { "role": "user", "content": "..." | [...] }
}
```

The `cwd` field is stored directly in the JSONL - no folder name decoding needed.

**Transcript scanner** (startup + chokidar watch on `~/.claude/projects/`):
- Walk all subdirectories, find `*.jsonl` files (files can be 100KB-5MB)
- For each file: stream first ~30 lines to extract sessionId, cwd, gitBranch, first timestamp
- Stream last ~10 lines to extract last timestamp
- Extract "first real user message": `type === "user"`, `isMeta !== true`, content that doesn't start with `<command` tags, content not purely whitespace
- Message content is either a `string` or an array of parts - extract the first `{type: "text"}` part
- Store in SQLite, invalidate by (filePath + mtime) - don't re-parse unchanged files

**Live session watcher** (chokidar watch on `~/.claude/sessions/`):
- Each `<pid>.json` file represents one running Claude process
- File contains: `{ pid, sessionId, cwd, status: "idle"|"running", updatedAt, version }`
- File appears when Claude starts, disappears when it exits - no polling needed
- Match `sessionId` to transcript index to get full session metadata

**Resume command** (verified):
- `claude -r <session-uuid>` or `claude --resume <session-uuid>`
- `claude -c` continues the most recent session in the current CWD
- `--fork-session` flag available to branch a session into a new ID

**Session states:**
- `live-attached` - spawned from this app, PTY connected, session file present in `~/.claude/sessions/`
- `live-detached` - session file present but not spawned by us (e.g. running in VS Code or another terminal)
- `resumable` - has transcript JSONL, not in `~/.claude/sessions/`; show last activity + first real message
- `archived` - older than 30 days (collapsible group)

### 2. Terminal Pane System

- Grid layout: tabs + horizontal/vertical splits (similar to tmux pane model)
- Each pane is an xterm.js instance connected to a node-pty pseudoterminal
- Pane types:
  - **Shell pane**: plain shell (bash/zsh/PowerShell based on OS)
  - **Claude pane**: shell with Claude Code launched, session metadata shown in pane header
- Keyboard shortcuts: split pane, close pane, focus pane (configurable)
- Pane title shows: session project name, working directory, live/resumed indicator

### 3. Session Sidebar

Left sidebar with three sections:

```
┌─────────────────────┐
│ + New Session       │
├─────────────────────┤
│ ● LIVE              │
│   ↳ ecentria/core   │ (live-attached)
│   ↳ sql_server [!]  │ (live-detached)
├─────────────────────┤
│ ◎ RESUMABLE         │
│   ecentria/core     │ 2h ago
│   MultiAgent        │ 1d ago
│   stoneedge-vba     │ 3d ago
├─────────────────────┤
│ ▸ ARCHIVED (12)     │
└─────────────────────┘
```

Clicking a resumable session opens a new Claude pane running `claude --resume <session-id>` in the project directory.

### 4. Session Detail Panel

Expand any session to show:
- Project path
- Last user message (truncated)
- Session transcript summary (first/last N exchanges)
- Token usage estimate
- Git branch (if in a git repo)
- Quick actions: Resume, Open Folder, Copy Session ID, Delete Transcript

### 5. Session Browser

A full-screen overlay for exploring all Claude Code sessions across every directory on the machine. Opened with Cmd/Ctrl+Shift+O or from the command palette.

**Discovery scope:**

The scanner doesn't just look at `~/.claude/projects/` - it maps every entry back to the actual project directory by decoding the encoded path in the folder name (Claude Code encodes the CWD as the directory name). This gives a full picture of:
- Which directories have ever had a Claude Code session
- How many sessions exist per directory
- Which are currently live

**Layout:**

```
┌──────────────────────────────────────────────────────────────────────┐
│  Session Browser                                    [x] Close        │
├────────────────────┬─────────────────────────────────────────────────┤
│                    │                                                  │
│ Filter by:         │  ecentria/core                   ● LIVE         │
│ [All projects ▼]   │  ~/source/ecentria/core                         │
│                    │  3 sessions  •  last active 2h ago              │
│ Sort: Recent ▼     │                                                  │
│                    │  ┌──────────────────────────────────────────┐   │
│ Search sessions... │  │ ◉  2h ago   "can you update the tests"  │   │
│                    │  │ ◎  1d ago   "add error handling to the" │   │
│ ● ecentria/core    │  │ ◎  3d ago   "refactor the auth module"  │   │
│ ◎ sql_server       │  └──────────────────────────────────────────┘   │
│ ◎ MultiAgent       │                                                  │
│ ◎ stoneedge-vba    │  sql_server                      ◎ RESUMABLE    │
│ ◎ stoneedge-src    │  ~/source/sql_server                            │
│ ◎ c-projects       │  1 session  •  last active 1d ago              │
│ ◎ ...              │                                                  │
│                    │  ┌──────────────────────────────────────────┐   │
│                    │  │ ◎  1d ago   "add index to orders table"  │   │
│                    │  └──────────────────────────────────────────┘   │
│                    │                                                  │
└────────────────────┴─────────────────────────────────────────────────┘
```

**Left panel:** Project list, sorted by most recently active. Each row shows live/resumable indicator and project name. Click to filter the right panel to that project only.

**Right panel:** Sessions grouped by project. Each session row shows:
- State indicator (live ● / resumable ◎)
- Relative timestamp
- Last user message (truncated to ~60 chars)
- On hover: expand to show last 3 exchanges (user + assistant turns)
- On click: session detail drawer slides in from the right

**Session detail drawer:**

```
┌────────────────────────────────────────────────┐
│  ecentria/core                          [✕]    │
│  ~/source/ecentria/core  •  main branch        │
│  Started 3d ago  •  Last active 2h ago         │
│  ~42k tokens                                    │
│                                                 │
│  TRANSCRIPT PREVIEW                             │
│  ┌─────────────────────────────────────────┐   │
│  │ You: can you update the tests for...    │   │
│  │ Claude: I'll update the test file...    │   │
│  │ You: also fix the type errors           │   │
│  │ Claude: Found 3 type errors in...       │   │
│  │                  [Show full transcript] │   │
│  └─────────────────────────────────────────┘   │
│                                                 │
│  [Resume in new pane]  [Resume in new tab]     │
│  [Open folder]  [Copy session ID]  [Delete]    │
└────────────────────────────────────────────────┘
```

**Search:** The search box in the left panel does full-text search across all session transcripts (via SQLite FTS5). Results show which project + session matched, with the matching excerpt highlighted.

**Transcript viewer:** "Show full transcript" opens a read-only transcript pane within the browser - scrollable conversation view showing all turns, tool calls collapsed by default. No editing, just reading. Useful for reviewing what was done in an old session before deciding to resume it.

**Actions available from browser:**
- Resume in new pane (splits current pane)
- Resume in new tab
- Open project folder in Finder/Explorer
- Copy session ID to clipboard
- Delete session transcript (with confirm)

This view is entirely read-only and non-destructive except for the explicit delete action.

---

### 6. Embedded Browser + MCP Server

**MCP Browser Server** (runs in Electron main process):

Implements the MCP protocol over stdio. Exposes tools backed by Electron's `WebContentsView` API:

```typescript
// Tools exposed by the MCP server
navigate(url: string)
click(selector: string)
type(selector: string, text: string)
screenshot() -> base64 image
evaluate(js: string) -> any
get_page_content() -> string  // cleaned HTML/text
wait_for(selector: string, timeout: number)
scroll(x: number, y: number)
```

**How it's injected:**

When the app spawns a Claude Code session, it:
1. Starts the MCP server as a subprocess (or uses an already-running shared instance)
2. Writes a temporary MCP config file pointing to the server
3. Launches Claude Code with `CLAUDE_MCP_CONFIG=/tmp/multiagent-mcp.json claude`

The user sees the browser panel docked below or beside the terminal. When an agent uses a browser tool, the panel becomes visible and shows what the agent is doing.

**Browser panel states:**
- Hidden (default, no active browser tools)
- Visible + agent-controlled (dim overlay, "Agent is browsing" indicator)
- Visible + user-controlled (user clicked into it; agent is blocked until user releases)

---

## Execution Plan (Agent-Parallel)

Work is structured into phases. Within each phase, streams run in parallel - each stream owns exclusive files. No two streams touch the same file.

---

### Phase 0 - Foundation (Serial, 1 agent)

Must complete before any parallel work begins. Establishes the shared contract that all other agents code against.

**Deliverables:**
- `package.json` - all dependencies installed (electron, react, vite, xterm, node-pty, better-sqlite3, allotment, zustand, chokidar, @modelcontextprotocol/sdk, tailwind)
- `electron.vite.config.ts`, `tsconfig.json`, `tailwind.config.ts`
- `src/shared/types.ts` - the contract file. Must define:
  - `Session` (sessionId, cwd, gitBranch, projectName, firstMessage, lastMessage, lastActivity, messageCount, status: `live-attached` | `live-detached` | `resumable` | `archived`)
  - `PaneNode` (binary tree: `{ type: 'leaf', id, paneType: 'shell'|'claude', cwd, sessionId? }` | `{ type: 'split', direction: 'h'|'v', ratio, first, second }`)
  - `Tab` (id, rootNode, focusedPaneId, title)
  - `AppState` (tabs, activeTabId, sessions, sidebarOpen, sidebarWidth)
  - All IPC channel signatures as a typed map
- `src/main/index.ts` - Electron entry: creates BrowserWindow, loads renderer, sets up preload
- `src/main/preload.ts` - contextBridge exposing typed `window.ipc` object (send/on/invoke per channel)
- `src/renderer/main.tsx`, `src/renderer/App.tsx` (empty shell: sidebar placeholder left, pane area placeholder right)
- `src/renderer/store/index.ts` - Zustand store stub with `AppState` shape, no real logic yet

**Done when:** App launches, shows a split layout shell with no content, TypeScript compiles clean, all IPC channels are declared in `src/shared/types.ts`.

---

### Phase 1 - Parallel Streams (3 agents simultaneously)

Start all three after Phase 0 completes. Each stream reads `src/shared/types.ts` but never writes it.

---

#### Stream A - Main Process (1 agent)

**Owns exclusively:**
```
src/main/sessions/TranscriptScanner.ts
src/main/sessions/SessionIndex.ts
src/main/sessions/LiveSessionWatcher.ts
src/main/sessions/SessionSpawner.ts
src/main/pty/PtyManager.ts
src/main/ipc/handlers.ts
```

**Tasks:**
- `TranscriptScanner`: Walk `~/.claude/projects/`, stream first 30 + last 10 lines of each `.jsonl`. Extract sessionId, cwd, gitBranch, first real user message (skip `isMeta: true` and content starting with `<command`), first/last timestamps. Cache-key = filePath + mtime.
- `SessionIndex`: SQLite with better-sqlite3. Tables: `sessions` (all fields from `Session` type), FTS5 virtual table on `firstMessage` + `lastMessage`. Invalidate rows by mtime. Methods: `upsert`, `query`, `search(text)`, `getByProject(cwd)`.
- `LiveSessionWatcher`: Chokidar watch on `~/.claude/sessions/`. On file add/change: read pid JSON (`{pid, sessionId, cwd, status, updatedAt}`), mark matching session as `live-detached`. On file remove: revert to `resumable`. Track which sessionIds were spawned by this app (set maintained by `SessionSpawner`) to distinguish `live-attached` vs `live-detached`.
- `SessionSpawner`: Spawn `claude --resume <id>` or `claude` in a given cwd via node-pty. Returns PTY instance. Registers sessionId as app-spawned.
- `PtyManager`: Lifecycle for all PTY instances. Methods: `create(cwd, cmd[])`, `write(id, data)`, `resize(id, cols, rows)`, `kill(id)`. Emits data events back via IPC.
- `handlers.ts`: Registers all IPC handlers. Wires scanner + watcher into session state, emits `sessions:updated` to renderer on change. Handles: `pty:create`, `pty:write`, `pty:resize`, `pty:kill`, `session:resume`, `session:new`, `session:delete`, `sessions:search`.

**Does not touch:** Anything in `src/renderer/`.

---

#### Stream B - Renderer (1 agent)

**Owns exclusively:**
```
src/renderer/store/sessions.ts
src/renderer/store/panes.ts
src/renderer/components/Sidebar/
src/renderer/components/TabBar/
src/renderer/components/PaneGrid/
src/renderer/components/PaneHeader/
src/renderer/components/Terminal/
src/renderer/components/SessionBrowser/
src/renderer/components/CommandPalette/
src/renderer/hooks/
src/renderer/App.tsx  (replaces the Phase 0 shell)
```

**Tasks:**
- `store/sessions.ts`: Zustand slice. Subscribes to `sessions:updated` IPC event. Exposes `sessions`, `liveSessionIds`, `getByProject()`, `search()`.
- `store/panes.ts`: Zustand slice for tab/pane tree state. `PaneNode` binary tree operations: split, close, resize, zoom, focus. Persists to localStorage on change.
- `Sidebar`: Session list with LIVE / RECENT / ARCHIVED sections. Session rows show indicator, project name, relative timestamp. Hover tooltip with first message. Right-click context menu (Resume in new split / new tab / Open folder / Copy ID / Delete). Collapsible, resizable via drag.
- `TabBar`: Tab strip at top. Renders tabs from store. Drag to reorder, middle-click to close, + button for new tab.
- `PaneGrid`: Uses `allotment` to render the `PaneNode` binary tree. Each leaf renders a `Terminal` or placeholder. Propagates resize events to store.
- `PaneHeader`: 24px bar per pane. Icon, title (project name for Claude panes, abbreviated CWD for shell), git branch, status indicator (waiting / thinking / running tool / done), split/zoom/close buttons.
- `Terminal`: xterm.js instance in a `useEffect`. Connects to PTY via `window.ipc`. Calls `pty:create` on mount, `pty:write` on input, `pty:resize` on container resize, `pty:kill` on unmount.
- `SessionBrowser`: Full-screen overlay (Cmd+Shift+O). Left panel: project list. Right panel: sessions per project with detail drawer. Transcript preview (last 6 turns). Resume/Open/Delete actions.
- `CommandPalette`: Cmd+P overlay. Fuzzy search across sessions (calls `sessions:search` IPC) and static actions. Keyboard nav.

**Uses mock IPC during development:** `window.ipc` calls return mock data (hardcoded `Session[]`) until Phase 2 integration. Define a `src/renderer/mocks/sessions.ts` with realistic fixture data.

**Does not touch:** Anything in `src/main/`.

---

#### Stream C - MCP Browser Server (1 agent)

**Owns exclusively:**
```
src/main/mcp/BrowserMcpServer.ts
src/main/mcp/McpInjector.ts
src/main/mcp/tools/navigate.ts
src/main/mcp/tools/click.ts
src/main/mcp/tools/type.ts
src/main/mcp/tools/screenshot.ts
src/main/mcp/tools/evaluate.ts
src/main/mcp/tools/getContent.ts
src/main/mcp/tools/scroll.ts
src/main/mcp/tools/waitFor.ts
src/main/browser/BrowserViewManager.ts
src/renderer/components/BrowserPanel/
```

**Tasks:**
- `BrowserMcpServer`: Implements MCP protocol over stdio using `@modelcontextprotocol/sdk`. Registers all tools. Runs as a child process spawned by the main process.
- Each tool in `tools/`: implements the tool handler, calls into `BrowserViewManager` via IPC or direct import.
- `BrowserViewManager`: Manages a `WebContentsView` attached to the main `BrowserWindow`. Methods: `navigate(url)`, `click(selector)`, `type(selector, text)`, `screenshot()` → base64, `evaluate(js)`, `getContent()`, `scroll(x,y)`, `waitFor(selector, timeout)`. Tracks agent-controlled vs user-controlled state.
- `McpInjector`: When `SessionSpawner` spawns a Claude session, writes a temp JSON MCP config file pointing to the local server's stdio pipe, passes it via `CLAUDE_MCP_CONFIG` env var (or equivalent flag - verify exact mechanism).
- `BrowserPanel` (renderer): Shows/hides the embedded browser. "Agent is browsing" overlay when agent-controlled. Click to take user control (blocks agent). Toolbar: URL bar (read-only when agent-controlled), reload, toggle visibility.

**Does not touch:** `src/main/sessions/`, `src/main/pty/`, `src/main/ipc/handlers.ts`, `src/renderer/store/`, or any Sidebar/Terminal/PaneGrid components.

---

### Phase 2 - Integration (Serial, 1 agent)

Runs after all three Phase 1 streams complete.

**Tasks:**
- Register all `src/main/ipc/handlers.ts` handlers in `src/main/index.ts`
- Start `LiveSessionWatcher` and `TranscriptScanner` on app ready
- Replace mock IPC calls in renderer store with real `window.ipc` invocations
- Wire `SessionSpawner` into `PtyManager` - resume/new session actions create real PTYs
- Register `BrowserMcpServer` startup in main process init
- Wire `McpInjector` into `SessionSpawner.spawn()`
- End-to-end smoke test: launch app, scan sessions, resume one, verify terminal renders, verify sidebar updates live state

---

### Phase 3 - Polish (2 parallel agents)

Runs after Phase 2.

#### Stream D - App Polish (1 agent)

**Owns exclusively:**
```
src/renderer/components/Settings/
src/renderer/hooks/useKeyboardShortcuts.ts
src/main/layout/LayoutPersistence.ts
```

- Keyboard shortcut system: global `keydown` handler reading shortcut map, dispatching to store actions. Configurable via Settings.
- Settings window: shell path, default CWD, theme (dark/light), font size, sidebar default width, shortcut overrides.
- Layout persistence: on store change, serialize tab/pane tree to SQLite. On app launch, rehydrate. Claude panes restore as "Session ended" placeholders; shell panes reopen in saved CWD.

#### Stream E - Packaging (1 agent)

**Owns exclusively:**
```
electron-builder.config.ts
.github/workflows/build.yml
build/  (icons, entitlements)
```

- `electron-builder` config for Windows (NSIS installer) and macOS (DMG + zip)
- GitHub Actions CI: build matrix for win/mac, artifact upload
- macOS entitlements file for hardened runtime (needed for notarization)
- Windows code signing config stubs (actual certs added later)

---

### Phase 4 - Distribution (Serial, 1 agent)

- macOS notarization via `electron-notarize`
- Auto-update via `electron-updater` (GitHub Releases as update server)
- Release workflow: tag → build → sign → notarize → publish

---

## File Structure

Annotated with which phase/stream produces each file.

```
MultiAgent/
├── src/
│   ├── shared/
│   │   └── types.ts                        # [Phase 0] Session, PaneNode, Tab, IPC channels
│   │
│   ├── main/                               # Electron main process
│   │   ├── index.ts                        # [Phase 0] App entry, window, preload registration
│   │   ├── preload.ts                      # [Phase 0] contextBridge typed IPC
│   │   ├── ipc/
│   │   │   └── handlers.ts                 # [Stream A] Registers all IPC handlers
│   │   ├── sessions/
│   │   │   ├── TranscriptScanner.ts        # [Stream A]
│   │   │   ├── SessionIndex.ts             # [Stream A] SQLite + FTS5
│   │   │   ├── LiveSessionWatcher.ts       # [Stream A] watches ~/.claude/sessions/
│   │   │   └── SessionSpawner.ts           # [Stream A] spawns claude via node-pty
│   │   ├── pty/
│   │   │   └── PtyManager.ts               # [Stream A]
│   │   ├── mcp/
│   │   │   ├── BrowserMcpServer.ts         # [Stream C]
│   │   │   ├── McpInjector.ts              # [Stream C]
│   │   │   └── tools/                      # [Stream C] one file per MCP tool
│   │   ├── browser/
│   │   │   └── BrowserViewManager.ts       # [Stream C] WebContentsView wrapper
│   │   └── layout/
│   │       └── LayoutPersistence.ts        # [Stream D]
│   │
│   └── renderer/                           # React app
│       ├── main.tsx                        # [Phase 0]
│       ├── App.tsx                         # [Phase 0 shell → Stream B replaces]
│       ├── mocks/
│       │   └── sessions.ts                 # [Stream B] fixture data for dev
│       ├── store/
│       │   ├── index.ts                    # [Phase 0 stub → Stream B fills]
│       │   ├── sessions.ts                 # [Stream B]
│       │   └── panes.ts                    # [Stream B]
│       ├── hooks/
│       │   ├── useSessions.ts              # [Stream B]
│       │   ├── usePanes.ts                 # [Stream B]
│       │   └── useKeyboardShortcuts.ts     # [Stream D]
│       └── components/
│           ├── Sidebar/                    # [Stream B]
│           ├── TabBar/                     # [Stream B]
│           ├── PaneGrid/                   # [Stream B] allotment-based
│           ├── PaneHeader/                 # [Stream B]
│           ├── Terminal/                   # [Stream B] xterm.js wrapper
│           ├── SessionBrowser/             # [Stream B]
│           ├── CommandPalette/             # [Stream B]
│           ├── BrowserPanel/               # [Stream C]
│           └── Settings/                   # [Stream D]
│
├── build/                                  # [Stream E] icons, entitlements
├── .github/workflows/build.yml             # [Stream E]
├── electron-builder.config.ts             # [Stream E]
├── electron.vite.config.ts               # [Phase 0]
├── package.json                           # [Phase 0]
└── PLAN.md
```

---

## Key Design Decisions

**Why Electron over Tauri?**
Node.js APIs (node-pty, native addons) are far better supported in Electron. node-pty in particular requires native compilation that's simpler in Electron's Node environment. Tauri's browser engine limitations also complicate xterm.js rendering.

**Why WebContentsView over Playwright for browser MCP?**
Playwright spawns a separate browser process and communicates over CDP. WebContentsView is in-process Electron - no separate process, no CDP latency, full access to Electron's session/cookie APIs. The MCP abstraction layer means this can be swapped later without changing agent behavior.

**Why SQLite over flat file session index?**
Fast queries on project path, last-activity sort, full-text search on last messages. Chokidar handles invalidation; SQLite handles the query layer. No server process needed.

**IPC pattern:**
Main process owns all state (sessions, PTYs, MCP server). Renderer is a pure view. Typed channels via `contextBridge` prevent preload leaks. Renderer dispatches actions, main process responds with state updates.

---

## UX & Interaction Design

### Overall Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  [traffic lights]        MultiAgent                  [win controls] │  <- custom title bar / drag region
├──────────┬──────────────────────────────────────────────────────────┤
│          │  [ecentria/core ●]  [sql_server]  [shell]  [+ New]      │  <- tab bar
│ Sidebar  ├──────────────────────────────────┬───────────────────────┤
│          │                                  │                       │
│ ● LIVE   │                                  │   Pane 2              │
│  core    │          Pane 1                  │   (Shell)             │
│  sql[!]  │          (Claude session)        │                       │
│          │                                  ├───────────────────────┤
│ ◎ RECENT │                                  │                       │
│  proj1   │                                  │   Pane 3              │
│  proj2   │                                  │   (Claude session)    │
│  proj3   │                                  │                       │
│          │                                  │                       │
│ ▸ OLD(5) │                                  │                       │
└──────────┴──────────────────────────────────┴───────────────────────┘
```

### Tab Bar

Tabs represent independent pane layouts, not individual panes. Each tab can contain any number of split panes.

- Tab title shows: project name (if a Claude pane is focused in that tab), or CWD (if all shell panes)
- Live dot (●) on tab when it contains an active Claude session
- Cmd/Ctrl+T: new tab (opens a shell pane by default)
- Cmd/Ctrl+W: close active tab (prompts if Claude session is live)
- Cmd/Ctrl+Shift+]: next tab
- Cmd/Ctrl+Shift+[: prev tab
- Drag to reorder tabs
- Middle-click to close

### Pane Splitting & Navigation

The pane tree is a binary split layout (same model as tmux). Every split produces exactly two children.

**Splitting:**
- Cmd/Ctrl+D: split focused pane vertically (new pane opens to the right)
- Cmd/Ctrl+Shift+D: split focused pane horizontally (new pane opens below)
- New pane inherits CWD of the pane it split from
- Drag the divider between panes to resize; double-click divider to equalize

**Focus:**
- Click any pane to focus it
- Cmd/Ctrl+Option/Alt+Arrow: move focus in that direction
- Cmd/Ctrl+[ / ]: cycle through panes in tab order

**Zoom:**
- Cmd/Ctrl+Shift+Enter: zoom focused pane (all other panes in the tab visually collapse)
- Same shortcut again to unzoom; also unzooms when you click a collapsed pane edge

**Closing:**
- Cmd/Ctrl+Shift+W: close focused pane
- If closing a Claude pane with a live session: confirm dialog ("End session or just close pane?")
- Last pane in a tab closes the tab

### Pane Chrome

Each pane has a 24px header bar:

```
┌──────────────────────────────────────────────────────────────────┐
│ ◈  ecentria/core   main  ● thinking...          ⊟  ⊞  ✕        │
│    [icon][title]  [branch] [status]             [splits] [close] │
└──────────────────────────────────────────────────────────────────┘
```

- Left: pane type icon (terminal glyph for shell, Claude mark for Claude pane)
- Left: title - project name for Claude panes, abbreviated CWD for shell panes
- Left: git branch (read from CWD on a 5s poll, only shown if in a git repo)
- Left: status indicator for Claude panes only:
  - ● waiting for input (dim)
  - ● thinking... (animated, yellow)
  - ● running tool (animated, blue) - shows tool name
  - ● done (green, fades after 3s)
- Right: split-vertical button, split-horizontal button, close button
- Focused pane header has a visible accent border on top; unfocused panes are dimmer

### Session Sidebar

**Structure:**
```
┌────────────────────────────┐
│ ⊞ MultiAgent          [<]  │  <- collapse button
├────────────────────────────┤
│ [+ New Claude Session]     │
├────────────────────────────┤
│ ● LIVE                     │
│   ● ecentria/core          │  live-attached: solid dot
│   ◉ sql_server  [external] │  live-detached: pulsing dot + badge
├────────────────────────────┤
│ ◎ RECENT                   │
│   ecentria/core    2h ago  │
│   MultiAgent       1d ago  │
│   stoneedge-vba    3d ago  │
├────────────────────────────┤
│ ▸ ARCHIVED  (12)           │  collapsed by default
└────────────────────────────┘
```

**Width:** 220px default, resizable (min 160px, max 360px). Toggle with Cmd/Ctrl+B.

**Session rows:**
- Hover: show last message snippet as tooltip
- Single click:
  - live-attached: focus that session's pane (switch tab if needed)
  - live-detached: open new shell pane in the same directory (user can launch claude from there)
  - resumable: resume in a new pane (splits focused pane, or new tab if no panes open)
- Right-click context menu:
  - Resume in current pane
  - Resume in new split
  - Resume in new tab
  - Open folder in Finder/Explorer
  - Copy session ID
  - Delete transcript

**Search:** Cmd/Ctrl+F while sidebar is focused - inline filter that matches on project name and last message content.

### Command Palette

Cmd/Ctrl+P opens a floating fuzzy-search palette centered in the window.

**Entry types and their display:**

```
┌─────────────────────────────────────────────────────┐
│  > resume ecentria                                  │
├─────────────────────────────────────────────────────┤
│  ◎  ecentria/core            2h ago                │  <- resumable session
│     "can you update the tests for..."               │
│  ◎  ecentria/marketing       3d ago                │
│     "add a hero section to..."                      │
├─────────────────────────────────────────────────────┤
│  ⌨  New Claude session in ~/source/ecentria        │  <- action
│  ⌨  Split pane vertical                            │
│  ⌨  Settings                                       │
└─────────────────────────────────────────────────────┘
```

Session entries show: project name, relative timestamp, last user message snippet.

Keyboard actions available from palette: all split/zoom/tab operations, settings, open folder.

### Session Flows

**Starting a new session:**
1. Cmd/Ctrl+N or "New Claude Session" button
2. Palette opens to a directory picker (fuzzy search over recent dirs + bookmarks)
3. Selecting a dir: checks for recent sessions in that dir
   - If found: offer "New conversation" or "Continue most recent (Xh ago)"
   - If none: start new directly
4. Opens a new Claude pane running `claude` in the chosen directory

**Resuming a session:**
1. Click in sidebar, or Cmd/Ctrl+P -> search -> select
2. If a non-Claude pane is focused and nothing is running: offer inline toast "Resume here?" (3s timeout, defaults to new split)
3. New pane opens, runs `claude --resume <session-id>` with CWD set to project dir
4. Pane header shows "Resuming..." until Claude Code outputs its first line

**Detecting external sessions:**
- Live-detached sessions (claude running outside the app) appear in the sidebar with a pulsing indicator
- Clicking opens a new pane in the same directory with a message: "Claude is running externally in this directory. Open a shell here?"
- No PTY attachment to external processes - that is a v2 feature

### Layout Persistence

On quit, save to SQLite:
- Tab list (ordered)
- Per-tab: pane tree structure, split ratios, CWD per pane, pane type (shell/claude)
- Sidebar width, collapsed state

On relaunch:
- Shell panes: restore CWD, reopen shell
- Claude panes: show placeholder ("Session ended - [project name]") with a "Resume" button rather than auto-resuming; user opts in

### Keyboard Shortcuts Reference

| Action | macOS | Windows |
|--------|-------|---------|
| New tab | Cmd+T | Ctrl+T |
| Close tab | Cmd+W | Ctrl+W |
| Next tab | Cmd+Shift+] | Ctrl+Tab |
| Prev tab | Cmd+Shift+[ | Ctrl+Shift+Tab |
| New Claude session | Cmd+N | Ctrl+N |
| Command palette | Cmd+P | Ctrl+P |
| Toggle sidebar | Cmd+B | Ctrl+B |
| Session browser | Cmd+Shift+O | Ctrl+Shift+O |
| Split vertical | Cmd+Shift+E | Ctrl+Shift+E |
| Split horizontal | Cmd+Shift+D | Ctrl+Shift+D |
| Close pane | Cmd+Shift+W | Ctrl+Shift+W |
| Zoom pane | Cmd+Shift+Enter | Ctrl+Shift+Enter |
| Focus pane left | Cmd+Option+← | Ctrl+Alt+← |
| Focus pane right | Cmd+Option+→ | Ctrl+Alt+→ |
| Focus pane up | Cmd+Option+↑ | Ctrl+Alt+↑ |
| Focus pane down | Cmd+Option+↓ | Ctrl+Alt+↓ |

All shortcuts configurable via Settings.

### Visual Design

- **Theme:** Dark primary. Near-black background (~#0e1011), subtle borders, no harsh contrasts.
- **Accent:** Single accent color (cyan or blue-green) used only for live indicators, focus borders, and primary buttons.
- **Title bar:** Frameless window with custom drag region on macOS (native traffic lights retained). Standard frame on Windows initially.
- **Sidebar:** 1-2 shades lighter than pane area background to create depth without a hard border.
- **Active pane:** Thin top border in accent color on focused pane header; all other pane headers dim to 60% opacity.
- **Fonts:** JetBrains Mono 13px default for terminals; system UI font for all chrome (sidebar, headers, palette).
- **Scrollback:** 10,000 lines per pane.
- **xterm.js config:** Mouse events on, URL detection on (clickable), copy-on-select off (explicit Cmd/Ctrl+C).

---

## Open Questions

- Should the browser panel be a `BrowserView` (deprecated) or `WebContentsView` (Electron 28+)? Use `WebContentsView` - it's the current API and supports proper layering.
- Session resume: should the app auto-resume the most recent session in a project when you open it, or always show the session picker? Probably show picker unless there's only one.
- Multi-window support: single window with tabs, or allow multiple top-level windows? Defer to M3 feedback.
