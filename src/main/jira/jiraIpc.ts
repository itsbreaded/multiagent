import { buildJiraIssueUrl, isJiraIssueKey, type JiraConnectionTestInput, type JiraConnectionTestResult, type JiraOpenIssueResult, type JiraSaveSettingsResult, type JiraSettings, type JiraSettingsInput, type JiraStatusResult, type JiraTokenResult } from '../../shared/jira'
import { JiraClient } from './JiraClient'
import { JiraSettingsStore } from './JiraSettingsStore'

export interface JiraIpcController {
  getSettings(): JiraSettings
  getToken(): JiraTokenResult
  saveSettings(input: JiraSettingsInput): JiraSaveSettingsResult
  testConnection(input: JiraConnectionTestInput): Promise<JiraConnectionTestResult>
  fetchStatus(issueKey: string): Promise<JiraStatusResult>
  openIssue(issueKey: string): JiraOpenIssueResult
}

export function isPrimaryWindowSender(senderWindowId: number | null, primaryWindowId: number | null): boolean {
  return senderWindowId !== null && primaryWindowId !== null && senderWindowId === primaryWindowId
}

export function createJiraIpcController(
  settingsStore: JiraSettingsStore,
  client: JiraClient,
  openExternal: (url: string) => void,
): JiraIpcController {
  return {
    getSettings: () => settingsStore.getSettings(),
    getToken: () => settingsStore.getToken(),
    saveSettings: (input) => settingsStore.save(input),
    testConnection: (input) => client.testConnection({
      baseUrl: input.baseUrl,
      email: input.email,
      token: input.apiToken || null,
    }),
    fetchStatus: (issueKey) => client.fetchStatus(settingsStore.getStoredSettings(), issueKey),
    openIssue: (issueKey) => {
      settingsStore.reload()
      if (!isJiraIssueKey(issueKey)) return { ok: false, error: 'Invalid Jira issue key.' }
      const url = buildJiraIssueUrl(settingsStore.getStoredSettings().baseUrl, issueKey)
      if (!url) return { ok: false, error: 'Jira is not configured for links.' }
      openExternal(url)
      return { ok: true }
    },
  }
}
