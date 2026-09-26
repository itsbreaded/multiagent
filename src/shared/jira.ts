export const DEFAULT_JIRA_BASE_URL = ''

export interface JiraSettings {
  baseUrl: string
  email: string
  patterns: string[]
  hasToken: boolean
}

export interface JiraSettingsInput {
  baseUrl: string
  email: string
  patterns: string[]
  apiToken?: string
  clearToken?: boolean
}

export interface JiraConnectionTestInput {
  baseUrl: string
  email: string
  apiToken: string
}

export type JiraSaveSettingsResult =
  | { ok: true; settings: JiraSettings }
  | { ok: false; error: string }

export type JiraTokenResult =
  | { ok: true; token: string }
  | { ok: false; error: string }

export type JiraConnectionTestResult =
  | { ok: true; message: string }
  | { ok: false; error: string }

export type JiraOpenIssueResult = { ok: true } | { ok: false; error: string }

export interface JiraIssueMatch {
  issueKey: string
  prefix: string
}

export type JiraFailureCode =
  | 'invalid_config'
  | 'invalid_response'
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'rate_limited'
  | 'network'

export interface JiraStatusSuccess {
  ok: true
  issueKey: string
  issueUrl: string
  statusName: string
  statusCategory?: string
}

export interface JiraStatusFailure {
  ok: false
  issueKey: string
  code: JiraFailureCode
  message: string
}

export type JiraStatusResult = JiraStatusSuccess | JiraStatusFailure

const ISSUE_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function normalizeJiraPatterns(patterns: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of patterns) {
    if (typeof raw !== 'string') continue
    const pattern = raw.trim()
    if (!pattern || /\s/.test(pattern)) continue
    const key = pattern.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(pattern)
  }
  return result
}

/**
 * Normalize a Jira site URL while rejecting credential-bearing or ambiguous
 * URL components. A path prefix is retained for Jira installations mounted
 * below the origin; query strings, fragments, and userinfo are never valid.
 */
export function normalizeJiraBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null
  const pathname = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.origin}${pathname}`
}

export function isJiraIssueKey(value: unknown): value is string {
  return typeof value === 'string' && ISSUE_KEY_RE.test(value)
}

export function matchJiraIssueLabel(label: unknown, patterns: readonly unknown[]): JiraIssueMatch | null {
  if (typeof label !== 'string') return null
  const token = label.trimStart().split(/\s+/)[0] ?? ''
  if (!token) return null

  for (const prefix of normalizeJiraPatterns(patterns)) {
    const prefixPattern = new RegExp(`^${escapeRegExp(prefix)}(\\d+)$`, 'i')
    if (!prefixPattern.test(token)) continue
    if (!isJiraIssueKey(token)) continue
    return { issueKey: token, prefix }
  }
  return null
}

export function buildJiraIssueUrl(baseUrl: unknown, issueKey: unknown): string | null {
  const normalizedBase = normalizeJiraBaseUrl(baseUrl)
  if (!normalizedBase || !isJiraIssueKey(issueKey)) return null
  return `${normalizedBase}/browse/${encodeURIComponent(issueKey)}`
}
