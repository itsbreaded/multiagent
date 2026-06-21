import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'
import { readdir } from 'fs/promises'
import type { AgentKind, Session, SessionSearchRequest, SessionSearchMatch, SessionSearchResult } from '../../shared/types'
import type { SessionIndex } from './SessionIndex'
import type { TranscriptScanner } from './TranscriptScanner'
import type { CodexSessionScanner } from './CodexSessionScanner'

const SNIPPET_MAX_LEN = 500
const DEFAULT_LIMIT = 50
const DEFAULT_MATCHES_PER_SESSION = 5
const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function claudeRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

function codexRoot(): string {
  return process.env['CODEX_HOME']
    ? path.join(process.env['CODEX_HOME'], 'sessions')
    : path.join(os.homedir(), '.codex', 'sessions')
}

async function walkJsonlFiles(dir: string): Promise<string[]> {
  const results: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...(await walkJsonlFiles(fullPath)))
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath)
    }
  }
  return results
}

function buildMatcher(query: string, caseSensitive: boolean, regex: boolean): (line: string) => boolean {
  if (regex) {
    const re = new RegExp(query, caseSensitive ? '' : 'i')
    return (line) => re.test(line)
  }
  if (caseSensitive) return (line) => line.includes(query)
  const lower = query.toLowerCase()
  return (line) => line.toLowerCase().includes(lower)
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text
}

function snippetAround(text: string, query: string, caseSensitive: boolean): string | null {
  const haystack = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  const idx = haystack.indexOf(needle)
  if (idx === -1) return null
  const start = Math.max(0, idx - 80)
  const end = Math.min(text.length, idx + needle.length + 80)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

interface ClaudeRecord {
  type?: string
  sessionId?: string
  cwd?: string
  timestamp?: string
  message?: {
    role?: string
    content?: string | Array<{ type: string; text?: string }>
  }
}

interface CodexRecord {
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

function extractClaudeText(record: ClaudeRecord): { text: string | null; role: SessionSearchMatch['role'] } {
  if (!record.message) return { text: null, role: 'unknown' }
  const rawRole = record.message.role
  const role: SessionSearchMatch['role'] =
    rawRole === 'user' ? 'user' :
    rawRole === 'assistant' ? 'assistant' :
    rawRole === 'tool' ? 'tool' :
    rawRole === 'system' ? 'system' :
    'unknown'
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

function extractCodexText(record: CodexRecord): { text: string | null; role: SessionSearchMatch['role'] } {
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

interface FileResult {
  agentKind: AgentKind
  sessionId: string
  filePath: string
  matches: SessionSearchMatch[]
}

async function searchFile(
  filePath: string,
  agentKind: AgentKind,
  matcher: (line: string) => boolean,
  request: SessionSearchRequest
): Promise<FileResult | null> {
  const matchesPerSession = request.matchesPerSession ?? DEFAULT_MATCHES_PER_SESSION
  const query = request.query
  const caseSensitive = request.caseSensitive ?? false

  let sessionId = agentKind === 'claude' ? path.basename(filePath, '.jsonl') : ''

  // Claude filenames are UUIDs; reject anything else
  if (agentKind === 'claude' && !CLAUDE_SESSION_ID_RE.test(sessionId)) return null

  const matches: SessionSearchMatch[] = []
  let lineNumber = 0
  let codexMetaFound = agentKind === 'claude'

  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

    const finish = (): void => {
      if (matches.length === 0 || !sessionId) {
        resolve(null)
      } else {
        resolve({ agentKind, sessionId, filePath, matches })
      }
    }

    rl.on('line', (line) => {
      if (!line.trim()) return
      lineNumber++

      // Extract Codex session ID from the first record (must be session_meta)
      if (agentKind === 'codex' && !codexMetaFound) {
        try {
          const record = JSON.parse(line) as CodexRecord
          if (record.type === 'session_meta' && record.payload?.id && record.payload.cwd) {
            sessionId = record.payload.id
            codexMetaFound = true
          } else {
            // First record is not session_meta — malformed file
            rl.close()
            stream.destroy()
            return
          }
        } catch {
          rl.close()
          stream.destroy()
          return
        }
        // Fall through — also check if the meta line itself is a match
      }

      if (matches.length >= matchesPerSession) return
      if (!matcher(line)) return

      try {
        let snippet: string
        let role: SessionSearchMatch['role'] = 'unknown'
        let timestamp: string | null = null

        if (agentKind === 'claude') {
          const record = JSON.parse(line) as ClaudeRecord
          timestamp = record.timestamp ?? null
          const { text, role: r } = extractClaudeText(record)
          role = r
          snippet = (text && snippetAround(text, query, caseSensitive)) ?? snippetAround(line, query, caseSensitive) ?? truncate(line, SNIPPET_MAX_LEN)
        } else {
          const record = JSON.parse(line) as CodexRecord
          timestamp = record.payload?.timestamp ?? record.timestamp ?? null
          const { text, role: r } = extractCodexText(record)
          role = r
          snippet = (text && snippetAround(text, query, caseSensitive)) ?? snippetAround(line, query, caseSensitive) ?? truncate(line, SNIPPET_MAX_LEN)
        }

        matches.push({ transcriptPath: filePath, lineNumber, timestamp, role, snippet })
      } catch {
        matches.push({
          transcriptPath: filePath,
          lineNumber,
          timestamp: null,
          role: 'unknown',
          snippet: truncate(line, SNIPPET_MAX_LEN),
        })
      }
    })

    rl.on('close', finish)
    rl.on('error', () => resolve(null))
    stream.on('error', () => resolve(null))
  })
}

function scoreResult(fileResult: FileResult, sessionMap: Map<string, Session>): number {
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

export class DeepSearcher {
  constructor(
    private claudeScanner: TranscriptScanner,
    private codexScanner: CodexSessionScanner,
    private index: SessionIndex
  ) {}

  async search(request: SessionSearchRequest, allSessions: Session[]): Promise<SessionSearchResult[]> {
    if (!request.query.trim()) return []

    let matcher: (line: string) => boolean
    try {
      matcher = buildMatcher(request.query, request.caseSensitive ?? false, request.regex ?? false)
    } catch {
      return []
    }

    const limit = request.limit ?? DEFAULT_LIMIT
    const kinds = request.agentKinds ?? (['claude', 'codex'] as AgentKind[])

    const sessionMap = new Map<string, Session>(allSessions.map((s) => [`${s.agentKind}:${s.sessionId}`, s]))

    const roots: Array<{ dir: string; agentKind: AgentKind }> = []
    if (kinds.includes('claude')) roots.push({ dir: claudeRoot(), agentKind: 'claude' })
    if (kinds.includes('codex')) roots.push({ dir: codexRoot(), agentKind: 'codex' })

    const fileJobs: Array<{ filePath: string; agentKind: AgentKind }> = []
    for (const root of roots) {
      const files = await walkJsonlFiles(root.dir)
      for (const f of files) fileJobs.push({ filePath: f, agentKind: root.agentKind })
    }

    const resultsByKey = new Map<string, FileResult>()

    for (const job of fileJobs) {
      // Collect up to 2× limit to account for unindexed sessions being skipped
      if (resultsByKey.size >= limit * 2) break

      const fileResult = await searchFile(job.filePath, job.agentKind, matcher, request)
      if (!fileResult) continue

      const key = `${fileResult.agentKind}:${fileResult.sessionId}`
      const existing = resultsByKey.get(key)
      if (existing) {
        // Two files sharing a sessionId (shouldn't happen, but merge gracefully)
        existing.matches.push(...fileResult.matches)
      } else {
        resultsByKey.set(key, fileResult)
      }
    }

    const results: SessionSearchResult[] = []

    for (const [key, fileResult] of resultsByKey) {
      let session = sessionMap.get(key)

      if (!session) {
        // Not in the index yet — scan the file and upsert so the result is hydrated
        try {
          const scanned =
            fileResult.agentKind === 'claude'
              ? await this.claudeScanner.scanFile(fileResult.filePath)
              : await this.codexScanner.scanFile(fileResult.filePath)
          if (scanned) {
            this.index.upsert(scanned)
            session = this.index.get(fileResult.agentKind, fileResult.sessionId) ?? undefined
          }
        } catch {
          // skip
        }
      }

      if (!session) continue

      const score = scoreResult(fileResult, sessionMap)
      results.push({
        session,
        score,
        matchCount: fileResult.matches.length,
        matches: fileResult.matches,
      })
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }
}
