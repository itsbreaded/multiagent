import { create } from 'zustand'

const SETTINGS_KEY = 'multiagent:settings'

interface SettingsState {
  showGitBranchBadges: boolean
  setShowGitBranchBadges: (value: boolean) => void
}

function loadSettings(): Pick<SettingsState, 'showGitBranchBadges'> {
  if (typeof localStorage === 'undefined') return { showGitBranchBadges: true }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { showGitBranchBadges: true }
    const parsed = JSON.parse(raw) as Partial<SettingsState>
    return { showGitBranchBadges: parsed.showGitBranchBadges !== false }
  } catch {
    return { showGitBranchBadges: true }
  }
}

function saveSettings(settings: Pick<SettingsState, 'showGitBranchBadges'>): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...loadSettings(),

  setShowGitBranchBadges: (value) => {
    set({ showGitBranchBadges: value })
    saveSettings({ showGitBranchBadges: get().showGitBranchBadges })
  },
}))
