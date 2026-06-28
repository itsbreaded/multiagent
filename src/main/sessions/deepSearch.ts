import type { AgentKind, Session, SessionSearchMatch } from '../../shared/types'

/**
 * Pure helpers for full-transcript deep search — extracted from
 * `DeepSearcher.ts` so the matcher modes, snippet windowing, role/recency
 * ranking, and per-result caps can be tested without walking the filesystem or
 * loading better-sqlite3 (which is Electron-ABI only and unavailable under plain
 * Node — see spec 030).
 *
 * Ranking determinism: `scoreResult` reads `Date.now()` for recency, so tests
 * must pin the clock (`vi.setSystemTime`) and supply fixtures with fixed
 * `lastActivity` timestamps.
 */

export const SNIPPET_MAX_LEN = 500
export const DEFAULT_LIMIT = 50
export const DEFAULT_MATCHES_PER_SESSION = 5
export const CLAUDE_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Build a line matcher honoring the regex + case-sensitivity flags. Throws on a bad regex. */
export function buildMatcher(
  query: string,
  caseSensitive: boolean,
  regex: boolean
): (line: string) => boolean {
  if (regex) {
    const re = new RegExp(query, caseSensitive ? '' : 'i')
    return (line) => re.test(line)
  }
  if (caseSensitive) return (line) => line.includes(query)
  const lower = query.toLowerCase()
  return (line) => line.toLowerCase().includes(lower)
}

/** Truncate to `maxLen`, appending an ellipsis when truncated (deep-search preview style). */
export function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text
}

/** Return a ~160-char window around the first match, with leading/trailing ellipses. */
export function snippetAround(text: string, query: string, caseSensitive: boolean): string | null {
  const haystack = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  const idx = haystack.indexOf(needle)
  if (idx === -1) return null
  const start = Math.max(0, idx - 80)
  const end = Math.min(text.length, idx + needle.length + 80)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

export interface ClaudeRecord {
  type?: string
  sessionId?: string
  cwd?: string
  timestamp?: string
  message?: {
    role?: string
    content?: string | Array<{ type: string; text?: string }>
  }
}

export interface CodexRecord {
  timestamp?: string
  type?: string
  payload?: {
    id?: string
    cwd?: string
    timestamp?: string
    type?: string
    message?: string
    content?: Array<{ type: string; text?: string }>
  }
}

/** Extract human-readable text + role badge from a Claude transcript line. */
export function extractClaudeText(record: ClaudeRecord): {
  text: string | null
  role: SessionSearchMatch['role']
} {
  if (!record.message) return { text: null, role: 'unknown' }
  const rawRole = record.message.role
  const role: SessionSearchMatch['role'] =
    rawRole === 'user'
      ? 'user'
      : rawRole === 'assistant'
        ? 'assistant'
        : rawRole === 'tool'
          ? 'tool'
          : rawRole === 'system'
            ? 'system'
            : 'unknown'
  const content = record.message.content
  if (typeof content === 'string') return { text: content, role }
  if (Array.isArray(content)) {
    const textParts = content.filter((c) => c.type === 'text' && c.text).map((c) => c.text as string)
    if (textParts.length > 0) return { text: textParts.join('\n'), role }
    // tool_use/tool_result blocks - compact preview
    if (content[0]) return { text: JSON.stringify(content[0]).slice(0, 300), role: 'tool' }
  }
  return { text: null, role }
}

/** Extract human-readable text + role badge from a Codex transcript line. */
export function extractCodexText(record: CodexRecord): {
  text: string | null
  role: SessionSearchMatch['role']
} {
  if (!record.payload) return { text: null, role: 'unknown' }
  if (record.type === 'event_msg' && record.payload.type === 'user_message') {
    return { text: record.payload.message ?? null, role: 'user' }
  }
  if (record.type === 'response_item') {
    const content = record.payload.content
    if (Array.isArray(content)) {
      const text = content
        .filter((c) => c.type === 'output_text' || c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n')
      return { text: text || null, role: 'assistant' }
    }
    if (record.payload.message) return { text: record.payload.message, role: 'assistant' }
  }
  return { text: null, role: 'unknown' }
}

export interface FileResult {
  agentKind: AgentKind
  sessionId: string
  filePath: string
  matches: SessionSearchMatch[]
}

/**
 * Score a file's matches for result ranking: match count (capped at 10), a per-role
 * bonus (user/assistant weighted above tool/system), and a recency bonus that decays
 * over ~30 days. Recency reads `Date.now()` — pin the clock in tests.
 */
export function scoreResult(fileResult: FileResult, sessionMap: Map<string, Session>): number {
  const session = sessionMap.get(`${fileResult.agentKind}:${fileResult.sessionId}`)
  let score = Math.min(fileResult.matches.length, 10) * 10

  for (const match of fileResult.matches) {
    if (match.role === 'user' || match.role === 'assistant') score += 5
    else if (match.role === 'tool' || match.role === 'system') score += 2
  }

  if (session?.lastActivity) {
    const ageDays = (Date.now() - new Date(session.lastActivity).getTime()) / (1000 * 60 * 60 * 24)
    score += Math.max(0, 30 - Math.floor(ageDays))
  }

  return score
}
