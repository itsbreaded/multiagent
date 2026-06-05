import { EventEmitter } from 'events'
import * as path from 'path'
import * as os from 'os'
import * as fsPromises from 'fs/promises'
import type { FSWatcher } from 'chokidar'
import type { SessionIndex } from './SessionIndex'

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions')

interface LiveSessionFile {
  pid: number
  sessionId: string
  cwd: string
  status: 'idle' | 'running'
  updatedAt: number
  version?: string
}

export class LiveSessionWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null
  private attachedSessionIds = new Set<string>()
  // pid (as string from filename) -> sessionId
  private pidToSession = new Map<string, string>()

  constructor(private index: SessionIndex) {
    super()
  }

  async start(): Promise<void> {
    if (this.watcher) return

    const { watch } = await import('chokidar')
    this.watcher = watch(path.join(SESSIONS_DIR, '*.json'), {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50
      }
    })

    this.watcher.on('add', (filePath) => this.handleFileChange(filePath))
    this.watcher.on('change', (filePath) => this.handleFileChange(filePath))
    this.watcher.on('unlink', (filePath) => this.handleFileRemove(filePath))
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
  }

  markAsAttached(sessionId: string): void {
    this.attachedSessionIds.add(sessionId)
  }

  markAsDetached(sessionId: string): void {
    this.attachedSessionIds.delete(sessionId)
  }

  private async handleFileChange(filePath: string): Promise<void> {
    try {
      const raw = await fsPromises.readFile(filePath, 'utf8')
      const data = JSON.parse(raw) as LiveSessionFile

      if (!data.sessionId) return

      // Track pid -> sessionId so we can clean up on remove
      const pid = String(data.pid)
      this.pidToSession.set(pid, data.sessionId)

      const isAttached = this.attachedSessionIds.has(data.sessionId)
      const status = isAttached ? 'live-attached' : ('live-detached' as const)

      this.index.setStatus(data.sessionId, status, data.pid, data.status)
      this.emit('change')
    } catch {
      // File may have been removed between add/change and read - ignore
    }
  }

  private handleFileRemove(filePath: string): void {
    // Extract pid from filename e.g. 28892.json
    const pid = path.basename(filePath, '.json')
    const sessionId = this.pidToSession.get(pid)
    this.pidToSession.delete(pid)

    if (sessionId) {
      this.attachedSessionIds.delete(sessionId)
      this.index.setStatus(sessionId, 'resumable')
    }

    this.emit('change')
  }
}
