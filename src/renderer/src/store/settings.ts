import { create } from 'zustand'
import type { HotkeyId, HotkeyOverride } from '../utils/hotkeys'

const SETTINGS_KEY = 'multiagent:settings'

interface SettingsState {
  showGitBranchBadges: boolean
  setShowGitBranchBadges: (value: boolean) => void
  hotkeyOverrides: Partial<Record<HotkeyId, HotkeyOverride>>
  setHotkeyOverride: (id: HotkeyId, override: HotkeyOverride) => void
  resetHotkeyOverride: (id: HotkeyId) => void
  resetAllHotkeyOverrides: () => void
}

type Persisted = Pick<SettingsState, 'showGitBranchBadges' | 'hotkeyOverrides'>

function loadSettings(): Persisted {
  if (typeof localStorage === 'undefined') return { showGitBranchBadges: true, hotkeyOverrides: {} }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { showGitBranchBadges: true, hotkeyOverrides: {} }
    const parsed = JSON.parse(raw) as Partial<Persisted>
    return {
      showGitBranchBadges: parsed.showGitBranchBadges !== false,
      hotkeyOverrides: (parsed.hotkeyOverrides as Partial<Record<HotkeyId, HotkeyOverride>>) ?? {},
    }
  } catch {
    return { showGitBranchBadges: true, hotkeyOverrides: {} }
  }
}

function saveSettings(state: Persisted): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    showGitBranchBadges: state.showGitBranchBadges,
    hotkeyOverrides: state.hotkeyOverrides,
  }))
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...loadSettings(),

  setShowGitBranchBadges: (value) => {
    set({ showGitBranchBadges: value })
    const s = get()
    saveSettings({ showGitBranchBadges: s.showGitBranchBadges, hotkeyOverrides: s.hotkeyOverrides })
  },

  setHotkeyOverride: (id, override) => {
    const hotkeyOverrides = { ...get().hotkeyOverrides, [id]: override }
    set({ hotkeyOverrides })
    saveSettings({ showGitBranchBadges: get().showGitBranchBadges, hotkeyOverrides })
  },

  resetHotkeyOverride: (id) => {
    const hotkeyOverrides = { ...get().hotkeyOverrides }
    delete hotkeyOverrides[id]
    set({ hotkeyOverrides })
    saveSettings({ showGitBranchBadges: get().showGitBranchBadges, hotkeyOverrides })
  },

  resetAllHotkeyOverrides: () => {
    const hotkeyOverrides: Partial<Record<HotkeyId, HotkeyOverride>> = {}
    set({ hotkeyOverrides })
    saveSettings({ showGitBranchBadges: get().showGitBranchBadges, hotkeyOverrides })
  },
}))
