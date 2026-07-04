import * as fs from 'fs'
import * as fsPromises from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'
import type { ScannedSession } from './TranscriptScanner'
import { deriveProjectName, parseJsonLine, truncate } from './transcriptParse'
import { walkJsonlFiles } from './fsWalk'

interface CodexRecord {
  timestamp?: string
  type?: string
  payload?: {
    id?: string
    cwd?: string
    timestamp?: string
    originator?: string
    source?: string
    type?: string
    message?: string
  }
}

export interface CodexSessionMeta {
  sessionId: string
  cwd: string
  timestamp: string | null
  originator: string | null
  source: string | null
}

interface SessionIndexRecord {
  id?: string
  thread_name?: string
  updated_at?: string
}

function codexHome(): string {
  return process.env['CODEX_HOME'] || path.join(os.homedir(), '.codex')
}

const parseRecord = (line: string): CodexRecord | null => parseJsonLine<CodexRecord>(line)

export async function listCodexSessionFilePaths(): Promise<string[]> {
  return walkJsonlFiles(codexSessionsDir())
}

export async function readCodexSessionMeta(filePath: string): Promise<CodexSessionMeta | null> {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
    let settled = false

    const done = (value: CodexSessionMeta | null): void => {
      if (settled) return
      settled = true
      rl.close()
      stream.destroy()
      resolve(value)
    }

    rl.on('line', (line) => {
      if (!line.trim()) return
      const record = parseRecord(line)
      if (record?.type !== 'session_meta' || !record.payload?.id || !record.payload.cwd) {
        done(null)
        return
      }
      done({
        sessionId: record.payload.id,
        cwd: record.payload.cwd,
        timestamp: record.payload.timestamp ?? record.timestamp ?? null,
        originator: record.payload.originator ?? null,
        source: record.payload.source ?? null,
      })
    })
    rl.on('close', () => done(null))
    rl.on('error', () => done(null))
    stream.on('error', () => done(null))
  })
}

async function readSessionIndex(): Promise<Map<string, SessionIndexRecord>> {
  const index = new Map<string, SessionIndexRecord>()
  const indexPath = path.join(codexHome(), 'session_index.jsonl')

  return new Promise((resolve) => {
    const stream = fs.createReadStream(indexPath, { encoding: 'utf8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

    rl.on('line', (line) => {
      if (!line.trim()) return
      try {
        const record = JSON.parse(line) as SessionIndexRecord
        if (record.id) index.set(record.id, record)
      } catch { /* skip malformed lines */ }
    })
    rl.on('close', () => resolve(index))
    rl.on('error', () => resolve(index))
    stream.on('error', () => resolve(index))
  })
}

export class CodexSessionScanner {
  private scanCache = new Map<string, ScannedSession>()

  async scanAll(): Promise<ScannedSession[]> {
    const sessionsDir = path.join(codexHome(), 'sessions')
    const titles = await readSessionIndex()
    const files = await walkJsonlFiles(sessionsDir)
    const results: ScannedSession[] = []

    for (const filePath of files) {
      const session = await this.scanFile(filePath, titles)
      if (session) results.push(session)
    }
    for (const key of this.scanCache.keys()) {
      const separator = key.lastIndexOf(':')
      if (separator >= 0 && !files.includes(key.slice(0, separator))) this.scanCache.delete(key)
    }

    return results
  }

  async scanFile(
    filePath: string,
    titles = new Map<string, SessionIndexRecord>()
  ): Promise<ScannedSession | null> {
    let mtimeMs: number
    try {
      const info = await fsPromises.stat(filePath)
      mtimeMs = info.mtimeMs
    } catch {
      return null
    }

    const cacheKey = `${filePath}:${mtimeMs}`
    const cached = this.scanCache.get(cacheKey)
    if (cached) return cached

    for (const key of this.scanCache.keys()) {
      if (key.startsWith(`${filePath}:`)) this.scanCache.delete(key)
    }

    return new Promise((resolve) => {
      let sessionId = ''
      let cwd = ''
      let firstActivity: string | null = null
      let lastActivity: string | null = null
      let firstMessage: string | null = null
      let lastMessage: string | null = null
      let messageCount = 0

      const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

      rl.on('line', (line) => {
        if (!line.trim()) return
        const record = parseRecord(line)
        if (!record) return

        const timestamp = record.timestamp ?? record.payload?.timestamp ?? null
        if (timestamp) {
          if (!firstActivity) firstActivity = timestamp
          lastActivity = timestamp
        }

        if (record.type === 'session_meta') {
          if (!sessionId && record.payload?.id) sessionId = record.payload.id
          if (!cwd && record.payload?.cwd) cwd = record.payload.cwd
        }

        if (record.type === 'event_msg' && record.payload?.type === 'user_message') {
          const text = record.payload.message?.trim()
          if (!text) return
          messageCount++
          const truncated = truncate(text)
          if (!firstMessage) firstMessage = truncated
          lastMessage = truncated
        }
      })

      rl.on('close', () => {
        if (!sessionId || !cwd) {
          resolve(null)
          return
        }

        const indexed = titles.get(sessionId)
        const session: ScannedSession = {
          agentKind: 'codex',
          sessionId,
          cwd,
          projectName: deriveProjectName(cwd),
          displayName: indexed?.thread_name ?? null,
          gitBranch: null,
          firstMessage,
          lastMessage,
          firstActivity,
          lastActivity: indexed?.updated_at ?? lastActivity,
          messageCount,
          filePath,
          transcriptPath: filePath,
          mtimeMs
        }
        this.scanCache.set(cacheKey, session)
        resolve(session)
      })
      rl.on('error', () => resolve(null))
      stream.on('error', () => resolve(null))
    })
  }
}

export function codexSessionsDir(): string {
  return path.join(codexHome(), 'sessions')
}
