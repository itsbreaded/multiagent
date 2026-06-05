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
┌─────────────────────────────────────────────────────────────┐
│                       Electron App                           │
│                                                              │
│  ┌──────────────┐   ┌──────────────────────────────────┐   │
│  │  Renderer    │   │          Main Process             │   │
│  │  (React UI)  │◄──►  PtyManager (IPC bridge)         │   │
│  │              │   │  SessionSpawner                   │   │
│  │  - Sidebar   │   │  TranscriptScanner                │   │
│  │  - Pane grid │   │  LiveSessionWatcher               │   │
│  │  - Terminals │   │  SessionIndex (SQLite)            │   │
│  │  - TabBar    │   │  BrowserMcpServer                 │   │
│  └──────────────┘   └──────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
          child_process.spawn(electron.exe, [ptyWorker.js],
                    { ELECTRON_RUN_AS_NODE: '1' })
                              │
          ┌───────────────────▼──────────────────┐
          │  ptyWorker (pure Node.js mode)        │
          │  node-pty pty.spawn(shell, ...)       │
          │  env: CLAUDECODE=1                    │
          │       CLAUDE_CODE_DISABLE_*           │
          └──────────────────────────────────────┘

PTY worker runs outside Chromium context so node-pty handles do not
propagate into claude.exe (a Bun binary that crashes on inherited
Chromium IPC handles). Same isolation pattern as VS Code's PTY host.
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

## Implementation Status

### Working

- **App shell** - Electron window, preload, contextBridge, typed IPC channels
- **PTY worker isolation** - `child_process.spawn(electron.exe, [ptyWorker.js], { ELECTRON_RUN_AS_NODE: '1' })` keeps node-pty handles away from Chromium; claude.exe launches correctly
- **CLAUDECODE=1** - activates claude's embedded-terminal rendering path (no alternate screen, no mouse capture, no virtual scroll)
- **Session scanning** - `TranscriptScanner` walks `~/.claude/projects/`, streams JSONL files, extracts metadata, caches by mtime in SQLite
- **Live session detection** - `LiveSessionWatcher` watches `~/.claude/sessions/` to distinguish live-attached vs live-detached sessions
- **Session index** - SQLite with FTS5, `sessions:updated` IPC push to renderer
- **Session Browser** - `Ctrl+Shift+O` or the ⊞ button in the tab bar; left project list, right session rows with expand drawer, search, "Resume in split" and "Resume in new tab" both wired to real store actions
- **Command Palette** - `Ctrl+P` or the ⌕ button in the tab bar; session fuzzy search + static actions
- **Sidebar** - session list grouped by LIVE / RECENT / ARCHIVED, collapsible, resizable drag handle, "+ Session" and "+ Shell" buttons that use the active pane's cwd
- **TabBar toolbar** - permanent ≡ (sidebar toggle), ⊞ (session browser), ⌕ (command palette) buttons so all features are discoverable without knowing hotkeys
- **Tab management** - drag to reorder, middle-click to close, + button, Ctrl+T / Ctrl+W, live dot indicator per tab
- **Pane splitting** - binary tree model via allotment, Ctrl+Shift+E (vertical), Ctrl+Shift+D (horizontal)
- **Pane zoom** - Ctrl+Shift+Enter toggles zoom on focused pane
- **MCP browser server** - `BrowserMcpServer`, `BrowserViewManager`, `McpInjector` files exist; server code is in place

### Stubbed / Incomplete

| Feature | State |
|---------|-------|
| PaneHeader status pill | Always shows "waiting" - never reads actual claude output state |
| Layout persistence | `layout:load` / `layout:save` IPC handlers registered but are no-ops |
| Command Palette "Open shell pane" action | Still calls `addTab()` instead of `addShellPane()` |
| McpInjector wiring | Files exist but `SessionSpawner.spawn()` does not call `McpInjector` |
| Session sidebar row click | Single-click does nothing - no focus/resume handler on sidebar rows |
| Right-click context menu on session rows | Not implemented |
| Session ended placeholder in Claude panes | No placeholder when session ends or on relaunch |
| Sidebar search (Ctrl+F) | Not implemented |

### Not Started

- Settings window (shell path, font size, theme, shortcut overrides)
- Layout persistence (serialize/rehydrate tab+pane tree across restarts)
- Auto-update via `electron-updater`
- GitHub Actions CI / electron-builder packaging
- macOS notarization
- Token usage display in pane header
- Full transcript viewer overlay


---

## File Structure

```
MultiAgent/
├── src/
│   ├── shared/
│   │   └── types.ts                        # Session, PaneNode, Tab, IPC channels
│   │
│   ├── main/                               # Electron main process
│   │   ├── index.ts                        # App entry, window, preload registration
│   │   ├── preload.ts                      # contextBridge typed IPC
│   │   ├── ipc/
│   │   │   └── handlers.ts                 # All IPC handler registrations
│   │   ├── sessions/
│   │   │   ├── TranscriptScanner.ts        # Walks ~/.claude/projects/, caches in SQLite
│   │   │   ├── SessionIndex.ts             # SQLite + FTS5
│   │   │   ├── LiveSessionWatcher.ts       # Watches ~/.claude/sessions/
│   │   │   └── SessionSpawner.ts           # Spawns claude / claude --resume
│   │   ├── pty/
│   │   │   ├── PtyManager.ts               # IPC bridge to ptyWorker child process
│   │   │   ├── ptyWorker.ts                # Runs as ELECTRON_RUN_AS_NODE=1 child; owns node-pty
│   │   │   └── shell.ts                    # defaultShell() helper
│   │   ├── mcp/
│   │   │   ├── BrowserMcpServer.ts         # MCP stdio server (not yet wired to sessions)
│   │   │   ├── McpInjector.ts              # Injects MCP config into spawned sessions (stub)
│   │   │   └── tools/                      # One file per MCP browser tool
│   │   └── browser/
│   │       └── BrowserViewManager.ts       # WebContentsView wrapper
│   │
│   └── renderer/                           # React app
│       ├── main.tsx
│       ├── App.tsx                         # Global keyboard shortcuts, layout shell
│       ├── store/
│       │   ├── sessions.ts                 # Zustand - session list, IPC subscription
│       │   └── panes.ts                    # Zustand - tab/pane tree, overlays
│       ├── hooks/
│       │   └── useSessions.ts              # Targeted selectors over sessions store
│       └── components/
│           ├── Sidebar/                    # Session list, + Session / + Shell buttons
│           ├── TabBar/                     # Tab strip + ≡ / ⊞ / ⌕ toolbar
│           ├── PaneGrid/                   # allotment binary tree renderer
│           ├── PaneHeader/                 # Per-pane chrome (status pill stubbed)
│           ├── Terminal/                   # xterm.js + PTY IPC wiring
│           ├── SessionBrowser/             # Ctrl+Shift+O overlay
│           └── CommandPalette/             # Ctrl+P overlay
│
├── electron.vite.config.ts               # ptyWorker compiled as separate entry point
├── package.json
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

The tab bar has three persistent zones:
- **Left:** ≡ sidebar toggle (always visible even when sidebar is collapsed)
- **Center:** tab strip - drag to reorder, middle-click to close, + for new tab
- **Right:** ⊞ session browser button, ⌕ command palette button

Tab behavior:
- Tab title shows: project name (if a Claude pane is focused in that tab), or CWD (if all shell panes)
- Live dot (●) on tab when it contains an active Claude session
- Cmd/Ctrl+T: new tab (opens a shell pane by default)
- Cmd/Ctrl+W: close active tab (prompts if Claude session is live)
- Drag to reorder tabs
- Middle-click to close

### Pane Splitting & Navigation

The pane tree is a binary split layout (same model as tmux). Every split produces exactly two children.

**Splitting:**
- Cmd/Ctrl+Shift+E: split focused pane vertically (new pane opens to the right)
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
- Left: status indicator for Claude panes only (currently stubbed - always shows "waiting"):
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
│ Sessions                   │  <- header (collapse via ≡ in tab bar)
├────────────────────────────┤
│ [+ Session]  [+ Shell]     │  <- new session / new shell pane buttons
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

- Session resume: should the app auto-resume the most recent session in a project when you open it, or always show the session picker? Probably show picker unless there's only one.
- Multi-window support: single window with tabs, or allow multiple top-level windows? Deferred.
- Status pill: parse claude's output stream to detect state (thinking / running tool / idle), or use a separate IPC channel from the main process? Currently stubbed as "waiting".
- Layout persistence format: store the full pane tree in SQLite on every change, or only on quit? SQLite seems right but schema needs design.
