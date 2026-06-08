import * as fs from 'fs'
import * as fsPromises from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'
import type { AgentKind } from '../../shared/types'

export interface ScannedSession {
  agentKind: AgentKind
  sessionId: string
  cwd: string
  projectName: string
  displayName: string | null
  gitBranch: string | null
  firstMessage: string | null
  lastMessage: string | null
  firstActivity: string | null
  lastActivity: string | null
  messageCount: number
  filePath: string
  transcriptPath: string
  mtimeMs: number
}

interface JsonlRecord {
  type?: string
  sessionId?: string
  cwd?: string
  gitBranch?: string
  timestamp?: string
  isMeta?: boolean
  message?: {
    role?: string
    content?: string | Array<{ type: string; text?: string }>
  }
}

// Cache: filePath:mtimeMs -> ScannedSession
const scanCache = new Map<string, ScannedSession>()

function extractText(record: JsonlRecord): string | null {
  if (!record.message) return null
  const content = record.message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const textItem = content.find((c) => c.type === 'text')
    return textItem?.text ?? null
  }
  return null
}

function isRealUserMessage(record: JsonlRecord): boolean {
  if (record.type !== 'user') return false
  if (record.isMeta === true) return false
  const text = extractText(record)
  if (!text) return false
  if (text.startsWith('<command') || text.startsWith('<local-command')) return false
  return true
}

function truncate(text: string, maxLen = 200): string {
  return text.length > maxLen ? text.slice(0, maxLen) : text
}

function parseRecord(line: string): JsonlRecord | null {
  try {
    return JSON.parse(line) as JsonlRecord
  } catch {
    return null
  }
}

function deriveProjectName(cwd: string): string {
  // Normalize separators
  const normalized = cwd.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length >= 2) {
    return parts.slice(-2).join('/')
  }
  return parts[parts.length - 1] ?? cwd
}

async function readLines(filePath: string, maxLines: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = []
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

    rl.on('line', (line) => {
      lines.push(line)
      if (lines.length >= maxLines) {
        rl.close()
        stream.destroy()
      }
    })

    rl.on('close', () => resolve(lines))
    rl.on('error', reject)
    stream.on('error', reject)
  })
}

async function readLastLines(filePath: string, maxLines: number): Promise<string[]> {
  // Read the entire file tail by streaming with a rolling buffer
  return new Promise((resolve, reject) => {
    const buffer: string[] = []
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

    rl.on('line', (line) => {
      buffer.push(line)
      if (buffer.length > maxLines) {
        buffer.shift()
      }
    })

    rl.on('close', () => resolve(buffer))
    rl.on('error', reject)
    stream.on('error', reject)
  })
}

export class TranscriptScanner {
  async scanAll(): Promise<ScannedSession[]> {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects')

    let projectDirs: string[]
    try {
      const entries = await fsPromises.readdir(projectsDir, { withFileTypes: true })
      projectDirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => path.join(projectsDir, e.name))
    } catch {
      return []
    }

    const results: ScannedSession[] = []

    for (const projectDir of projectDirs) {
      let files: string[]
      try {
        const entries = await fsPromises.readdir(projectDir, { withFileTypes: true })
        files = entries
          .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
          .map((e) => path.join(projectDir, e.name))
      } catch {
        continue
      }

      for (const filePath of files) {
        const session = await this.scanFile(filePath)
        if (session) results.push(session)
      }
    }

    return results
  }

  async scanFile(filePath: string): Promise<ScannedSession | null> {
    let stat: fsPromises.FileHandle | undefined
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

    // Clear stale cache entries for this file path
    for (const key of scanCache.keys()) {
      if (key.startsWith(`${filePath}:`)) {
        scanCache.delete(key)
      }
    }

    void stat

    let sessionId = ''
    let cwd = ''
    let gitBranch: string | null = null
    let firstActivity: string | null = null
    let lastActivity: string | null = null
    let firstMessage: string | null = null
    let lastMessage: string | null = null
    let messageCount = 0

    try {
      // Read first 40 lines for header info
      const headLines = await readLines(filePath, 40)

      for (const line of headLines) {
        if (!line.trim()) continue
        const record = parseRecord(line)
        if (!record) continue

        if (!sessionId && record.sessionId) sessionId = record.sessionId
        if (!cwd && record.cwd) cwd = record.cwd
        if (!gitBranch && record.gitBranch) gitBranch = record.gitBranch
        if (!firstActivity && record.timestamp) firstActivity = record.timestamp

        if (isRealUserMessage(record)) {
          messageCount++
          if (!firstMessage) {
            const text = extractText(record)
            if (text) firstMessage = truncate(text)
          }
          const text = extractText(record)
          if (text) lastMessage = truncate(text)
        }
      }

      // Read last 15 lines for tail info
      const tailLines = await readLastLines(filePath, 15)

      for (const line of tailLines) {
        if (!line.trim()) continue
        const record = parseRecord(line)
        if (!record) continue

        if (record.timestamp) lastActivity = record.timestamp

        if (isRealUserMessage(record)) {
          const text = extractText(record)
          if (text) lastMessage = truncate(text)
        }
      }

      // Count remaining messages by streaming full file
      // We already counted up to 40 lines above - do a full count pass
      messageCount = await countUserMessages(filePath)
    } catch {
      return null
    }

    if (!sessionId || !cwd) return null

    const session: ScannedSession = {
      agentKind: 'claude',
      sessionId,
      cwd,
      projectName: deriveProjectName(cwd),
      displayName: null,
      gitBranch,
      firstMessage,
      lastMessage,
      firstActivity,
      lastActivity,
      messageCount,
      filePath,
      transcriptPath: filePath,
      mtimeMs
    }

    scanCache.set(cacheKey, session)
    return session
  }
}

async function countUserMessages(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let count = 0
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

    rl.on('line', (line) => {
      if (!line.trim()) return
      const record = parseRecord(line)
      if (record && isRealUserMessage(record)) count++
    })

    rl.on('close', () => resolve(count))
    rl.on('error', reject)
    stream.on('error', reject)
  })
}
