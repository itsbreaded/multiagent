import * as fs from 'fs'
import * as fsPromises from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'
import type { AgentKind } from '../../shared/types'
import {
  extractText,
  isRealUserMessage,
  truncate,
  parseRecord,
  deriveProjectName,
} from './transcriptParse'

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

export class TranscriptScanner {
  private scanCache = new Map<string, ScannedSession>()

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
    const walked = new Set<string>()

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
        walked.add(filePath)
        const session = await this.scanFile(filePath)
        if (session) results.push(session)
      }
    }

    for (const key of this.scanCache.keys()) {
      const separator = key.lastIndexOf(':')
      if (separator >= 0 && !walked.has(key.slice(0, separator))) this.scanCache.delete(key)
    }

    return results
  }

  async scanFile(filePath: string): Promise<ScannedSession | null> {
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

    // Clear stale cache entries for this file path
    for (const key of this.scanCache.keys()) {
      if (key.startsWith(`${filePath}:`)) {
        this.scanCache.delete(key)
      }
    }

    let sessionId = ''
    let cwd = ''
    let gitBranch: string | null = null
    let firstActivity: string | null = null
    let lastActivity: string | null = null
    let firstMessage: string | null = null
    let lastMessage: string | null = null
    let messageCount = 0

    try {
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
      for await (const line of lines) {
        if (!line.trim()) continue
        const record = parseRecord(line)
        if (!record) continue

        if (!sessionId && record.sessionId) sessionId = record.sessionId
        if (!cwd && record.cwd) cwd = record.cwd
        if (!gitBranch && record.gitBranch) gitBranch = record.gitBranch
        if (!firstActivity && record.timestamp) firstActivity = record.timestamp
        if (record.timestamp) lastActivity = record.timestamp

        if (isRealUserMessage(record)) {
          messageCount++
          const text = extractText(record)
          if (text) {
            const truncated = truncate(text)
            if (!firstMessage) firstMessage = truncated
            lastMessage = truncated
          }
        }
      }
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

    this.scanCache.set(cacheKey, session)
    return session
  }
}
