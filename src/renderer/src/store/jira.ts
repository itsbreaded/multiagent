import { create } from 'zustand'
import {
  DEFAULT_JIRA_BASE_URL,
  matchJiraIssueLabel,
  type JiraConnectionTestInput,
  type JiraConnectionTestResult,
  type JiraSettings,
  type JiraSettingsInput,
  type JiraStatusResult,
  type JiraTokenResult,
} from '../../../shared/jira'

export type JiraRowPhase = 'loading' | 'success' | 'stale' | 'unavailable'

export interface JiraProjectRow {
  tabId: string
  label: string
}

export interface JiraProjectMatch extends JiraProjectRow {
  issueKey: string
  prefix: string
}

export interface JiraRowState {
  tabId: string
  issueKey: string
  issueUrl?: string
  statusName?: string
  statusCategory?: string
  phase: JiraRowPhase
  errorCode?: string
  errorMessage?: string
  generation: number
  configVersion: number
  linkable: boolean
}

interface JiraStoreState {
  settings: JiraSettings
  hydrated: boolean
  configVersion: number
  labels: Record<string, string>
  projects: Record<string, JiraProjectMatch>
  rows: Record<string, JiraRowState>
  suppressedInitialTabs: Record<string, boolean>
  hydrateSettings: () => Promise<void>
  getToken: () => Promise<JiraTokenResult>
  saveSettings: (input: JiraSettingsInput) => Promise<{ ok: true } | { ok: false; error: string }>
  testConnection: (input: JiraConnectionTestInput) => Promise<JiraConnectionTestResult>
  syncProjects: (rows: readonly JiraProjectRow[]) => void
  refreshTab: (tabId: string) => Promise<void>
  refreshAll: () => Promise<void>
}

const DEFAULT_SETTINGS: JiraSettings = {
  baseUrl: DEFAULT_JIRA_BASE_URL,
  email: '',
  patterns: [],
  hasToken: false,
}

function asFailure(issueKey: string, message = 'Jira status is unavailable.'): JiraStatusResult {
  return { ok: false, issueKey, code: 'network', message }
}

export const useJiraStore = create<JiraStoreState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  hydrated: false,
  configVersion: 0,
  labels: {},
  projects: {},
  rows: {},
  suppressedInitialTabs: {},

  hydrateSettings: async () => {
    try {
      const settings = await window.ipc.invoke('jira:get-settings')
      set({ settings, hydrated: true })
    } catch {
      set({ hydrated: true })
    }
  },

  getToken: async () => window.ipc.invoke('jira:get-token'),

  testConnection: async (input) => {
    try {
      return await window.ipc.invoke('jira:test-connection', input)
    } catch {
      return { ok: false, error: 'Jira connection could not be tested.' }
    }
  },

  saveSettings: async (input) => {
    try {
      const result = await window.ipc.invoke('jira:save-settings', input)
      if (!result.ok) return result
      const currentLabels = Object.entries(get().labels).map(([tabId, label]) => ({ tabId, label }))
      const suppressedInitialTabs: Record<string, boolean> = {}
      for (const { tabId } of currentLabels) suppressedInitialTabs[tabId] = true
      set((state) => {
        const rows: Record<string, JiraRowState> = {}
        for (const [tabId, row] of Object.entries(state.rows)) {
          rows[tabId] = {
            ...row,
            phase: row.statusName ? 'stale' : 'unavailable',
            errorCode: 'settings_changed',
            errorMessage: 'Jira settings changed; refresh to update.',
            generation: row.generation + 1,
            configVersion: state.configVersion + 1,
            linkable: false,
          }
        }
        return {
          settings: result.settings,
          configVersion: state.configVersion + 1,
          rows,
          suppressedInitialTabs,
        }
      })
      // Reconcile eligibility immediately, but syncProjects will not issue an
      // initial request for rows that already existed at settings-save time.
      get().syncProjects(currentLabels)
      return { ok: true }
    } catch {
      return { ok: false, error: 'Jira settings could not be saved.' }
    }
  },

  syncProjects: (inputRows) => {
    const state = get()
    const suppressed = state.suppressedInitialTabs
    const nextLabels: Record<string, string> = {}
    const projects: Record<string, JiraProjectMatch> = {}
    const rows: Record<string, JiraRowState> = {}
    const initialTabIds: string[] = []
    const currentIds = new Set<string>()

    for (const input of inputRows) {
      if (!input || typeof input.tabId !== 'string') continue
      currentIds.add(input.tabId)
      nextLabels[input.tabId] = input.label
      const match = matchJiraIssueLabel(input.label, state.settings.patterns)
      if (!match) continue
      const project: JiraProjectMatch = { ...input, issueKey: match.issueKey, prefix: match.prefix }
      projects[input.tabId] = project
      const previousProject = state.projects[input.tabId]
      const previousRow = state.rows[input.tabId]
      const issueChanged = previousProject !== undefined && previousProject.issueKey !== project.issueKey
      const labelChanged = state.labels[input.tabId] !== input.label
      if (previousRow && !issueChanged) {
        rows[input.tabId] = { ...previousRow, issueKey: project.issueKey }
      } else if (!suppressed[input.tabId] || labelChanged || issueChanged) {
        rows[input.tabId] = {
          tabId: input.tabId,
          issueKey: project.issueKey,
          phase: 'loading',
          generation: (previousRow?.generation ?? 0) + 1,
          configVersion: state.configVersion,
          linkable: false,
        }
        initialTabIds.push(input.tabId)
      }
    }

    const nextSuppressed: Record<string, boolean> = {}
    for (const tabId of currentIds) if (suppressed[tabId]) nextSuppressed[tabId] = true
    set({ labels: nextLabels, projects, rows, suppressedInitialTabs: nextSuppressed })

    for (const tabId of initialTabIds) void get().refreshTab(tabId)
  },

  refreshTab: async (tabId) => {
    const before = get()
    const project = before.projects[tabId]
    if (!project) return
    const previous = before.rows[tabId]
    const generation = (previous?.generation ?? 0) + 1
    const configVersion = before.configVersion
    set((state) => ({
      rows: {
        ...state.rows,
        [tabId]: {
          tabId,
          issueKey: project.issueKey,
          issueUrl: previous?.issueUrl,
          statusName: previous?.statusName,
          statusCategory: previous?.statusCategory,
          phase: 'loading',
          generation,
          configVersion,
          linkable: previous?.linkable ?? false,
        },
      },
    }))

    let result: JiraStatusResult
    if (!before.settings.email || !before.settings.hasToken || !before.settings.baseUrl) {
      result = { ok: false, issueKey: project.issueKey, code: 'invalid_config', message: 'Jira is not configured for status lookup.' }
    } else {
      try {
        const response = await window.ipc.invoke('jira:fetch-status', project.issueKey)
        result = response && typeof response === 'object' && 'ok' in response
          ? response as JiraStatusResult
          : asFailure(project.issueKey)
      } catch {
        result = asFailure(project.issueKey)
      }
    }

    const current = get()
    const currentRow = current.rows[tabId]
    const currentProject = current.projects[tabId]
    if (!currentRow || currentRow.generation !== generation || current.configVersion !== configVersion || currentProject?.issueKey !== project.issueKey) return

    if (result.ok) {
      set((state) => ({
        rows: {
          ...state.rows,
          [tabId]: {
            ...state.rows[tabId],
            issueKey: result.issueKey,
            issueUrl: result.issueUrl,
            statusName: result.statusName,
            statusCategory: result.statusCategory,
            phase: 'success',
            errorCode: undefined,
            errorMessage: undefined,
            configVersion,
            linkable: true,
          },
        },
      }))
    } else {
      set((state) => {
        const row = state.rows[tabId]
        if (!row) return state
        const hasPrevious = Boolean(row.statusName)
        return {
          rows: {
            ...state.rows,
            [tabId]: {
              ...row,
              phase: hasPrevious ? 'stale' : 'unavailable',
              errorCode: result.code,
              errorMessage: result.message,
              linkable: hasPrevious ? row.linkable : false,
            },
          },
        }
      })
    }
  },

  refreshAll: async () => {
    const tabIds = Object.keys(get().projects)
    await Promise.all(tabIds.map((tabId) => get().refreshTab(tabId)))
  },
}))

export function jiraStoreProjects(): JiraProjectMatch[] {
  return Object.values(useJiraStore.getState().projects)
}
