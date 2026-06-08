import * as fs from 'fs'
import * as fsPromises from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'
import type { ScannedSession } from './TranscriptScanner'

interface CodexRecord {
  timestamp?: string
  type?: string
  payload?: {
    id?: string
    cwd?: string
    timestamp?: string
    type?: string
    message?: string
  }
}

interface SessionIndexRecord {
  id?: string
  thread_name?: string
  updated_at?: string
}

const scanCache = new Map<string, ScannedSession>()

function codexHome(): string {
  return process.env['CODEX_HOME'] || path.join(os.homedir(), '.codex')
}

function deriveProjectName(cwd: string): string {
  const normalized = cwd.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length >= 2) return parts.slice(-2).join('/')
  return parts[parts.length - 1] ?? cwd
}

function truncate(text: string, maxLen = 200): string {
  return text.length > maxLen ? text.slice(0, maxLen) : text
}

function parseRecord(line: string): CodexRecord | null {
  try {
    return JSON.parse(line) as CodexRecord
  } catch {
    return null
  }
}

async function walkJsonlFiles(dir: string): Promise<string[]> {
  const results: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true })
  } catch {
    return results
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...await walkJsonlFiles(entryPath))
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(entryPath)
    }
  }
  return results
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
  async scanAll(): Promise<ScannedSession[]> {
    const sessionsDir = path.join(codexHome(), 'sessions')
    const titles = await readSessionIndex()
    const files = await walkJsonlFiles(sessionsDir)
    const results: ScannedSession[] = []

    for (const filePath of files) {
      const session = await this.scanFile(filePath, titles)
      if (session) results.push(session)
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
    const cached = scanCache.get(cacheKey)
    if (cached) return cached

    for (const key of scanCache.keys()) {
      if (key.startsWith(`${filePath}:`)) scanCache.delete(key)
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
        scanCache.set(cacheKey, session)
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
