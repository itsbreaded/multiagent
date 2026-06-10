// Session status
export type SessionStatus = 'live-attached' | 'resumable'

export type AgentKind = 'claude' | 'codex'

// A CLI agent session as stored/displayed
export interface Session {
  agentKind: AgentKind
  sessionId: string           // UUID from JSONL
  cwd: string                 // actual project path e.g. C:\source\ecentria\core
  projectName: string         // derived: last 2 path segments e.g. "ecentria/core"
  displayName: string | null
  gitBranch: string | null
  firstMessage: string | null // first real user-typed message (not slash commands)
  lastMessage: string | null  // last real user-typed message
  firstActivity: string | null // ISO timestamp
  lastActivity: string | null  // ISO timestamp
  messageCount: number
  transcriptPath: string
  status: SessionStatus
}

// Pane tree - binary split layout (same model as tmux)
export type PaneType = 'shell' | 'agent'

export interface PaneLeaf {
  type: 'leaf'
  id: string
  paneType: PaneType
  agentKind?: AgentKind  // set when paneType === 'agent'
  cwd: string
  sessionId?: string    // set when paneType === 'agent'
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
  defaultCwd?: string   // tab-scoped starting directory for new panes
}

// Full app state shape (used by renderer Zustand store)
export interface AppState {
  tabs: Tab[]
  activeTabId: string
  sessions: Session[]
  sidebarOpen: boolean
  sidebarWidth: number   // px
  sidebarSectionOpen: Record<string, boolean>
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
  'sessions:delete': (agentKind: AgentKind, sessionId: string) => void

  // --- Session actions ---
  // Start a new agent session in a given cwd
  'session:new': (agentKind: AgentKind, cwd: string) => { ptyId: string; sessionId: string | null }

  // Resume an existing session by ID
  'session:resume': (agentKind: AgentKind, sessionId: string, cwd: string) => { ptyId: string }

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
  'pty:data': (ptyId: string, seq: number, data: string) => void

  // Renderer acknowledges PTY output after xterm has parsed it
  'pty:data-ack': (ptyId: string, seq: number) => void

  // Renderer is ready to receive PTY output for a mounted terminal
  'pty:attach': (ptyId: string) => void

  // Renderer terminal was unmounted; stop waiting on outstanding acks
  'pty:detach': (ptyId: string) => void

  // Main pushes CWD changes to renderer (parsed from OSC 7 sequences)
  'pty:cwd': (ptyId: string, cwd: string) => void

  // --- Shell ---
  'shell:open-folder': (path: string) => void
  'shell:copy-to-clipboard': (text: string) => void
  'shell:open-vscode': (cwd: string) => void
  'shell:vscode-available': () => boolean

  // --- Git ---
  'git:branch': (cwd: string) => string | null

  // --- Dialogs ---
  'dialog:pick-directory': (title?: string) => string | null

  // --- Layout persistence ---
  'layout:save': (tabs: Tab[], sidebarWidth: number, sidebarOpen: boolean, activeTabId: string, sidebarSectionOpen: Record<string, boolean>) => void
  'layout:load': () => { tabs: Tab[]; sidebarWidth: number; sidebarOpen: boolean; activeTabId?: string; sidebarSectionOpen?: Record<string, boolean>; tabSectionOpen?: Record<string, boolean> } | null

  // --- Session detection ---
  // Main notifies renderer when a new agent session file is detected for a spawned PTY
  'session:detected': (ptyId: string, agentKind: AgentKind, sessionId: string) => void

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
  | 'shell:open-vscode'
  | 'shell:vscode-available'
  | 'git:branch'
  | 'layout:save'
  | 'layout:load'
  | 'dialog:pick-directory'

export type EventChannels =
  | 'sessions:updated'
  | 'pty:data'
  | 'pty:cwd'
  | 'session:detected'

export type SendChannels =
  | 'pty:data-ack'
  | 'pty:attach'
  | 'pty:detach'
