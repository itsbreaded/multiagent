// Session status
export type SessionStatus = 'live-attached' | 'resumable' | 'archived'

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
}

// Pane tree - binary split layout (same model as tmux)
export type PaneType = 'shell' | 'claude'

export interface PaneLeaf {
  type: 'leaf'
  id: string
  paneType: PaneType
  cwd: string
  sessionId?: string    // set when paneType === 'claude'
  ptyId?: string        // set once PTY is created
  title?: string        // programmatic display override (full)
  customName?: string   // user-set label prefix shown before the directory name
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
  rootNode?: PaneNode   // undefined = empty tab showing landing page
  focusedPaneId: string
  customLabel?: string  // user-set via rename; overrides auto-generated label when present
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

  // Main pushes CWD changes to renderer (parsed from OSC 7 sequences)
  'pty:cwd': (ptyId: string, cwd: string) => void

  // --- Shell ---
  'shell:open-folder': (path: string) => void
  'shell:copy-to-clipboard': (text: string) => void

  // --- Layout persistence ---
  'layout:save': (tabs: Tab[], sidebarWidth: number, sidebarOpen: boolean) => void
  'layout:load': () => { tabs: Tab[]; sidebarWidth: number; sidebarOpen: boolean } | null

  // --- Session detection ---
  // Main notifies renderer when a new claude session file is detected for a spawned PTY
  'session:detected': (ptyId: string, sessionId: string) => void

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
  | 'pty:cwd'
  | 'session:detected'
  | 'browser:agent-active'
