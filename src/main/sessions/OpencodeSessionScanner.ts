// spec 052: OpenCode session scanner. Reads OpenCode's SQLite DB at
// ~/.local/share/opencode/opencode.db (the path `opencode db path` prints) and maps the
// `session`/`message`/`part` tables to the `ScannedSession` shape the Session Browser and
// DeepSearcher consume. Parallel to TranscriptScanner (Claude JSONL) and CodexSessionScanner
// (Codex JSONL), but SQLite-backed instead of file-stream-backed.
//
// The schema is NOT a documented stable contract (verified against OpenCode 1.18.5). The
// scanner queries defensively: it checks `PRAGMA table_info` for the expected columns before
// querying, and on any schema mismatch `scanAll()` returns `[]` and `scanFile()` returns
// null (fail closed -- a schema mismatch degrades to "no OpenCode sessions indexed," never
// crashes the scan). A version bump that renames columns would silently drop OpenCode from
// the Session Browser until the queries are updated.
//
// Read-only: opens the DB with better-sqlite3's `{ readonly: true }` option (a plain file
// path, NOT a `file:...?mode=ro` URI -- verified live on Windows that this better-sqlite3
// build's URI-filename support fails to open at all here, throwing "unable to open database
// file" even for a valid path; the plain-path + `readonly` option achieves the same
// don't-write guarantee without that failure mode). The DB runs in WAL mode under a live
// OpenCode; a readonly open of a plain path is safe concurrently.

import Database from 'better-sqlite3'
import * as path from 'path'
import * as os from 'os'
import type { AgentKind, SessionSearchMatch } from '../../shared/types'
import type { ScannedSession } from './TranscriptScanner'
import type { FileResult } from './deepSearch'
import { deriveProjectName, truncate } from './transcriptParse'
import { snippetAround, SNIPPET_MAX_LEN } from './deepSearch'

/** Resolve the OpenCode data dir: honors OPENCODE_CONFIG_DIR is NOT the data dir -- the
 * data dir is ~/.local/share/opencode on all platforms (verified via `opencode db path`).
 * There is no env override for the data dir in OpenCode 1.18.x. */
function opencodeDataDir(): string {
  return path.join(os.homedir(), '.local', 'share', 'opencode')
}

export function opencodeDbPath(): string {
  return path.join(opencodeDataDir(), 'opencode.db')
}

// Expected columns (subset we query). A schema mismatch on any of these → fail closed.
const EXPECTED_SESSION_COLS = new Set(['id', 'directory', 'title', 'time_created', 'time_updated', 'parent_id', 'time_archived'])
const EXPECTED_MESSAGE_COLS = new Set(['id', 'session_id', 'time_created', 'data'])
const EXPECTED_PART_COLS = new Set(['id', 'session_id', 'time_created', 'data'])

interface Row {
  id: string
  directory: string
  title: string
  time_created: number
  time_updated: number
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return new Set(rows.map((r) => r.name))
  } catch {
    return new Set()
  }
}

function schemaOk(db: Database.Database): boolean {
  const s = tableColumns(db, 'session')
  const m = tableColumns(db, 'message')
  const p = tableColumns(db, 'part')
  if (!s.size || !m.size || !p.size) return false
  for (const c of EXPECTED_SESSION_COLS) if (!s.has(c)) return false
  for (const c of EXPECTED_MESSAGE_COLS) if (!m.has(c)) return false
  for (const c of EXPECTED_PART_COLS) if (!p.has(c)) return false
  return true
}

/** Extract searchable text + role from a `part.data` JSON row. text/reasoning parts carry
 * `text`; tool parts carry `state.input`/`state.output`. Returns the concatenated text and
 * the message role (user/assistant) for snippet construction. */
function partText(dataJson: string): string {
  try {
    const d = JSON.parse(dataJson) as { type?: string; text?: string; state?: { input?: unknown; output?: unknown } }
    if (typeof d.text === 'string') return d.text
    if (d.type === 'tool' && d.state) {
      const parts: string[] = []
      if (d.state.input) parts.push(typeof d.state.input === 'string' ? d.state.input : JSON.stringify(d.state.input))
      if (d.state.output) parts.push(typeof d.state.output === 'string' ? d.state.output : JSON.stringify(d.state.output))
      return parts.join(' ')
    }
    return ''
  } catch {
    return ''
  }
}

function messageRole(dataJson: string): 'user' | 'assistant' | 'unknown' {
  try {
    const d = JSON.parse(dataJson) as { role?: string }
    if (d.role === 'user') return 'user'
    if (d.role === 'assistant') return 'assistant'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/** A single session's first/last user message text + activity span + message count. */
interface SessionDetail {
  firstMessage: string | null
  lastMessage: string | null
  firstActivity: string | null
  lastActivity: string | null
  messageCount: number
}

export class OpencodeSessionScanner {
  private db: Database.Database | null = null
  private dbPath: string
  private schemaValid = false

  constructor(dbPath: string = opencodeDbPath()) {
    this.dbPath = dbPath
  }

  private open(): boolean {
    if (this.db) return this.schemaValid
    try {
      // Plain path, NOT a `file:...` URI (see file header) -- `readonly: true` alone gives
      // us the read-only guarantee; WAL is fine for concurrent readers.
      this.db = new Database(this.dbPath, { readonly: true, fileMustExist: false })
      this.schemaValid = schemaOk(this.db)
      if (!this.schemaValid) {
        // Close immediately; we'll fail closed on every call until the schema changes.
        this.db.close()
        this.db = null
      }
    } catch {
      // DB missing (OpenCode not installed / no sessions yet) -- fail closed silently.
      this.db = null
      this.schemaValid = false
    }
    return this.schemaValid
  }

  async scanAll(): Promise<ScannedSession[]> {
    if (!this.open()) return []
    if (!this.db) return []
    try {
      const rows = this.db.prepare(
        `SELECT id, directory, title, time_created, time_updated FROM session WHERE parent_id IS NULL AND time_archived IS NULL ORDER BY time_updated DESC`
      ).all() as Row[]
      const out: ScannedSession[] = []
      for (const r of rows) {
        const detail = this.sessionDetail(r.id)
        out.push(this.toScannedSession(r, detail))
      }
      return out
    } catch {
      return []
    }
  }

  async scanFile(sessionId: string): Promise<ScannedSession | null> {
    if (!this.open()) return null
    if (!this.db) return null
    try {
      const r = this.db.prepare(
        `SELECT id, directory, title, time_created, time_updated FROM session WHERE id = ? AND parent_id IS NULL AND time_archived IS NULL`
      ).get(sessionId) as Row | undefined
      if (!r) return null
      const detail = this.sessionDetail(r.id)
      return this.toScannedSession(r, detail)
    } catch {
      return null
    }
  }

  private sessionDetail(sessionId: string): SessionDetail {
    const empty: SessionDetail = {
      firstMessage: null,
      lastMessage: null,
      firstActivity: null,
      lastActivity: null,
      messageCount: 0,
    }
    if (!this.db) return empty
    try {
      const msgRows = this.db.prepare(
        `SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC`
      ).all(sessionId) as Array<{ id: string; time_created: number; data: string }>
      if (msgRows.length === 0) return empty

      let firstUser: string | null = null
      let lastUser: string | null = null
      let minTime = msgRows[0].time_created
      let maxTime = msgRows[0].time_created
      for (const m of msgRows) {
        if (m.time_created < minTime) minTime = m.time_created
        if (m.time_created > maxTime) maxTime = m.time_created
        const role = messageRole(m.data)
        if (role === 'user') {
          // Pull the text of the message's first text-type part as the user message content.
          // Skip IDE-injected `<system-reminder>` notes (OpenCode's analog of Claude's
          // `<command`/`<local-command` synthesized records, filtered the same way in
          // transcriptParse.ts's isRealUserMessage) -- these carry no real conversation
          // content and would otherwise show up as an uninformative firstMessage/lastMessage.
          const text = this.firstPartText(sessionId, m.id)
          if (text && !text.trimStart().startsWith('<system-reminder>')) {
            if (firstUser === null) firstUser = text
            lastUser = text
          }
        }
      }
      return {
        firstMessage: firstUser ? truncate(firstUser, 200) : null,
        lastMessage: lastUser ? truncate(lastUser, 200) : null,
        firstActivity: new Date(minTime).toISOString(),
        lastActivity: new Date(maxTime).toISOString(),
        messageCount: msgRows.length,
      }
    } catch {
      return empty
    }
  }

  private firstPartText(sessionId: string, messageId: string): string | null {
    if (!this.db) return null
    try {
      const partRows = this.db.prepare(
        `SELECT data FROM part WHERE session_id = ? AND message_id = ? ORDER BY time_created ASC`
      ).all(sessionId, messageId) as Array<{ data: string }>
      for (const p of partRows) {
        const t = partText(p.data)
        if (t) return t
      }
      return null
    } catch {
      return null
    }
  }

  private toScannedSession(r: Row, detail: SessionDetail): ScannedSession {
    // OpenCode stores directories with forward slashes (e.g. "C:/Code/multiagent").
    const cwd = r.directory
    return {
      agentKind: 'opencode' as AgentKind,
      sessionId: r.id,
      cwd,
      projectName: deriveProjectName(cwd),
      displayName: r.title || null,
      gitBranch: null,
      firstMessage: detail.firstMessage,
      lastMessage: detail.lastMessage,
      firstActivity: detail.firstActivity,
      lastActivity: detail.lastActivity,
      messageCount: detail.messageCount,
      filePath: this.dbPath,
      transcriptPath: `opencode:${r.id}`,
      mtimeMs: r.time_updated,
    }
  }

  /**
   * spec 052 deep search: scan the `part` table for rows whose `data` JSON text fields
   * match the predicate, grouped by session. Returns one `FileResult` per matching session
   * (filePath = the DB path; transcriptPath = `opencode:<sessionId>`). The matcher is the
   * same pure predicate the file-walk path uses (`buildMatcher`); we apply it to the
   * extracted text of each part rather than to a raw line. Fail-closed: any error → [].
   */
  searchParts(
    matcher: (text: string) => boolean,
    query: string,
    caseSensitive: boolean,
    matchesPerSession: number,
    cwdFilter?: string,
  ): FileResult[] {
    if (!this.open() || !this.db) return []
    try {
      // Pull every part row with its session + message context. For OpenCode's session
      // sizes (hundreds of parts per session) this is fine; a LIKE pre-filter on the raw
      // data column narrows it before the JS matcher runs, so we don't pay for JSON.parse
      // on non-matching rows. The LIKE is case-insensitive by default in SQLite for ASCII.
      const like = `%${query.replace(/[%_]/g, (c) => '\\' + c)}%`
      const partRows = this.db.prepare(
        `SELECT p.session_id AS sid, p.time_created AS t, p.data AS data, m.data AS mdata
         FROM part p LEFT JOIN message m ON p.message_id = m.id
         WHERE p.data LIKE ? ESCAPE '\\' ORDER BY p.time_created ASC`
      ).all(like) as Array<{ sid: string; t: number; data: string; mdata: string | null }>

      const bySession = new Map<string, SessionSearchMatch[]>()
      for (const p of partRows) {
        const text = partText(p.data)
        if (!text || !matcher(text)) continue
        const role = p.mdata ? messageRole(p.mdata) : 'unknown'
        const snippet = snippetAround(text, query, caseSensitive) ?? truncate(text, SNIPPET_MAX_LEN)
        const arr = bySession.get(p.sid) ?? []
        if (arr.length < matchesPerSession) {
          arr.push({
            transcriptPath: `opencode:${p.sid}`,
            lineNumber: 0,
            timestamp: new Date(p.t).toISOString(),
            role: role === 'unknown' ? 'unknown' : role,
            snippet,
          })
          bySession.set(p.sid, arr)
        }
      }

      const results: FileResult[] = []
      for (const [sid, matches] of bySession) {
        // Optional cwd filter: look up the session's directory.
        if (cwdFilter) {
          try {
            const r = this.db.prepare('SELECT directory FROM session WHERE id = ?').get(sid) as { directory: string } | undefined
            if (!r || r.directory.replace(/\\/g, '/') !== cwdFilter.replace(/\\/g, '/')) continue
          } catch { /* skip */ }
        }
        results.push({ agentKind: 'opencode' as AgentKind, sessionId: sid, filePath: this.dbPath, matches })
      }
      return results
    } catch {
      return []
    }
  }

  dispose(): void {
    if (this.db) {
      try { this.db.close() } catch { /* ignore */ }
      this.db = null
    }
  }
}