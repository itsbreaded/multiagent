import { create } from 'zustand'
import type { HotkeyId, HotkeyOverride } from '../utils/hotkeys'
import type { McpSettings } from '../../../shared/types'

const SETTINGS_KEY = 'multiagent:settings'

const DEFAULT_MCP_SETTINGS: McpSettings = {
  builtinBrowserEnabled: true,
  customServers: [],
}

interface SettingsState {
  showGitBranchBadges: boolean
  setShowGitBranchBadges: (value: boolean) => void
  hotkeyOverrides: Partial<Record<HotkeyId, HotkeyOverride>>
  setHotkeyOverride: (id: HotkeyId, override: HotkeyOverride) => void
  resetHotkeyOverride: (id: HotkeyId) => void
  resetAllHotkeyOverrides: () => void
  mcpSettings: McpSettings
  setMcpSettings: (settings: McpSettings) => void
}

type Persisted = Pick<SettingsState, 'showGitBranchBadges' | 'hotkeyOverrides' | 'mcpSettings'>

function loadSettings(): Persisted {
  if (typeof localStorage === 'undefined') {
    return { showGitBranchBadges: true, hotkeyOverrides: {}, mcpSettings: DEFAULT_MCP_SETTINGS }
  }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { showGitBranchBadges: true, hotkeyOverrides: {}, mcpSettings: DEFAULT_MCP_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<Persisted>
    return {
      showGitBranchBadges: parsed.showGitBranchBadges !== false,
      hotkeyOverrides: (parsed.hotkeyOverrides as Partial<Record<HotkeyId, HotkeyOverride>>) ?? {},
      mcpSettings: {
        builtinBrowserEnabled: (parsed.mcpSettings as McpSettings | undefined)?.builtinBrowserEnabled !== false,
        customServers: Array.isArray((parsed.mcpSettings as McpSettings | undefined)?.customServers)
          ? (parsed.mcpSettings as McpSettings).customServers
          : [],
      },
    }
  } catch {
    return { showGitBranchBadges: true, hotkeyOverrides: {}, mcpSettings: DEFAULT_MCP_SETTINGS }
  }
}

function saveSettings(state: Persisted): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    showGitBranchBadges: state.showGitBranchBadges,
    hotkeyOverrides: state.hotkeyOverrides,
    mcpSettings: state.mcpSettings,
  }))
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...loadSettings(),

  setShowGitBranchBadges: (value) => {
    set({ showGitBranchBadges: value })
    const s = get()
    saveSettings({ showGitBranchBadges: s.showGitBranchBadges, hotkeyOverrides: s.hotkeyOverrides, mcpSettings: s.mcpSettings })
  },

  setHotkeyOverride: (id, override) => {
    const hotkeyOverrides = { ...get().hotkeyOverrides, [id]: override }
    set({ hotkeyOverrides })
    const s = get()
    saveSettings({ showGitBranchBadges: s.showGitBranchBadges, hotkeyOverrides, mcpSettings: s.mcpSettings })
  },

  resetHotkeyOverride: (id) => {
    const hotkeyOverrides = { ...get().hotkeyOverrides }
    delete hotkeyOverrides[id]
    set({ hotkeyOverrides })
    const s = get()
    saveSettings({ showGitBranchBadges: s.showGitBranchBadges, hotkeyOverrides, mcpSettings: s.mcpSettings })
  },

  resetAllHotkeyOverrides: () => {
    const hotkeyOverrides: Partial<Record<HotkeyId, HotkeyOverride>> = {}
    set({ hotkeyOverrides })
    const s = get()
    saveSettings({ showGitBranchBadges: s.showGitBranchBadges, hotkeyOverrides, mcpSettings: s.mcpSettings })
  },

  setMcpSettings: (mcpSettings) => {
    set({ mcpSettings })
    const s = get()
    saveSettings({ showGitBranchBadges: s.showGitBranchBadges, hotkeyOverrides: s.hotkeyOverrides, mcpSettings })
    // Sync to main process
    window.ipc.invoke('mcp:save-settings', mcpSettings).catch((err) => {
      console.error('[Settings] Failed to sync MCP settings to main:', err)
    })
  },
}))
