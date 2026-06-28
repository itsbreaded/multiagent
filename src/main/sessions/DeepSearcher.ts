import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'
import { readdir } from 'fs/promises'
import type { AgentKind, Session, SessionSearchRequest, SessionSearchMatch, SessionSearchResult } from '../../shared/types'
import type { SessionIndex } from './SessionIndex'
import type { TranscriptScanner } from './TranscriptScanner'
import type { CodexSessionScanner } from './CodexSessionScanner'
import {
  buildMatcher,
  snippetAround,
  truncate,
  scoreResult,
  extractClaudeText,
  extractCodexText,
  SNIPPET_MAX_LEN,
  DEFAULT_LIMIT,
  DEFAULT_MATCHES_PER_SESSION,
  CLAUDE_SESSION_ID_RE,
  type FileResult,
  type ClaudeRecord,
  type CodexRecord,
} from './deepSearch'

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
