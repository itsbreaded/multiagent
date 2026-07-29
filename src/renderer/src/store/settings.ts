import { create } from 'zustand'
import type { HotkeyId, HotkeyOverride } from '../utils/hotkeys'
import type { AgentProviderSettings, AgentProviderSettingsSnapshot, McpSettings, ProviderAvailability } from '../../../shared/types'
import { sanitizeAgentProviderSettings } from '../../../shared/agentProviderSettings'
import type { GpuAccelerationPref } from '../terminal/rendering/resolveBackend'
import * as xtermRegistry from '../utils/xtermRegistry'
import {
  defaultTerminalKeyBindings,
  mergeBindings,
  TERMINAL_KEY_BINDINGS_VERSION,
  type TerminalKeyBinding,
  type Trigger,
  defaultTrigger,
  isWellKnownId,
  bindingKey,
  findClaimant,
  bindingLabel,
  isValidTrigger,
} from '../utils/terminalKeyBindings'

export type SettingsSection = 'appearance' | 'hotkeys' | 'terminal' | 'mcp' | 'providers' | 'updates'
export type { GpuAccelerationPref }

// Outcome of a mutating terminal-key-binding action. The store is the final
// validation authority: on failure it returns `{ ok: false, message }` so the
// UI can surface the reason instead of the action silently no-op-ing.
export type BindingEditResult = { ok: true } | { ok: false; message: string }

const SETTINGS_KEY = 'multiagent:settings'
export const DEFAULT_TERMINAL_SCROLLBACK_LINES = 250_000
export const MIN_TERMINAL_SCROLLBACK_LINES = 1_000
export const MAX_TERMINAL_SCROLLBACK_LINES = 1_000_000
export const MIN_CONTRAST_RATIO = 1
export const MAX_CONTRAST_RATIO = 21

const DEFAULT_MCP_SETTINGS: McpSettings = {
  builtinBrowserEnabled: true,
  builtinUiAutomationEnabled: false,
  customServers: [],
}

// spec 055: providers are enabled (offered for new sessions) by default; the user
// hides one by unchecking its card. Kept as a local seed (parallel to the shared
// default in shared/agentProviderSettings.ts) so the renderer can construct a
// fresh AgentProviderSettings without importing the shared module into this hot path.
function defaultAgentProviderSettings(): AgentProviderSettings {
  return {
    claude: {
      enabled: true, preset: 'native',
      baseUrl: '', authToken: '', model: '',
      opusModel: '', sonnetModel: '', haikuModel: '', subagentModel: '', effortLevel: '',
      extraEnvVars: [],
    },
    codex: {
      enabled: true, preset: 'native',
      providerName: '', model: '', baseUrl: '', envKey: '', apiKey: '',
      wireApi: 'responses', extraEnvVars: [],
    },
    opencode: {
      enabled: true, preset: 'native',
      providerId: '', model: '', baseUrl: '', apiKey: '', npmAdapter: '',
      extraEnvVars: [],
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
  autoUpdateEnabled: boolean
  setAutoUpdateEnabled: (value: boolean) => void
  // spec 047 phase 3 / phase 4: managed SessionStart hooks for session linking. Default-ON
  // under phase 4 (app-launched Codex can only link via the managed hook, now that the
  // file-poll scanner is gone). Enabling installs managed hooks into ~/.claude/settings.json
  // and ~/.codex/hooks.json (+ the [features] flag in ~/.codex/config.toml); reversible from
  // this same toggle. Main is the authority — hydrate from it at startup.
  cliSessionLinking: boolean
  setCliSessionLinking: (value: boolean) => void
  hydrateCliSessionLinking: (value: boolean) => void
  // spec 050: opt-in (default OFF) terminal-output observer for fatal errors the hooks
  // cannot report (notably Codex provider-compat failures). Complementary, NOT full
  // coverage -- hooks remain authoritative wherever they exist. Fully independent of
  // cliSessionLinking: all four on/off combinations are valid. Main is the authority
  // (the detector runs only in main); hydrate from it so a stale local default can't drift.
  agentStatusScraping: boolean
  setAgentStatusScraping: (value: boolean) => void
  hydrateAgentStatusScraping: (value: boolean) => void
  hotkeyOverrides: Partial<Record<HotkeyId, HotkeyOverride>>
  setHotkeyOverride: (id: HotkeyId, override: HotkeyOverride) => void
  resetHotkeyOverride: (id: HotkeyId) => void
  resetAllHotkeyOverrides: () => void
  // Terminal key bindings (copy/paste and PTY signals).
  // Global — apply identically to all pane types. See utils/terminalKeyBindings.ts.
  terminalKeyBindings: TerminalKeyBinding[]
  terminalKeyBindingsVersion: number
  setTerminalKeyBindingTrigger: (id: string, trigger: Trigger) => BindingEditResult
  resetTerminalKeyBinding: (id: string) => BindingEditResult
  resetAllTerminalKeyBindings: () => BindingEditResult
  addCustomTerminalKeyBinding: (label: string, trigger: Trigger, text: string) => BindingEditResult
  updateCustomTerminalKeyBinding: (id: string, label: string, trigger: Trigger, text: string) => BindingEditResult
  removeTerminalKeyBinding: (id: string) => void
  mcpSettings: McpSettings
  setMcpSettings: (settings: McpSettings) => void
  hydrateMcpSettings: (settings: McpSettings) => void
  agentProviders: AgentProviderSettings
  confirmedAgentProviders: AgentProviderSettings
  setAgentProviders: (settings: AgentProviderSettings) => void
  hydrateAgentProviders: (snapshot: AgentProviderSettingsSnapshot) => void
  providerSettingsHydrated: boolean
  providerSettingsRevision: number
  providerSettingsSaveState: 'idle' | 'saving' | 'error'
  providerSettingsSaveError: string | null
  failedAgentProviders: AgentProviderSettings | null
  retryAgentProvidersSave: () => void
  // Per-kind CLI availability resolved on the app's PATH at startup. Default all-true so a slow IPC
  // hydrate never hides every provider on first paint; the real map arrives from main at
  // startup. NOT persisted — it is runtime-only, re-fetched each launch.
  providerAvailability: ProviderAvailability
  providerAvailabilityHydrated: boolean
  hydrateProviderAvailability: (availability: ProviderAvailability) => void
}

interface PendingProviderSave {
  id: number
  settings: AgentProviderSettings
  expectedRevision: number
}

let providerSaveSequence = 0
let providerSaveInFlight = false
const pendingProviderSaves: PendingProviderSave[] = []

function persistProviderState(get: () => SettingsState): void {
  saveSettings(get())
}

function pumpProviderSaves(set: (partial: Partial<SettingsState>) => void, get: () => SettingsState): void {
  if (providerSaveInFlight) return
  const pending = pendingProviderSaves.shift()
  if (!pending) return
  providerSaveInFlight = true
  void window.ipc.invoke('settings:save-agent-providers', pending.settings, pending.expectedRevision)
    .then((result) => {
      const snapshot = result.snapshot
      if (result.ok) {
        // Later local edits include this successful edit, so they can safely
        // advance to its newly-issued revision. External changes never do this.
        for (const queued of pendingProviderSaves) {
          if (queued.expectedRevision === pending.expectedRevision) queued.expectedRevision = snapshot.revision
        }
        if (pending.id === providerSaveSequence) {
          set({
            agentProviders: snapshot.settings,
            confirmedAgentProviders: snapshot.settings,
            providerSettingsRevision: snapshot.revision,
            providerSettingsSaveState: pendingProviderSaves.length ? 'saving' : 'idle',
            providerSettingsSaveError: null,
          })
          persistProviderState(get)
        } else {
          set({ confirmedAgentProviders: snapshot.settings, providerSettingsRevision: snapshot.revision })
        }
      } else {
        // Keep the latest user edit available for Retry, even though its queued
        // request was based on a revision that is no longer authoritative.
        const latestDesired = pendingProviderSaves.at(-1)?.settings ?? pending.settings
        pendingProviderSaves.length = 0
        set({
          agentProviders: snapshot.settings,
          confirmedAgentProviders: snapshot.settings,
          providerSettingsRevision: snapshot.revision,
          providerSettingsSaveState: 'error',
          providerSettingsSaveError: 'Provider settings changed in another window. Retry to apply your change.',
          failedAgentProviders: latestDesired,
        })
        persistProviderState(get)
      }
    })
    .catch(() => {
      if (pending.id === providerSaveSequence) {
        set({
          agentProviders: get().confirmedAgentProviders,
          providerSettingsSaveState: 'error',
          providerSettingsSaveError: 'Provider settings could not be saved. Retry to keep this change.',
          failedAgentProviders: pending.settings,
        })
        persistProviderState(get)
      }
    })
    .finally(() => {
      providerSaveInFlight = false
      pumpProviderSaves(set, get)
    })
}

type Persisted = Pick<SettingsState,
  | 'autoUpdateEnabled'
  | 'cliSessionLinking'
  | 'agentStatusScraping'
  | 'showGitBranchBadges'
  | 'tabOverflowMode'
  | 'optimizedTerminalRenderer'
  | 'terminalGpuAcceleration'
  | 'terminalMinimumContrastRatio'
  | 'terminalRescaleOverlappingGlyphs'
  | 'terminalScrollbackLines'
  | 'hotkeyOverrides'
  | 'terminalKeyBindings'
  | 'terminalKeyBindingsVersion'
  | 'mcpSettings'
  | 'agentProviders'
>

function defaultSettings(): Persisted {
  return {
    autoUpdateEnabled: false,
    cliSessionLinking: true,
    agentStatusScraping: true,
    showGitBranchBadges: true,
    tabOverflowMode: 'scroll',
    optimizedTerminalRenderer: true,
    terminalGpuAcceleration: 'auto',
    terminalMinimumContrastRatio: 1,
    terminalRescaleOverlappingGlyphs: true,
    terminalScrollbackLines: DEFAULT_TERMINAL_SCROLLBACK_LINES,
    hotkeyOverrides: {},
    terminalKeyBindings: defaultTerminalKeyBindings(),
    terminalKeyBindingsVersion: TERMINAL_KEY_BINDINGS_VERSION,
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
    const terminalKeyBindingsVersion =
      typeof parsed.terminalKeyBindingsVersion === 'number'
        ? parsed.terminalKeyBindingsVersion
        : 1
    return {
      autoUpdateEnabled: parsed.autoUpdateEnabled === true,
      cliSessionLinking: parsed.cliSessionLinking !== false,
      // spec 050: default-OFF polarity. `=== true` so an unknown/missing field stays off,
      // never silently on -- this is an opt-in complement, not the default discipline.
      agentStatusScraping: parsed.agentStatusScraping !== false,
      showGitBranchBadges: parsed.showGitBranchBadges !== false,
      tabOverflowMode: parsed.tabOverflowMode === 'wrap' ? 'wrap' : 'scroll',
      optimizedTerminalRenderer: parsed.optimizedTerminalRenderer !== false,
      terminalGpuAcceleration: coerceGpuAcceleration(parsed.terminalGpuAcceleration),
      terminalMinimumContrastRatio: normalizeContrastRatio(parsed.terminalMinimumContrastRatio),
      terminalRescaleOverlappingGlyphs: parsed.terminalRescaleOverlappingGlyphs !== false,
      terminalScrollbackLines: normalizeTerminalScrollbackLines(parsed.terminalScrollbackLines),
      hotkeyOverrides: (parsed.hotkeyOverrides as Partial<Record<HotkeyId, HotkeyOverride>>) ?? {},
      terminalKeyBindings: mergeBindings(parsed.terminalKeyBindings as TerminalKeyBinding[] | undefined, {
        migrateOldKillWordDefault: terminalKeyBindingsVersion < TERMINAL_KEY_BINDINGS_VERSION,
      }),
      terminalKeyBindingsVersion: TERMINAL_KEY_BINDINGS_VERSION,
      mcpSettings: {
        builtinBrowserEnabled: (parsed.mcpSettings as McpSettings | undefined)?.builtinBrowserEnabled !== false,
        builtinUiAutomationEnabled: (parsed.mcpSettings as McpSettings | undefined)?.builtinUiAutomationEnabled === true,
        customServers: Array.isArray((parsed.mcpSettings as McpSettings | undefined)?.customServers)
          ? (parsed.mcpSettings as McpSettings).customServers
          : [],
      },
      // Sanitize the persisted provider settings through the same coercer the
      // main process uses on read. localStorage is a mirror written by older app
      // versions and must never be trusted raw — a stale/legacy shape (e.g. the
      // pre-048 `preset: "custom"` slot) reaching the store unsanitized crashed
      // the Providers tab on render. The main-process IPC hydrate still runs on
      // top of this; sanitizing here just guarantees a valid shape at all times.
      agentProviders: sanitizeAgentProviderSettings(parsed.agentProviders),
    }
  } catch {
    return defaultSettings()
  }
}

function saveSettings(state: Persisted): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    autoUpdateEnabled: state.autoUpdateEnabled,
    cliSessionLinking: state.cliSessionLinking,
    agentStatusScraping: state.agentStatusScraping,
    showGitBranchBadges: state.showGitBranchBadges,
    tabOverflowMode: state.tabOverflowMode,
    optimizedTerminalRenderer: state.optimizedTerminalRenderer,
    terminalGpuAcceleration: state.terminalGpuAcceleration,
    terminalMinimumContrastRatio: state.terminalMinimumContrastRatio,
    terminalRescaleOverlappingGlyphs: state.terminalRescaleOverlappingGlyphs,
    terminalScrollbackLines: state.terminalScrollbackLines,
    hotkeyOverrides: state.hotkeyOverrides,
    terminalKeyBindings: state.terminalKeyBindings,
    terminalKeyBindingsVersion: state.terminalKeyBindingsVersion,
    mcpSettings: state.mcpSettings,
    agentProviders: state.agentProviders,
  }))
}

const initialSettings = loadSettings()

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...initialSettings,
  confirmedAgentProviders: initialSettings.agentProviders,

  setAutoUpdateEnabled: (value) => {
    set({ autoUpdateEnabled: value })
    saveSettings(get())
  },

  setCliSessionLinking: (value) => {
    set({ cliSessionLinking: value })
    saveSettings(get())
    // Main is the authority for the managed hook install + env injection + report server.
    window.ipc.invoke('settings:set-cli-session-linking', value).catch((err) => {
      console.error('[Settings] Failed to sync CLI session linking to main:', err)
    })
  },

  hydrateCliSessionLinking: (value) => {
    set({ cliSessionLinking: value })
    saveSettings(get())
  },

  setAgentStatusScraping: (value) => {
    set({ agentStatusScraping: value })
    saveSettings(get())
    // Main is the authority -- the detector runs only there. Sync the flag so main can
    // gate its ptyOutputRouter-owned scraper. The two settings are fully independent.
    window.ipc.invoke('settings:set-terminal-status-scraping', value).catch((err) => {
      console.error('[Settings] Failed to sync agent status scraping to main:', err)
    })
  },

  hydrateAgentStatusScraping: (value) => {
    set({ agentStatusScraping: value })
    saveSettings(get())
  },

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

  setTerminalKeyBindingTrigger: (id, trigger) => {
    const current = get().terminalKeyBindings
    if (!current.some((b) => b.id === id)) return { ok: false, message: 'Binding not found' }
    if (!isValidTrigger(trigger)) return { ok: false, message: 'Use a Ctrl, Alt, or Meta key combination' }
    const owner = findClaimant(current, bindingKey(trigger), id)
    if (owner) return { ok: false, message: `Already used by: ${bindingLabel(owner)}` }
    const terminalKeyBindings = current.map((b) =>
      b.id === id ? { ...b, trigger: { ...trigger } } : b
    )
    set({ terminalKeyBindings })
    saveSettings(get())
    return { ok: true }
  },

  resetTerminalKeyBinding: (id) => {
    const defTrigger = defaultTrigger(id)
    if (!defTrigger) return { ok: false, message: 'Binding has no default' }
    const current = get().terminalKeyBindings
    const owner = findClaimant(current, bindingKey(defTrigger), id)
    if (owner) return { ok: false, message: `Cannot reset: default is used by ${bindingLabel(owner)}` }
    const terminalKeyBindings = current.map((b) =>
      b.id === id ? { ...b, trigger: { ...defTrigger } } : b
    )
    set({ terminalKeyBindings })
    saveSettings(get())
    return { ok: true }
  },

  resetAllTerminalKeyBindings: () => {
    const customs = get().terminalKeyBindings.filter((b) => !isWellKnownId(b.id))
    const defaults = defaultTerminalKeyBindings()
    for (const d of defaults) {
      const owner = findClaimant(customs, bindingKey(d.trigger))
      if (owner) return { ok: false, message: `Cannot reset: a default is used by ${bindingLabel(owner)}` }
    }
    set({ terminalKeyBindings: [...defaults, ...customs] })
    saveSettings(get())
    return { ok: true }
  },

  addCustomTerminalKeyBinding: (label, trigger, text) => {
    const trimmed = label.trim()
    if (!trimmed) return { ok: false, message: 'Label is required' }
    if (!isValidTrigger(trigger)) return { ok: false, message: 'Use a Ctrl, Alt, or Meta key combination' }
    const current = get().terminalKeyBindings
    const owner = findClaimant(current, bindingKey(trigger))
    if (owner) return { ok: false, message: `Already used by: ${bindingLabel(owner)}` }
    const binding: TerminalKeyBinding = {
      id: `custom-${crypto.randomUUID()}`,
      label: trimmed,
      trigger: { ...trigger },
      action: { type: 'text-macro', text },
    }
    set({ terminalKeyBindings: [...current, binding] })
    saveSettings(get())
    return { ok: true }
  },

  updateCustomTerminalKeyBinding: (id, label, trigger, text) => {
    if (!id.startsWith('custom-')) return { ok: false, message: 'Only custom macros can be edited' }
    const trimmed = label.trim()
    if (!trimmed) return { ok: false, message: 'Label is required' }
    if (!isValidTrigger(trigger)) return { ok: false, message: 'Use a Ctrl, Alt, or Meta key combination' }
    const current = get().terminalKeyBindings
    const existing = current.find((b) => b.id === id)
    if (!existing || existing.action.type !== 'text-macro') return { ok: false, message: 'Macro not found' }
    const owner = findClaimant(current, bindingKey(trigger), id)
    if (owner) return { ok: false, message: `Already used by: ${bindingLabel(owner)}` }
    const terminalKeyBindings = current.map((b) => b.id === id
      ? { ...b, label: trimmed, trigger: { ...trigger }, action: { type: 'text-macro' as const, text } }
      : b
    )
    set({ terminalKeyBindings })
    saveSettings(get())
    return { ok: true }
  },

  removeTerminalKeyBinding: (id) => {
    if (!id.startsWith('custom-')) return
    const terminalKeyBindings = get().terminalKeyBindings.filter((b) => b.id !== id)
    set({ terminalKeyBindings })
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
    const save = {
      id: ++providerSaveSequence,
      settings: agentProviders,
      expectedRevision: get().providerSettingsRevision,
    }
    pendingProviderSaves.push(save)
    set({ agentProviders, providerSettingsSaveState: 'saving', providerSettingsSaveError: null, failedAgentProviders: null })
    saveSettings(get())
    pumpProviderSaves(set, get)
  },

  hydrateAgentProviders: (snapshot) => {
    const current = get()
    if (snapshot.revision < current.providerSettingsRevision) return
    if (current.providerSettingsSaveState === 'saving') {
      set({ confirmedAgentProviders: snapshot.settings, providerSettingsRevision: snapshot.revision, providerSettingsHydrated: true })
      return
    }
    set({
      agentProviders: snapshot.settings,
      confirmedAgentProviders: snapshot.settings,
      providerSettingsRevision: snapshot.revision,
      providerSettingsHydrated: true,
      providerSettingsSaveState: 'idle',
      providerSettingsSaveError: null,
      failedAgentProviders: null,
    })
    saveSettings(get())
  },

  providerSettingsHydrated: false,
  providerSettingsRevision: 0,
  providerSettingsSaveState: 'idle',
  providerSettingsSaveError: null,
  failedAgentProviders: null,

  retryAgentProvidersSave: () => {
    if (get().providerSettingsSaveState !== 'error') return
    const failed = get().failedAgentProviders
    if (failed) get().setAgentProviders(failed)
  },

  providerAvailability: { claude: true, codex: true, opencode: true },
  providerAvailabilityHydrated: false,

  hydrateProviderAvailability: (availability) => {
    set({ providerAvailability: availability, providerAvailabilityHydrated: true })
  },
}))
