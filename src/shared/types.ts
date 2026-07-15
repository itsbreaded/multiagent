// Auto-updater status pushed from main to renderer
export type UpdaterStatus =
  | { state: 'available'; version: string }
  | { state: 'preparing'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'up-to-date' }
  | { state: 'error' }

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

export interface EnvVarEntry {
  id: string
  key: string
  value: string
  enabled: boolean
}

export type ClaudeProviderPreset = 'native' | 'deepseek' | 'alibaba' | 'custom'
export type CodexProviderPreset  = 'native' | 'alibaba-token' | 'alibaba-payg' | 'custom'
export type CodexWireApi = 'responses' | 'chat'

export interface ClaudeProviderConfig {
  enabled: boolean
  preset: ClaudeProviderPreset
  baseUrl: string                  // ANTHROPIC_BASE_URL
  authToken: string                // ANTHROPIC_AUTH_TOKEN (masked in UI)
  model: string                    // ANTHROPIC_MODEL
  opusModel: string                // ANTHROPIC_DEFAULT_OPUS_MODEL
  sonnetModel: string              // ANTHROPIC_DEFAULT_SONNET_MODEL
  haikuModel: string               // ANTHROPIC_DEFAULT_HAIKU_MODEL
  subagentModel: string            // CLAUDE_CODE_SUBAGENT_MODEL
  effortLevel: string              // CLAUDE_CODE_EFFORT_LEVEL
  extraEnvVars: EnvVarEntry[]
}

export interface CodexProviderConfig {
  enabled: boolean
  preset: CodexProviderPreset
  providerName: string             // TOML section key
  model: string
  baseUrl: string
  envKey: string                   // env_key in TOML (e.g. "OPENAI_API_KEY")
  apiKey: string                   // injected as env var (masked in UI)
  wireApi: CodexWireApi
  extraEnvVars: EnvVarEntry[]
}

export interface AgentProviderSettings {
  claude: ClaudeProviderConfig
  codex: CodexProviderConfig
  // Per-preset drafts keep provider-specific credentials and overrides intact
  // while `claude` / `codex` remain the active runtime configurations.
  claudePresets?: Partial<Record<ClaudeProviderPreset, ClaudeProviderConfig>>
  codexPresets?: Partial<Record<CodexProviderPreset, CodexProviderConfig>>
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
  cwdExists: boolean          // false when cwd no longer exists on disk
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

export interface SessionRepairCwdResult {
  ok: boolean
  sessions: Session[]
  mapping?: CwdRepairMapping
  layoutUpdated?: boolean
  layoutAffectedCount?: number
  error?: string
}

export interface CwdRepairMapping {
  oldCwd: string
  newCwd: string
}

export interface SessionSearchRequest {
  query: string
  mode?: 'summary' | 'deep'
  agentKinds?: AgentKind[]
  cwd?: string
  limit?: number
  matchesPerSession?: number
  caseSensitive?: boolean
  regex?: boolean
}

export interface SessionSearchMatch {
  transcriptPath: string
  lineNumber: number
  timestamp: string | null
  role: 'user' | 'assistant' | 'tool' | 'system' | 'unknown'
  snippet: string
}

export interface SessionSearchResult {
  session: Session
  score: number
  matchCount: number
  matches: SessionSearchMatch[]
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
  agentDisconnected?: {
    exitCode: number | null
    signal?: number
    at: number
  }
  resumeError?: string  // set when a restored agent session failed to resume
  sessionDetectionState?: 'pending' | 'detected' | 'failed'
  sessionDetectionStartedAt?: number
  sessionDetectionCwd?: string
  sessionDetectionError?: string
  title?: string        // programmatic display override (full)
  customName?: string   // user-set label prefix shown before the directory name
  // In-memory only: true when this pane was promoted from a shell pane because a CLI
  // agent (claude/codex) was detected running in its process tree (spec 047). Only panes
  // with this flag demote back to a shell when the agent exits; native (app-spawned)
  // agent panes never set it and keep their exit/resume behavior. NOT serialized — strip
  // it before writing layout.json (a phase-1-only promotion with no sessionId reverts to
  // a shell on restart via applyLayout's sanitizeNode).
  promotedFromShell?: boolean
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

export interface FocusTarget {
  windowId: number
  tabId: string
  paneId: string
  version: number
}

export interface PaneTransferPayload {
  pane: PaneLeaf
  sourceTabId: string
  sourceWindowId: number
  targetTabId: string
  targetWindowId?: number
}

export interface PaneSplitTransferPayload {
  pane: PaneLeaf
  sourceTabId: string
  sourceWindowId: number
  targetPaneId: string
  direction: SplitDirection
  sourceBefore: boolean
  targetWindowId: number
}

export interface PaneSwapTransferPayload {
  sourcePane: PaneLeaf
  sourceTabId: string
  sourceWindowId: number
  targetPane: PaneLeaf
  targetTabId: string
  targetWindowId: number
}

export interface SpawnInTabPayload {
  paneType: PaneType
  agentKind?: AgentKind
  cwd: string
  direction: SplitDirection
}

export interface PtyReadyMetadata {
  pid: number | null
  cwd: string
  windowsPty?: {
    backend: 'conpty'
    buildNumber: number
  }
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
  'layout:cwd-repaired': (mapping: CwdRepairMapping) => void

  // Renderer invokes summary search (FTS5 over metadata)
  'sessions:search': (query: string) => Session[]

  // Renderer invokes deep search across full transcript content
  'sessions:search-deep': (request: SessionSearchRequest) => SessionSearchResult[]

  // Renderer asks to delete a transcript
  'sessions:delete': (agentKind: AgentKind, sessionId: string) => void

  // Renderer repairs every indexed session that belongs to an old working directory.
  // Claude repair also copies/merges the matching ~/.claude/projects directory.
  'sessions:repair-cwd': (oldCwd: string, newCwd: string) => SessionRepairCwdResult

  // Renderer asks main to rescan transcripts immediately
  'sessions:refresh': () => Session[]

  // Renderer tries to recover a pane whose session detection was pending during shutdown
  'sessions:recover-pending': (agentKind: AgentKind, cwd: string, startedAt: number) => string | null

  // Renderer validates that a session transcript exists before resuming
  'sessions:validate': (agentKind: AgentKind, sessionId: string, cwd: string) => {
    found: boolean
    cwdMatch: boolean
    transcriptPath: string | null
    transcriptCwd: string | null
  }

  // --- Session actions ---
  // Start a new agent session in a given cwd
  'session:new': (agentKind: AgentKind, cwd: string) => { ptyId: string; sessionId: string | null; detectionStartedAt?: number }

  // Resume an existing session by ID
  'session:resume': (agentKind: AgentKind, sessionId: string, cwd: string) => { ptyId: string }

  // --- PTY ---
  // Create a PTY (for shell panes)
  'pty:create': (cwd: string, cols?: number, rows?: number) => { ptyId: string }

  // Fetch cached ready metadata in case the live pty:ready event was missed
  'pty:get-ready': (ptyId: string) => PtyReadyMetadata | null

  // Write data to a PTY
  'pty:write': (ptyId: string, data: string) => void

  // Resize a PTY
  'pty:resize': (ptyId: string, cols: number, rows: number) => void

  // Kill a PTY
  'pty:kill': (ptyId: string) => void

  // Main pushes PTY output to renderer. seq is always 0 (direct relay; the
  // byteLength arg is retained for the channel shape but no longer acked).
  'pty:data': (ptyId: string, data: string, seq: number, byteLength: number) => void

  // Main notifies renderer when the PTY process is ready
  'pty:ready': (ptyId: string, event: PtyReadyMetadata) => void

  // Main notifies renderer when a PTY exits
  'pty:exit': (ptyId: string, exitCode: number | null, signal?: number) => void

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
  'git:unwatch-branch': (cwd: string) => void
  'git:branch-updated': (cwdKeys: string[], branch: string | null) => void

  // --- Dialogs ---
  'dialog:pick-directory': (title?: string, defaultPath?: string) => string | null

  // --- Recent directories ---
  'dirs:recent-get': () => string[]
  'dirs:recent-add': (dir: string) => void

  // --- Layout persistence ---
  'layout:save': (tabs: Tab[], sidebarWidth: number, sidebarOpen: boolean, activeTabId: string, sidebarSectionOpen: Record<string, boolean>, sidebarPanelSizes?: Record<string, number>) => void
  'layout:load': () => { tabs: Tab[]; sidebarWidth: number; sidebarOpen: boolean; sidebarBottomHeight?: number; sidebarPanelSizes?: Record<string, number>; activeTabId?: string; sidebarSectionOpen?: Record<string, boolean>; tabSectionOpen?: Record<string, boolean> } | null

  // Shutdown state collection: main requests renderer state for a final authoritative save
  // Main sends requestId; renderer responds via layout:state-response / layout:detached-state-response
  'layout:request-state': (requestId: string) => void
  'layout:collect-detached-state': (requestId: string) => void
  'layout:state-response': (requestId: string, state: unknown) => void
  'layout:detached-state-response': (requestId: string, snapshot: unknown) => void

  // --- MCP ---
  'mcp:get-status': () => McpStatus
  'mcp:get-settings': () => McpSettings
  'mcp:save-settings': (settings: McpSettings) => void
  'mcp:probe-stdio': (command: string, args: string[], env?: Record<string, string>) => { tools: string[] }

  // --- Agent provider configuration ---
  'settings:get-agent-providers': () => AgentProviderSettings
  'settings:save-agent-providers': (settings: AgentProviderSettings) => void

  // --- CLI session linking (spec 047 phase 3) ---
  // Opt-in managed Claude SessionStart hook that reports session ids for CLI-launched
  // (promoted) agents. Main is the authority for the hook install + env injection.
  'settings:get-cli-session-linking': () => boolean
  'settings:set-cli-session-linking': (enabled: boolean) => boolean

  // --- GPU / renderer diagnostics ---
  // Renderer asks main for Chromium's GPU feature status. Used to corroborate
  // the renderer-side WebGL probe (primary signal); never on the critical path.
  'gpu:feature-status': () => { softwareOnly: boolean; featureStatus: Record<string, string> }

  // --- Session detection ---
  // Main notifies renderer when a new agent session file is detected for a spawned PTY
  'session:detected': (ptyId: string, agentKind: AgentKind, sessionId: string) => void
  'session:detection-failed': (ptyId: string, agentKind: AgentKind, reason: string, mode: 'new' | 'resume') => void
  // Main notifies renderer that a CLI-launched agent was detected in (or has exited from)
  // a shell pane's process tree (spec 047). agentKind non-null = promote the shell pane to
  // an agent pane; null = demote a previously-promoted pane back to a shell.
  'pane:agent-detected': (ptyId: string, agentKind: AgentKind | null) => void

  // --- Multi-window: window identity / init ---
  'window:get-id': () => number | null
  'window:get-init-data': () => { mode: 'detached'; tab: Tab; ptyIds: string[] } | null
  'window:get-all-bounds': () => { id: number; x: number; y: number; width: number; height: number }[]
  'window:minimize': () => void
  'window:toggle-maximize': () => boolean
  'window:close': () => void
  'window:is-maximized': () => boolean
  'window:start-drag': () => void
  'window:snap-apply': (targetWindowId: number, side: 'left' | 'right' | 'top' | 'bottom') => void
  'window:snap-zones': (zones: { targetWindowId: number; side: string; x: number; y: number; width: number; height: number }[]) => void
  'window:maximized-changed': (isMaximized: boolean) => void
  'window:focus-state-request': () => void
  'window:focus-for-tab': (tabId: string) => boolean
  'window:became-active': (windowId: number) => void

  // --- Multi-window: tab transfer ---
  // Renderer asks main to create a detached window carrying a tab
  'tab:tear-off': (tabJson: string, ptyIds: string[], screenX: number, screenY: number) => { windowId: number }
  // New window tells main it owns these PTY IDs (routes data here)
  'tab:adopt': (ptyIds: string[]) => boolean
  // Renderer asks main to absorb a tab dragged from sourceWindowId
  'tab:absorb': (tabJson: string, ptyIds: string[], sourceWindowId: number) => boolean
  // Main pushes to source window: remove the tab that was absorbed by another window
  'tab:release': (tabId: string, ownerWindowId?: number, releaseId?: string) => void
  // Main confirms to the source window that an absorb committed (PTYs transferred); only now
  // may the source finalize removal/detach of the released tab. Mirrors pane:remove-remote.
  'tab:absorb-committed': (tabId: string, ownerWindowId?: number) => void
  'tab:return': (tabId: string) => void
  'tab:detached-ready': (tabId: string) => void
  'tab:release-applied': (releaseId: string) => void

  // --- Multi-window: live sync & pane transfer ---
  // Detached window pushes its full tab list to main; main forwards to all other windows
  'tab:state-sync': (payload: TabStateSyncPayload) => void
  // Renderer asks main to move a pane (with its PTY) to a tab in another window
  'pane:transfer': (payload: PaneTransferPayload) => boolean
  // Renderer asks main to move a pane to a directional split in another window/tab
  'pane:split-transfer': (payload: PaneSplitTransferPayload) => boolean
  // Renderer asks main to swap two panes across windows
  'pane:swap-transfer': (payload: PaneSwapTransferPayload) => boolean
  // Main tells target window a pane is arriving
  'pane:received': (paneJson: string, targetTabId: string, transferId?: string) => void
  'pane:remove-remote': (paneId: string) => void
  // Main tells the target window to discard a pane it optimistically added via pane:received
  // because the transfer never committed (ack timeout / window destroyed). Avoids a dead pane.
  'pane:transfer-rolledback': (paneId: string) => void
  'pane:move-remote': (paneId: string, targetTabId: string) => void
  // Main tells a window to remove a pane leaf (move, not close — PTY stays alive)
  'renderer:remove-pane': (paneId: string) => void
  // Main tells target window to insert a pane next to targetPaneId at the given split direction
  'renderer:insert-at-split': (paneJson: string, targetPaneId: string, direction: SplitDirection, sourceBefore: boolean, transferId?: string) => void
  // Main tells a window to replace a pane leaf (for cross-window swap)
  'renderer:replace-pane': (paneId: string, replacementJson: string, transferId?: string) => void
  // Renderer asks main to bring a detached tab back to this window
  'tab:bring-home': (tabId: string) => boolean
  // Detached window asks main to reattach (move) one of its own tabs back to the primary window
  'tab:reattach-home': (tabId: string) => boolean

  // --- Auto-updater ---
  'updater:status': (status: UpdaterStatus) => void
  'updater:install': () => void
  'updater:check': () => void
  'updater:get-version': () => string
  'updater:is-enabled': () => boolean
  'updater:set-enabled': (enabled: boolean) => void
  'updater:download': () => void

  // Renderer asks main to focus the window owning a tab AND activate a specific pane
  'window:focus-pane': (tabId: string, paneId: string) => boolean
  // Renderer asks main to spawn in the window owning a detached tab
  'tab:spawn-in-project': (tabId: string, payload: SpawnInTabPayload) => boolean
  // Main tells the owning renderer to spawn in one of its tabs
  'tab:spawn-in-project-remote': (tabId: string, payload: SpawnInTabPayload, requestId: string) => void
  // Main tells a window's renderer to activate a tab/pane (cross-window pane click)
  'pane:focus-remote': (tabId: string, paneId: string, requestId?: string) => void
  'focus:target-changed': (target: FocusTarget) => void
  'pane:focus-changed': (windowId: number, tabId: string, paneId: string) => void
  'focus:target-report': (tabId: string, paneId: string) => void
  'pane:received-applied': (transferId: string) => void
  'pane:focus-remote-applied': (requestId: string) => void
  'tab:spawn-in-project-applied': (requestId: string, ok: boolean) => void
  'renderer:insert-at-split-applied': (transferId: string) => void
  'renderer:replace-pane-applied': (transferId: string) => void

}

// Helper type for extracting invoke vs event channels
// (used in preload.ts to type window.ipc correctly)
type ChannelSubset<K extends keyof IPCChannels> = K

export type InvokeChannels = ChannelSubset<
  | 'sessions:search'
  | 'sessions:search-deep'
  | 'sessions:delete'
  | 'sessions:repair-cwd'
  | 'sessions:refresh'
  | 'sessions:recover-pending'
  | 'sessions:validate'
  | 'session:new'
  | 'session:resume'
  | 'pty:create'
  | 'pty:get-ready'
  | 'pty:kill'
  | 'shell:open-folder'
  | 'shell:open-external'
  | 'shell:copy-to-clipboard'
  | 'shell:open-vscode'
  | 'shell:vscode-available'
  | 'git:branch'
  | 'git:unwatch-branch'
  | 'layout:save'
  | 'layout:load'
  | 'dialog:pick-directory'
  | 'dirs:recent-get'
  | 'dirs:recent-add'
  | 'mcp:get-status'
  | 'mcp:get-settings'
  | 'mcp:save-settings'
  | 'mcp:probe-stdio'
  | 'settings:get-agent-providers'
  | 'settings:save-agent-providers'
  | 'settings:get-cli-session-linking'
  | 'settings:set-cli-session-linking'
  | 'gpu:feature-status'
  | 'updater:check'
  | 'updater:get-version'
  | 'updater:is-enabled'
  | 'window:get-id'
  | 'window:get-init-data'
  | 'window:get-all-bounds'
  | 'window:minimize'
  | 'window:toggle-maximize'
  | 'window:close'
  | 'window:is-maximized'
  | 'window:start-drag'
  | 'window:snap-apply'
  | 'tab:tear-off'
  | 'tab:adopt'
  | 'tab:absorb'
  | 'window:focus-for-tab'
  | 'pane:transfer'
  | 'tab:bring-home'
  | 'tab:reattach-home'
  | 'window:focus-pane'
  | 'tab:spawn-in-project'
  | 'pane:split-transfer'
  | 'pane:swap-transfer'>

export type EventChannels = ChannelSubset<
  | 'sessions:updated'
  | 'git:branch-updated'
  | 'layout:cwd-repaired'
  | 'pty:data'
  | 'pty:ready'
  | 'pty:exit'
  | 'pty:cwd'
  | 'session:detected'
  | 'session:detection-failed'
  | 'pane:agent-detected'
  | 'window:snap-zones'
  | 'window:maximized-changed'
  | 'window:focus-state-request'
  | 'tab:release'
  | 'tab:absorb-committed'
  | 'tab:return'
  | 'tab:state-sync'
  | 'pane:received'
  | 'pane:remove-remote'
  | 'pane:transfer-rolledback'
  | 'pane:move-remote'
  | 'renderer:remove-pane'
  | 'renderer:insert-at-split'
  | 'renderer:replace-pane'
  | 'tab:spawn-in-project-remote'
  | 'pane:focus-remote'
  // Immediate focus-change notification (bypasses the debounced tab:state-sync)
  | 'pane:focus-changed'
  // Broadcast by main whenever a BrowserWindow gains OS focus
  | 'window:became-active'
  | 'focus:target-changed'
  // Shutdown layout collection: main requests state snapshots for a final authoritative save
  | 'layout:request-state'
  | 'layout:collect-detached-state'
  | 'updater:status'>

export type SendChannels = ChannelSubset<
  | 'pty:write'
  | 'pty:resize'
  | 'tab:state-sync'
  | 'tab:detached-ready'
  | 'tab:release-applied'
  | 'pane:focus-changed'
  | 'focus:target-report'
  | 'pane:received-applied'
  | 'pane:focus-remote-applied'
  | 'tab:spawn-in-project-applied'
  | 'renderer:insert-at-split-applied'
  | 'renderer:replace-pane-applied'
  // Shutdown layout collection responses
  | 'layout:state-response'
  | 'layout:detached-state-response'
  | 'updater:install'
  | 'updater:set-enabled'
  | 'updater:download'>

export interface IpcBridge {
  invoke<C extends InvokeChannels>(channel: C, ...args: Parameters<IPCChannels[C]>): Promise<ReturnType<IPCChannels[C]>>
  on(channel: EventChannels, handler: (...args: unknown[]) => void): () => void
  send<C extends SendChannels>(channel: C, ...args: Parameters<IPCChannels[C]>): void
}
