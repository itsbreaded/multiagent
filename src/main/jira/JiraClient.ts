import { buildJiraIssueUrl, normalizeJiraBaseUrl, type JiraConnectionTestResult, type JiraStatusResult } from '../../shared/jira'
import type { JiraStoredSettings } from './JiraSettingsStore'

export interface JiraFetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type JiraFetch = (url: string, init: RequestInit) => Promise<JiraFetchResponse>

export interface JiraClientOptions {
  fetch?: JiraFetch
  timeoutMs?: number
}

const FAILURE_MESSAGES = {
  invalid_config: 'Jira is not configured for status lookup.',
  invalid_response: 'Jira returned an invalid status response.',
  auth: 'Jira authentication was rejected.',
  permission: 'Jira access is not permitted for this issue.',
  not_found: 'The Jira issue was not found.',
  rate_limited: 'Jira rate limited this request. Try again later.',
  network: 'Jira could not be reached.',
} as const

const CONNECTION_FAILURE_MESSAGES = {
  invalid_config: 'Enter a Jira base URL, account email, and API token first.',
  auth: 'Jira authentication was rejected.',
  permission: 'Jira access is not permitted.',
  rate_limited: 'Jira rate limited this request. Try again later.',
  network: 'Jira could not be reached.',
} as const

function failure(issueKey: string, code: keyof typeof FAILURE_MESSAGES): JiraStatusResult {
  return { ok: false, issueKey, code, message: FAILURE_MESSAGES[code] }
}

function classifyHttpFailure(issueKey: string, status: number): JiraStatusResult {
  if (status === 401) return failure(issueKey, 'auth')
  if (status === 403) return failure(issueKey, 'permission')
  if (status === 404) return failure(issueKey, 'not_found')
  if (status === 429) return failure(issueKey, 'rate_limited')
  return failure(issueKey, 'network')
}

function classifyConnectionHttpFailure(status: number): JiraConnectionTestResult {
  if (status === 401) return { ok: false, error: CONNECTION_FAILURE_MESSAGES.auth }
  if (status === 403) return { ok: false, error: CONNECTION_FAILURE_MESSAGES.permission }
  if (status === 429) return { ok: false, error: CONNECTION_FAILURE_MESSAGES.rate_limited }
  return { ok: false, error: CONNECTION_FAILURE_MESSAGES.network }
}

export class JiraClient {
  private readonly fetchImpl: JiraFetch
  private readonly timeoutMs: number

  constructor(options: JiraClientOptions = {}) {
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as JiraFetch)
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  async fetchStatus(settings: JiraStoredSettings, issueKey: string): Promise<JiraStatusResult> {
    const issueUrl = buildJiraIssueUrl(settings.baseUrl, issueKey)
    if (!issueUrl || !settings.email || !settings.token) return failure(issueKey, 'invalid_config')

    const requestUrl = `${settings.baseUrl.replace(/\/+$/, '')}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=status`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const authorization = Buffer.from(`${settings.email}:${settings.token}`, 'utf8').toString('base64')
      const response = await this.fetchImpl(requestUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${authorization}`,
        },
        signal: controller.signal,
        redirect: 'error',
      })
      if (!response.ok) return classifyHttpFailure(issueKey, response.status)

      let body: unknown
      try {
        body = await response.json()
      } catch {
        return failure(issueKey, 'invalid_response')
      }
      const status = (body as { fields?: { status?: { name?: unknown; statusCategory?: { name?: unknown } } } } | null)?.fields?.status
      if (!status || typeof status.name !== 'string' || !status.name.trim()) {
        return failure(issueKey, 'invalid_response')
      }
      const statusCategory = typeof status.statusCategory?.name === 'string' && status.statusCategory.name.trim()
        ? status.statusCategory.name
        : undefined
      return {
        ok: true,
        issueKey,
        issueUrl,
        statusName: status.name,
        ...(statusCategory ? { statusCategory } : {}),
      }
    } catch {
      return failure(issueKey, 'network')
    } finally {
      clearTimeout(timer)
    }
  }

  async testConnection(settings: Pick<JiraStoredSettings, 'baseUrl' | 'email' | 'token'>): Promise<JiraConnectionTestResult> {
    const baseUrl = normalizeJiraBaseUrl(settings.baseUrl)
    const email = settings.email.trim()
    if (!baseUrl || !email || !settings.token) {
      return { ok: false, error: CONNECTION_FAILURE_MESSAGES.invalid_config }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const authorization = Buffer.from(`${email}:${settings.token}`, 'utf8').toString('base64')
      const response = await this.fetchImpl(`${baseUrl}/rest/api/3/myself`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${authorization}`,
        },
        signal: controller.signal,
        redirect: 'error',
      })
      if (!response.ok) return classifyConnectionHttpFailure(response.status)
      return { ok: true, message: 'Jira connection succeeded.' }
    } catch {
      return { ok: false, error: CONNECTION_FAILURE_MESSAGES.network }
    } finally {
      clearTimeout(timer)
    }
  }
}
