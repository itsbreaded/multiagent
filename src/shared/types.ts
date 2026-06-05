// Session status
export type SessionStatus = 'live-attached' | 'live-detached' | 'resumable' | 'archived'

// A Claude Code session as stored/displayed
export interface Session {
  sessionId: string           // UUID from JSONL
  cwd: string                 // actual project path e.g. C:\source\ecentria\core
  projectName: string         // derived: last 2 path segments e.g. "ecentria/core"
  gitBranch: string | null
  firstMessage: string | null // first real user-typed message (not slash commands)
  lastMessage: string | null  // last real user-typed message
  firstActivity: string | null // ISO timestamp
  lastActivity: string | null  // ISO timestamp
  messageCount: number
  status: SessionStatus
  // for live sessions
  pid?: number
  liveStatus?: 'idle' | 'running'  // from ~/.claude/sessions/<pid>.json
}

// Pane tree - binary split layout (same model as tmux)
export type PaneType = 'shell' | 'claude'

export interface PaneLeaf {
  type: 'leaf'
  id: string
  paneType: PaneType
  cwd: string
  sessionId?: string   // set when paneType === 'claude'
  ptyId?: string       // set once PTY is created
  title?: string       // display override
}

export type SplitDirection = 'horizontal' | 'vertical'

export interface PaneSplit {
  type: 'split'
  id: string
  direction: SplitDirection
  ratio: number        // 0-1, size of first child
  first: PaneNode
  second: PaneNode
}

export type PaneNode = PaneLeaf | PaneSplit

// A tab contains a pane tree
export interface Tab {
  id: string
  rootNode: PaneNode
  focusedPaneId: string
}

// Full app state shape (used by renderer Zustand store)
export interface AppState {
  tabs: Tab[]
  activeTabId: string
  sessions: Session[]
  sidebarOpen: boolean
  sidebarWidth: number   // px
  zoomedPaneId: string | null
  sessionBrowserOpen: boolean
  commandPaletteOpen: boolean
}

// IPC channel definitions
// Channels prefixed with direction:
//   invoke: renderer calls main, gets a Promise back
//   on: main pushes to renderer (event)
//   send: renderer fires and forgets to main

export interface IPCChannels {
  // --- Sessions ---
  // Main pushes full session list whenever it changes
  'sessions:updated': (sessions: Session[]) => void

  // Renderer invokes search (FTS5)
  'sessions:search': (query: string) => Session[]

  // Renderer asks to delete a transcript
  'sessions:delete': (sessionId: string) => void

  // --- Session actions ---
  // Start a new claude session in a given cwd
  'session:new': (cwd: string) => { ptyId: string; sessionId: string | null }

  // Resume an existing session by ID
  'session:resume': (sessionId: string, cwd: string) => { ptyId: string }

  // --- PTY ---
  // Create a PTY (for shell panes)
  'pty:create': (cwd: string) => { ptyId: string }

  // Write data to a PTY
  'pty:write': (ptyId: string, data: string) => void

  // Resize a PTY
  'pty:resize': (ptyId: string, cols: number, rows: number) => void

  // Kill a PTY
  'pty:kill': (ptyId: string) => void

  // Main pushes PTY output to renderer
  'pty:data': (ptyId: string, data: string) => void

  // --- Shell ---
  'shell:open-folder': (path: string) => void
  'shell:copy-to-clipboard': (text: string) => void

  // --- Layout persistence ---
  'layout:save': (tabs: Tab[], sidebarWidth: number, sidebarOpen: boolean) => void
  'layout:load': () => { tabs: Tab[]; sidebarWidth: number; sidebarOpen: boolean } | null

  // --- Browser panel (MCP) ---
  // Renderer shows/hides browser panel
  'browser:toggle': () => void
  // Main notifies renderer that an agent is using the browser
  'browser:agent-active': (active: boolean) => void
}

// Helper type for extracting invoke vs event channels
// (used in preload.ts to type window.ipc correctly)
export type InvokeChannels =
  | 'sessions:search'
  | 'sessions:delete'
  | 'session:new'
  | 'session:resume'
  | 'pty:create'
  | 'pty:write'
  | 'pty:resize'
  | 'pty:kill'
  | 'shell:open-folder'
  | 'shell:copy-to-clipboard'
  | 'layout:save'
  | 'layout:load'
  | 'browser:toggle'

export type EventChannels =
  | 'sessions:updated'
  | 'pty:data'
  | 'browser:agent-active'
