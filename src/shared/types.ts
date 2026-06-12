// Session status
export type SessionStatus = 'live-attached' | 'resumable'

// MCP server configuration
export type McpServerType = 'http' | 'sse' | 'stdio'

export interface McpServerEntry {
  id: string
  name: string
  enabled: boolean
  type: McpServerType
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpSettings {
  builtinBrowserEnabled: boolean
  customServers: McpServerEntry[]
}

export interface McpStatus {
  port: number | null
  running: boolean
  tools: string[]
}

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
  detached?: boolean    // true while this tab is living in a separate window
}

export interface TabStateSyncPayload {
  windowId: number
  tabs: Tab[]
  activeTabId?: string
  version: number
}

// Full app state shape (used by renderer Zustand store)
export interface AppState {
  tabs: Tab[]
  activeTabId: string
  sessions: Session[]
  sidebarOpen: boolean
  sidebarWidth: number   // px
  sidebarPanelSizes?: Record<string, number> // px by stable sidebar panel id
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
  'pty:data': (ptyId: string, data: string) => void

  // Main pushes CWD changes to renderer (parsed from OSC 7 sequences)
  'pty:cwd': (ptyId: string, cwd: string) => void

  // --- Shell ---
  'shell:open-folder': (path: string) => void
  'shell:open-external': (url: string) => void
  'shell:copy-to-clipboard': (text: string) => void
  'shell:open-vscode': (cwd: string) => void
  'shell:vscode-available': () => boolean

  // --- Git ---
  'git:branch': (cwd: string) => string | null

  // --- Dialogs ---
  'dialog:pick-directory': (title?: string, defaultPath?: string) => string | null

  // --- Layout persistence ---
  'layout:save': (tabs: Tab[], sidebarWidth: number, sidebarOpen: boolean, activeTabId: string, sidebarSectionOpen: Record<string, boolean>, sidebarPanelSizes?: Record<string, number>) => void
  'layout:load': () => { tabs: Tab[]; sidebarWidth: number; sidebarOpen: boolean; sidebarBottomHeight?: number; sidebarPanelSizes?: Record<string, number>; activeTabId?: string; sidebarSectionOpen?: Record<string, boolean>; tabSectionOpen?: Record<string, boolean> } | null

  // --- MCP ---
  'mcp:get-status': () => McpStatus
  'mcp:get-settings': () => McpSettings
  'mcp:save-settings': (settings: McpSettings) => void
  'mcp:probe-stdio': (command: string, args: string[], env?: Record<string, string>) => { tools: string[] }

  // --- Session detection ---
  // Main notifies renderer when a new agent session file is detected for a spawned PTY
  'session:detected': (ptyId: string, agentKind: AgentKind, sessionId: string) => void

  // --- Multi-window: window identity / init ---
  'window:get-id': () => number | null
  'window:get-init-data': () => { mode: 'detached'; tab: Tab; ptyIds: string[] } | null
  'window:get-all-bounds': () => { id: number; x: number; y: number; width: number; height: number }[]
  'window:snap-apply': (targetWindowId: number, side: 'left' | 'right' | 'top' | 'bottom') => void
  'window:snap-zones': (zones: { targetWindowId: number; side: string; x: number; y: number; width: number; height: number }[]) => void

  // --- Multi-window: tab transfer ---
  // Renderer asks main to create a detached window carrying a tab
  'tab:tear-off': (tabJson: string, ptyIds: string[], screenX: number, screenY: number) => { windowId: number }
  // New window tells main it owns these PTY IDs (routes data here)
  'tab:adopt': (ptyIds: string[]) => void
  // Renderer asks main to absorb a tab dragged from sourceWindowId
  'tab:absorb': (tabJson: string, ptyIds: string[], sourceWindowId: number) => boolean
  // Main pushes to source window: remove the tab that was absorbed by another window
  'tab:release': (tabId: string, ownerWindowId?: number) => void

  // --- Multi-window: live sync & pane transfer ---
  // Detached window pushes its full tab list to main; main forwards to all other windows
  'tab:state-sync': (payload: TabStateSyncPayload) => void
  // Renderer asks main to move a pane (with its PTY) to a tab in another window
  'pane:transfer': (paneJson: string, targetTabId: string) => boolean
  // Main tells target window a pane is arriving
  'pane:received': (paneJson: string, targetTabId: string, transferId?: string) => void
  // Renderer asks main to bring a detached tab back to this window
  'tab:bring-home': (tabId: string) => boolean

  // Renderer asks main to focus the window owning a tab AND activate a specific pane
  'window:focus-pane': (tabId: string, paneId: string) => boolean
  // Main tells a window's renderer to activate a tab/pane (cross-window pane click)
  'pane:focus-remote': (tabId: string, paneId: string, requestId?: string) => void

}

// Helper type for extracting invoke vs event channels
// (used in preload.ts to type window.ipc correctly)
export type InvokeChannels =
  | 'sessions:search'
  | 'sessions:delete'
  | 'session:new'
  | 'session:resume'
  | 'pty:create'
  | 'pty:resize'
  | 'pty:kill'
  | 'shell:open-folder'
  | 'shell:open-external'
  | 'shell:copy-to-clipboard'
  | 'shell:open-vscode'
  | 'shell:vscode-available'
  | 'git:branch'
  | 'layout:save'
  | 'layout:load'
  | 'dialog:pick-directory'
  | 'mcp:get-status'
  | 'mcp:get-settings'
  | 'mcp:save-settings'
  | 'mcp:probe-stdio'
  | 'window:get-id'
  | 'window:get-init-data'
  | 'window:get-all-bounds'
  | 'window:snap-apply'
  | 'tab:tear-off'
  | 'tab:adopt'
  | 'tab:absorb'
  | 'window:focus-for-tab'
  | 'pane:transfer'
  | 'tab:bring-home'
  | 'window:focus-pane'

export type EventChannels =
  | 'sessions:updated'
  | 'pty:data'
  | 'pty:cwd'
  | 'session:detected'
  | 'window:snap-zones'
  | 'tab:release'
  | 'tab:return'
  | 'tab:state-sync'
  | 'pane:received'
  | 'pane:focus-remote'
  // Immediate focus-change notification (bypasses the debounced tab:state-sync)
  | 'pane:focus-changed'
  // Broadcast by main whenever a BrowserWindow gains OS focus
  | 'window:became-active'

export type SendChannels =
  | 'pty:write'
  | 'tab:state-sync'
  | 'pane:focus-changed'
  | 'pane:received-applied'
  | 'pane:focus-remote-applied'

export interface IpcBridge {
  invoke(channel: InvokeChannels, ...args: unknown[]): Promise<unknown>
  on(channel: EventChannels, handler: (...args: unknown[]) => void): () => void
  send(channel: SendChannels, ...args: unknown[]): void
}
