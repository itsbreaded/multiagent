import type { AgentKind, PaneLeaf, SplitDirection } from '../../../shared/types'
import type { HotkeyId, HotkeyOverride } from '../utils/hotkeys'
import type { SettingsSection } from '../store/settings'
import { buildHotkeys } from '../utils/hotkeys'

export interface CommandContext {
  getFocusedPane: () => PaneLeaf | undefined
  activeTabId: string
  activeTabDefaultCwd: string | undefined
  cwd: string
  isDetachedWindow: boolean
  tabCount: number
  vsCodeAvailable: boolean
  closeOverlays: () => void
  newSession: (cwd: string, direction: SplitDirection, kind: AgentKind) => void
  addShellPane: (cwd: string) => void
  splitPane: (paneId: string, direction: SplitDirection) => Promise<void>
  zoomedPaneId: string | null
  closePane: (paneId: string) => void
  zoomPane: (paneId: string) => void
  unzoom: () => void
  addTab: () => string
  closeTab: (tabId: string) => void
  duplicateTab: (tabId: string) => void
  toggleSidebar: () => void
  toggleSessionBrowser: () => void
  openSettings: (section?: SettingsSection) => void
  setPaneCustomName: (paneId: string, name: string) => void
  setPendingRenamePaneId: (id: string | null) => void
  setPendingRenameTabId: (id: string | null) => void
  openDirPickerForTab: (tabId: string) => void
  hotkeyOverrides: Partial<Record<HotkeyId, HotkeyOverride>>
}

export interface Command {
  id: string
  title: string
  category: string
  keywords?: string[]
  agentKind?: AgentKind
  shellIcon?: boolean
  shortcut?: (ctx: CommandContext) => string | undefined
  enabled?: (ctx: CommandContext) => boolean
  run: (ctx: CommandContext) => void | Promise<void>
}

export const CATEGORY_ORDER = ['General', 'Panes', 'Tabs', 'View', 'Session'] as const

const COMMANDS: Command[] = [
  // ── General ──────────────────────────────────────────────────────────────
  {
    id: 'settings.open',
    title: 'Open Settings',
    category: 'General',
    keywords: ['preferences', 'config', 'configuration'],
    enabled: (ctx) => !ctx.isDetachedWindow,
    run: (ctx) => { ctx.openSettings() },
  },
  {
    id: 'settings.open.appearance',
    title: 'Settings: Appearance',
    category: 'General',
    keywords: ['preferences', 'config', 'theme', 'git', 'branch', 'tabs', 'overflow'],
    enabled: (ctx) => !ctx.isDetachedWindow,
    run: (ctx) => { ctx.openSettings('appearance') },
  },
  {
    id: 'settings.open.hotkeys',
    title: 'Settings: Hotkeys',
    category: 'General',
    keywords: ['preferences', 'config', 'keyboard', 'shortcuts', 'bindings', 'keybindings'],
    enabled: (ctx) => !ctx.isDetachedWindow,
    run: (ctx) => { ctx.openSettings('hotkeys') },
  },
  {
    id: 'settings.open.mcp',
    title: 'Settings: MCP',
    category: 'General',
    keywords: ['preferences', 'config', 'model context protocol', 'servers'],
    enabled: (ctx) => !ctx.isDetachedWindow,
    run: (ctx) => { ctx.openSettings('mcp') },
  },
  {
    id: 'settings.open.providers',
    title: 'Settings: Providers',
    category: 'General',
    keywords: ['preferences', 'config', 'api', 'openai', 'anthropic', 'model', 'provider'],
    enabled: (ctx) => !ctx.isDetachedWindow,
    run: (ctx) => { ctx.openSettings('providers') },
  },
  {
    id: 'settings.open.terminal',
    title: 'Settings: Terminal',
    category: 'General',
    keywords: ['preferences', 'config', 'gpu', 'webgl', 'renderer', 'acceleration', 'performance', 'contrast', 'glyphs', 'scrolling', 'scrollback', 'history'],
    enabled: (ctx) => !ctx.isDetachedWindow,
    run: (ctx) => { ctx.openSettings('terminal') },
  },
  {
    id: 'settings.open.updates',
    title: 'Settings: Updates',
    category: 'General',
    keywords: ['preferences', 'config', 'version', 'update', 'auto update', 'release', 'upgrade'],
    enabled: (ctx) => !ctx.isDetachedWindow,
    run: (ctx) => { ctx.openSettings('updates') },
  },

  // ── Panes ─────────────────────────────────────────────────────────────────
  {
    id: 'session.newClaude',
    title: 'New Claude Session',
    category: 'Panes',
    agentKind: 'claude',
    run: (ctx) => { ctx.newSession(ctx.cwd, 'vertical', 'claude'); ctx.closeOverlays() },
  },
  {
    id: 'session.newCodex',
    title: 'New Codex Session',
    category: 'Panes',
    agentKind: 'codex',
    run: (ctx) => { ctx.newSession(ctx.cwd, 'vertical', 'codex'); ctx.closeOverlays() },
  },
  {
    id: 'pane.newShell',
    title: 'New Shell Pane',
    category: 'Panes',
    shellIcon: true,
    run: (ctx) => { ctx.addShellPane(ctx.cwd); ctx.closeOverlays() },
  },
  {
    id: 'pane.splitVertical',
    title: 'Split Pane Vertical',
    category: 'Panes',
    shortcut: (ctx) => buildHotkeys(ctx.hotkeyOverrides).splitVertical.display,
    enabled: (ctx) => !!ctx.getFocusedPane(),
    run: (ctx) => {
      const pane = ctx.getFocusedPane()
      if (pane) void ctx.splitPane(pane.id, 'vertical')
      ctx.closeOverlays()
    },
  },
  {
    id: 'pane.splitHorizontal',
    title: 'Split Pane Horizontal',
    category: 'Panes',
    shortcut: (ctx) => buildHotkeys(ctx.hotkeyOverrides).splitHorizontal.display,
    enabled: (ctx) => !!ctx.getFocusedPane(),
    run: (ctx) => {
      const pane = ctx.getFocusedPane()
      if (pane) void ctx.splitPane(pane.id, 'horizontal')
      ctx.closeOverlays()
    },
  },
  {
    id: 'pane.close',
    title: 'Close Pane',
    category: 'Panes',
    shortcut: (ctx) => buildHotkeys(ctx.hotkeyOverrides).closePane.display,
    enabled: (ctx) => !!ctx.getFocusedPane(),
    run: (ctx) => {
      const pane = ctx.getFocusedPane()
      if (pane) ctx.closePane(pane.id)
      ctx.closeOverlays()
    },
  },
  {
    id: 'pane.zoom',
    title: 'Toggle Zoom Pane',
    category: 'Panes',
    shortcut: (ctx) => buildHotkeys(ctx.hotkeyOverrides).zoomPane.display,
    enabled: (ctx) => !!ctx.getFocusedPane(),
    run: (ctx) => {
      if (ctx.zoomedPaneId) { ctx.unzoom() } else { const pane = ctx.getFocusedPane(); if (pane) ctx.zoomPane(pane.id) }
      ctx.closeOverlays()
    },
  },
  {
    id: 'pane.rename',
    title: 'Rename Pane',
    category: 'Panes',
    keywords: ['label', 'name', 'custom'],
    enabled: (ctx) => !!ctx.getFocusedPane(),
    run: (ctx) => {
      const pane = ctx.getFocusedPane()
      if (!pane) return
      ctx.closeOverlays()
      ctx.setPendingRenamePaneId(pane.id)
    },
  },
  {
    id: 'pane.openFolder',
    title: 'Open Pane Directory in Explorer',
    category: 'Panes',
    keywords: ['folder', 'finder', 'file manager', 'explorer', 'reveal'],
    enabled: (ctx) => !!ctx.getFocusedPane(),
    run: (ctx) => {
      const pane = ctx.getFocusedPane()
      ctx.closeOverlays()
      if (pane) void window.ipc.invoke('shell:open-folder', pane.cwd)
    },
  },
  {
    id: 'pane.openProjectFolder',
    title: 'Open Project Directory in Explorer',
    category: 'Panes',
    keywords: ['folder', 'finder', 'file manager', 'explorer', 'reveal', 'project', 'root'],
    enabled: (ctx) => !!(ctx.activeTabDefaultCwd ?? ctx.getFocusedPane()),
    run: (ctx) => {
      const dir = ctx.activeTabDefaultCwd ?? ctx.getFocusedPane()?.cwd
      ctx.closeOverlays()
      if (dir) void window.ipc.invoke('shell:open-folder', dir)
    },
  },
  {
    id: 'pane.openVSCode',
    title: 'Open in VS Code',
    category: 'Panes',
    keywords: ['editor', 'vscode', 'code'],
    enabled: (ctx) => ctx.vsCodeAvailable && !!ctx.getFocusedPane(),
    run: (ctx) => {
      const pane = ctx.getFocusedPane()
      ctx.closeOverlays()
      if (pane) void window.ipc.invoke('shell:open-vscode', pane.cwd)
    },
  },
  {
    id: 'pane.copyPath',
    title: 'Copy Pane Path',
    category: 'Panes',
    keywords: ['clipboard', 'cwd', 'directory', 'path'],
    enabled: (ctx) => !!ctx.getFocusedPane(),
    run: (ctx) => {
      const pane = ctx.getFocusedPane()
      ctx.closeOverlays()
      if (!pane) return
      if (window.ipc) { void window.ipc.invoke('shell:copy-to-clipboard', pane.cwd) }
      else { navigator.clipboard.writeText(pane.cwd).catch(() => {}) }
    },
  },
  {
    id: 'pane.copySessionId',
    title: 'Copy Session ID',
    category: 'Panes',
    keywords: ['clipboard', 'session', 'id', 'uuid'],
    enabled: (ctx) => !!ctx.getFocusedPane()?.sessionId,
    run: (ctx) => {
      const id = ctx.getFocusedPane()?.sessionId
      ctx.closeOverlays()
      if (!id) return
      if (window.ipc) { void window.ipc.invoke('shell:copy-to-clipboard', id) }
      else { navigator.clipboard.writeText(id).catch(() => {}) }
    },
  },

  // ── Tabs ──────────────────────────────────────────────────────────────────
  {
    id: 'tab.new',
    title: 'New Tab',
    category: 'Tabs',
    shortcut: (ctx) => buildHotkeys(ctx.hotkeyOverrides).newTab.display,
    run: (ctx) => { ctx.addTab(); ctx.closeOverlays() },
  },
  {
    id: 'tab.close',
    title: 'Close Tab',
    category: 'Tabs',
    shortcut: (ctx) => buildHotkeys(ctx.hotkeyOverrides).closeTab.display,
    enabled: (ctx) => ctx.tabCount > 1,
    run: (ctx) => { ctx.closeTab(ctx.activeTabId); ctx.closeOverlays() },
  },
  {
    id: 'tab.duplicate',
    title: 'Duplicate Tab',
    category: 'Tabs',
    run: (ctx) => { ctx.duplicateTab(ctx.activeTabId); ctx.closeOverlays() },
  },
  {
    id: 'tab.rename',
    title: 'Rename Tab',
    category: 'Tabs',
    keywords: ['label', 'name', 'project'],
    run: (ctx) => {
      ctx.closeOverlays()
      ctx.setPendingRenameTabId(ctx.activeTabId)
    },
  },
  {
    id: 'tab.changeDirectory',
    title: 'Change Project Directory',
    category: 'Tabs',
    keywords: ['cwd', 'folder', 'project', 'root', 'repair', 'move'],
    run: (ctx) => {
      ctx.closeOverlays()
      ctx.openDirPickerForTab(ctx.activeTabId)
    },
  },

  // ── View ──────────────────────────────────────────────────────────────────
  {
    id: 'view.toggleSidebar',
    title: 'Toggle Sidebar',
    category: 'View',
    shortcut: (ctx) => buildHotkeys(ctx.hotkeyOverrides).toggleSidebar.display,
    run: (ctx) => { ctx.toggleSidebar(); ctx.closeOverlays() },
  },
  {
    id: 'view.sessionBrowser',
    title: 'Open Session Browser',
    category: 'View',
    shortcut: (ctx) => buildHotkeys(ctx.hotkeyOverrides).sessionBrowser.display,
    enabled: (ctx) => !ctx.isDetachedWindow,
    // toggleSessionBrowser already closes the command palette overlay atomically
    run: (ctx) => { ctx.toggleSessionBrowser() },
  },
  {
    id: 'view.toggleMaximize',
    title: 'Toggle Fullscreen',
    category: 'View',
    keywords: ['maximize', 'fullscreen', 'window', 'zoom'],
    run: (ctx) => {
      ctx.closeOverlays()
      void window.ipc.invoke('window:toggle-maximize')
    },
  },
]

export function getCommands(ctx: CommandContext): Command[] {
  return COMMANDS.filter((c) => c.enabled?.(ctx) ?? true)
}
