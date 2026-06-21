import { create } from 'zustand'
import type { HotkeyId, HotkeyOverride } from '../utils/hotkeys'
import type { AgentProviderSettings, McpSettings } from '../../../shared/types'
import type { GpuAccelerationPref } from '../terminal/rendering/resolveBackend'
import * as xtermRegistry from '../utils/xtermRegistry'

export type SettingsSection = 'appearance' | 'hotkeys' | 'terminal' | 'mcp' | 'providers'
export type { GpuAccelerationPref }

const SETTINGS_KEY = 'multiagent:settings'
export const DEFAULT_TERMINAL_SCROLLBACK_LINES = 250_000
export const MIN_TERMINAL_SCROLLBACK_LINES = 1_000
export const MAX_TERMINAL_SCROLLBACK_LINES = 1_000_000
export const MIN_CONTRAST_RATIO = 1
export const MAX_CONTRAST_RATIO = 21

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
  // Terminal renderer settings (apply on next pane mount)
  optimizedTerminalRenderer: boolean
  setOptimizedTerminalRenderer: (value: boolean) => void
  terminalGpuAcceleration: GpuAccelerationPref
  setTerminalGpuAcceleration: (value: GpuAccelerationPref) => void
  // Terminal display options (hot-apply to live panes)
  terminalMinimumContrastRatio: number
  setTerminalMinimumContrastRatio: (value: number) => void
  terminalRescaleOverlappingGlyphs: boolean
  setTerminalRescaleOverlappingGlyphs: (value: boolean) => void
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

type Persisted = Pick<SettingsState,
  | 'showGitBranchBadges'
  | 'tabOverflowMode'
  | 'optimizedTerminalRenderer'
  | 'terminalGpuAcceleration'
  | 'terminalMinimumContrastRatio'
  | 'terminalRescaleOverlappingGlyphs'
  | 'terminalScrollbackLines'
  | 'hotkeyOverrides'
  | 'mcpSettings'
  | 'agentProviders'
>

function defaultSettings(): Persisted {
  return {
    showGitBranchBadges: true,
    tabOverflowMode: 'scroll',
    optimizedTerminalRenderer: true,
    terminalGpuAcceleration: 'auto',
    terminalMinimumContrastRatio: 1,
    terminalRescaleOverlappingGlyphs: true,
    terminalScrollbackLines: DEFAULT_TERMINAL_SCROLLBACK_LINES,
    hotkeyOverrides: {},
    mcpSettings: DEFAULT_MCP_SETTINGS,
    agentProviders: defaultAgentProviderSettings(),
  }
}

export function normalizeContrastRatio(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 1
  return Math.min(MAX_CONTRAST_RATIO, Math.max(MIN_CONTRAST_RATIO, Math.round(n)))
}

function coerceGpuAcceleration(value: unknown): GpuAccelerationPref {
  if (value === 'auto' || value === 'on' || value === 'off') return value
  return 'auto'
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
      optimizedTerminalRenderer: parsed.optimizedTerminalRenderer !== false,
      terminalGpuAcceleration: coerceGpuAcceleration(parsed.terminalGpuAcceleration),
      terminalMinimumContrastRatio: normalizeContrastRatio(parsed.terminalMinimumContrastRatio),
      terminalRescaleOverlappingGlyphs: parsed.terminalRescaleOverlappingGlyphs !== false,
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
    optimizedTerminalRenderer: state.optimizedTerminalRenderer,
    terminalGpuAcceleration: state.terminalGpuAcceleration,
    terminalMinimumContrastRatio: state.terminalMinimumContrastRatio,
    terminalRescaleOverlappingGlyphs: state.terminalRescaleOverlappingGlyphs,
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
    saveSettings(get())
  },

  setTabOverflowMode: (mode) => {
    set({ tabOverflowMode: mode })
    saveSettings(get())
  },

  setOptimizedTerminalRenderer: (value) => {
    set({ optimizedTerminalRenderer: value })
    saveSettings(get())
  },

  setTerminalGpuAcceleration: (value) => {
    set({ terminalGpuAcceleration: value })
    saveSettings(get())
  },

  setTerminalMinimumContrastRatio: (value) => {
    const terminalMinimumContrastRatio = normalizeContrastRatio(value)
    set({ terminalMinimumContrastRatio })
    xtermRegistry.applyTerminalOptions({ minimumContrastRatio: terminalMinimumContrastRatio })
    saveSettings(get())
  },

  setTerminalRescaleOverlappingGlyphs: (value) => {
    set({ terminalRescaleOverlappingGlyphs: value })
    xtermRegistry.applyTerminalOptions({ rescaleOverlappingGlyphs: value })
    saveSettings(get())
  },

  setTerminalScrollbackLines: (value) => {
    const terminalScrollbackLines = normalizeTerminalScrollbackLines(value)
    set({ terminalScrollbackLines })
    xtermRegistry.setScrollbackLines(terminalScrollbackLines)
    saveSettings(get())
  },

  setHotkeyOverride: (id, override) => {
    const hotkeyOverrides = { ...get().hotkeyOverrides, [id]: override }
    set({ hotkeyOverrides })
    saveSettings(get())
  },

  resetHotkeyOverride: (id) => {
    const hotkeyOverrides = { ...get().hotkeyOverrides }
    delete hotkeyOverrides[id]
    set({ hotkeyOverrides })
    saveSettings(get())
  },

  resetAllHotkeyOverrides: () => {
    const hotkeyOverrides: Partial<Record<HotkeyId, HotkeyOverride>> = {}
    set({ hotkeyOverrides })
    saveSettings(get())
  },

  setMcpSettings: (mcpSettings) => {
    set({ mcpSettings })
    saveSettings(get())
    window.ipc.invoke('mcp:save-settings', mcpSettings).catch((err) => {
      console.error('[Settings] Failed to sync MCP settings to main:', err)
    })
  },

  hydrateMcpSettings: (mcpSettings) => {
    set({ mcpSettings })
    saveSettings(get())
  },

  setAgentProviders: (agentProviders) => {
    set({ agentProviders })
    saveSettings(get())
    window.ipc.invoke('settings:save-agent-providers', agentProviders).catch((err) => {
      console.error('[Settings] Failed to sync agent provider settings to main:', err)
    })
  },

  hydrateAgentProviders: (agentProviders) => {
    set({ agentProviders })
    saveSettings(get())
  },
}))
