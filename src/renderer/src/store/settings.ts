import { create } from 'zustand'
import type { HotkeyId, HotkeyOverride } from '../utils/hotkeys'
import type { AgentProviderSettings, McpSettings } from '../../../shared/types'
import * as xtermRegistry from '../utils/xtermRegistry'

export type SettingsSection = 'appearance' | 'hotkeys' | 'general' | 'mcp' | 'providers'

const SETTINGS_KEY = 'multiagent:settings'
export const DEFAULT_TERMINAL_SCROLLBACK_LINES = 250_000
export const MIN_TERMINAL_SCROLLBACK_LINES = 1_000
export const MAX_TERMINAL_SCROLLBACK_LINES = 1_000_000

const DEFAULT_MCP_SETTINGS: McpSettings = {
  builtinBrowserEnabled: true,
  customServers: [],
}

function defaultAgentProviderSettings(): AgentProviderSettings {
  return {
    claude: {
      enabled: false, preset: 'native',
      baseUrl: '', authToken: '', model: '',
      opusModel: '', sonnetModel: '', haikuModel: '', subagentModel: '', effortLevel: '',
      extraEnvVars: [],
    },
    codex: {
      enabled: false, preset: 'native',
      providerName: '', model: '', baseUrl: '', envKey: '', apiKey: '',
      wireApi: 'responses', extraEnvVars: [],
    },
  }
}

interface SettingsState {
  showGitBranchBadges: boolean
  setShowGitBranchBadges: (value: boolean) => void
  tabOverflowMode: 'scroll' | 'wrap'
  setTabOverflowMode: (mode: 'scroll' | 'wrap') => void
  terminalScrollbackLines: number
  setTerminalScrollbackLines: (value: number) => void
  hotkeyOverrides: Partial<Record<HotkeyId, HotkeyOverride>>
  setHotkeyOverride: (id: HotkeyId, override: HotkeyOverride) => void
  resetHotkeyOverride: (id: HotkeyId) => void
  resetAllHotkeyOverrides: () => void
  mcpSettings: McpSettings
  setMcpSettings: (settings: McpSettings) => void
  hydrateMcpSettings: (settings: McpSettings) => void
  agentProviders: AgentProviderSettings
  setAgentProviders: (settings: AgentProviderSettings) => void
  hydrateAgentProviders: (settings: AgentProviderSettings) => void
}

type Persisted = Pick<SettingsState, 'showGitBranchBadges' | 'tabOverflowMode' | 'terminalScrollbackLines' | 'hotkeyOverrides' | 'mcpSettings' | 'agentProviders'>

function defaultSettings(): Persisted {
  return {
    showGitBranchBadges: true,
    tabOverflowMode: 'scroll',
    terminalScrollbackLines: DEFAULT_TERMINAL_SCROLLBACK_LINES,
    hotkeyOverrides: {},
    mcpSettings: DEFAULT_MCP_SETTINGS,
    agentProviders: defaultAgentProviderSettings(),
  }
}

export function normalizeTerminalScrollbackLines(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_TERMINAL_SCROLLBACK_LINES
  return Math.min(
    MAX_TERMINAL_SCROLLBACK_LINES,
    Math.max(MIN_TERMINAL_SCROLLBACK_LINES, Math.round(numeric)),
  )
}

function loadSettings(): Persisted {
  if (typeof localStorage === 'undefined') {
    return defaultSettings()
  }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return defaultSettings()
    const parsed = JSON.parse(raw) as Partial<Persisted>
    return {
      showGitBranchBadges: parsed.showGitBranchBadges !== false,
      tabOverflowMode: parsed.tabOverflowMode === 'wrap' ? 'wrap' : 'scroll',
      terminalScrollbackLines: normalizeTerminalScrollbackLines(parsed.terminalScrollbackLines),
      hotkeyOverrides: (parsed.hotkeyOverrides as Partial<Record<HotkeyId, HotkeyOverride>>) ?? {},
      mcpSettings: {
        builtinBrowserEnabled: (parsed.mcpSettings as McpSettings | undefined)?.builtinBrowserEnabled !== false,
        customServers: Array.isArray((parsed.mcpSettings as McpSettings | undefined)?.customServers)
          ? (parsed.mcpSettings as McpSettings).customServers
          : [],
      },
      agentProviders: (parsed.agentProviders as AgentProviderSettings | undefined) ?? defaultAgentProviderSettings(),
    }
  } catch {
    return defaultSettings()
  }
}

function saveSettings(state: Persisted): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    showGitBranchBadges: state.showGitBranchBadges,
    tabOverflowMode: state.tabOverflowMode,
    terminalScrollbackLines: state.terminalScrollbackLines,
    hotkeyOverrides: state.hotkeyOverrides,
    mcpSettings: state.mcpSettings,
    agentProviders: state.agentProviders,
  }))
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...loadSettings(),

  setShowGitBranchBadges: (value) => {
    set({ showGitBranchBadges: value })
    const s = get()
    saveSettings({ showGitBranchBadges: s.showGitBranchBadges, tabOverflowMode: s.tabOverflowMode, terminalScrollbackLines: s.terminalScrollbackLines, hotkeyOverrides: s.hotkeyOverrides, mcpSettings: s.mcpSettings, agentProviders: s.agentProviders })
  },

  setTabOverflowMode: (mode) => {
    set({ tabOverflowMode: mode })
    const s = get()
    saveSettings({ showGitBranchBadges: s.showGitBranchBadges, tabOverflowMode: mode, terminalScrollbackLines: s.terminalScrollbackLines, hotkeyOverrides: s.hotkeyOverrides, mcpSettings: s.mcpSettings, agentProviders: s.agentProviders })
  },

  setTerminalScrollbackLines: (value) => {
    const terminalScrollbackLines = normalizeTerminalScrollbackLines(value)
    set({ terminalScrollbackLines })
    xtermRegistry.setScrollbackLines(terminalScrollbackLines)
    const s = get()
    saveSettings({ showGitBranchBadges: s.showGitBranchBadges, tabOverflowMode: s.tabOverflowMode, terminalScrollbackLines, hotkeyOverrides: s.hotkeyOverrides, mcpSettings: s.mcpSettings, agentProviders: s.agentProviders })
  },

  setHotkeyOverride: (id, override) => {
    const hotkeyOverrides = { ...get().hotkeyOverrides, [id]: override }
    set({ hotkeyOverrides })
    const s = get()
    saveSettings({ showGitBranchBadges: s.showGitBranchBadges, tabOverflowMode: s.tabOverflowMode, terminalScrollbackLines: s.terminalScrollbackLines, hotkeyOverrides, mcpSettings: s.mcpSettings, agentProviders: s.agentProviders })
  },

  resetHotkeyOverride: (id) => {
    const hotkeyOverrides = { ...get().hotkeyOverrides }
    delete hotkeyOverrides[id]
    set({ hotkeyOverrides })
    const s = get()
    saveSettings({ showGitBranchBadges: s.showGitBranchBadges, tabOverflowMode: s.tabOverflowMode, terminalScrollbackLines: s.terminalScrollbackLines, hotkeyOverrides, mcpSettings: s.mcpSettings, agentProviders: s.agentProviders })
  },

  resetAllHotkeyOverrides: () => {
    const hotkeyOverrides: Partial<Record<HotkeyId, HotkeyOverride>> = {}
    set({ hotkeyOverrides })
    const s = get()
    saveSettings({ showGitBranchBadges: s.showGitBranchBadges, tabOverflowMode: s.tabOverflowMode, terminalScrollbackLines: s.terminalScrollbackLines, hotkeyOverrides, mcpSettings: s.mcpSettings, agentProviders: s.agentProviders })
  },

  setMcpSettings: (mcpSettings) => {
    set({ mcpSettings })
    const s = get()
    saveSettings({ showGitBranchBadges: s.showGitBranchBadges, tabOverflowMode: s.tabOverflowMode, terminalScrollbackLines: s.terminalScrollbackLines, hotkeyOverrides: s.hotkeyOverrides, mcpSettings, agentProviders: s.agentProviders })
    // Sync to main process
    window.ipc.invoke('mcp:save-settings', mcpSettings).catch((err) => {
      console.error('[Settings] Failed to sync MCP settings to main:', err)
    })
  },

  hydrateMcpSettings: (mcpSettings) => {
    set({ mcpSettings })
    const s = get()
    saveSettings({ showGitBranchBadges: s.showGitBranchBadges, tabOverflowMode: s.tabOverflowMode, terminalScrollbackLines: s.terminalScrollbackLines, hotkeyOverrides: s.hotkeyOverrides, mcpSettings, agentProviders: s.agentProviders })
  },

  setAgentProviders: (agentProviders) => {
    set({ agentProviders })
    const s = get()
    saveSettings({ showGitBranchBadges: s.showGitBranchBadges, tabOverflowMode: s.tabOverflowMode, terminalScrollbackLines: s.terminalScrollbackLines, hotkeyOverrides: s.hotkeyOverrides, mcpSettings: s.mcpSettings, agentProviders })
    window.ipc.invoke('settings:save-agent-providers', agentProviders).catch((err) => {
      console.error('[Settings] Failed to sync agent provider settings to main:', err)
    })
  },

  hydrateAgentProviders: (agentProviders) => {
    set({ agentProviders })
    const s = get()
    saveSettings({ showGitBranchBadges: s.showGitBranchBadges, tabOverflowMode: s.tabOverflowMode, terminalScrollbackLines: s.terminalScrollbackLines, hotkeyOverrides: s.hotkeyOverrides, mcpSettings: s.mcpSettings, agentProviders })
  },
}))
