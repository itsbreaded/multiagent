import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'
import type { BrowserWindow } from 'electron'
import type { PtyManager } from '../pty/PtyManager'

// --- Shared watcher state ---
// One chokidar instance watches ~/.claude/projects/ for all sessions.
// Pending detections are queued per normalized cwd so the first session
// waiting on a given directory always claims the first JSONL that appears
// for that directory (FIFO). This prevents concurrent watchers from
// cross-linking or mis-ordering sessions.

interface PendingDetection {
  ptyId: string
  mainWindow: BrowserWindow
  cleanup: () => void
}

const pendingByCwd = new Map<string, PendingDetection[]>()
let watcherReady = false

function ensureSharedWatcher(projectsDir: string): void {
  if (watcherReady) return
  watcherReady = true

  void import('chokidar').then(({ watch }) => {
    const watcher = watch(projectsDir, {
      ignoreInitial: true,
      depth: 1,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    })

    watcher.on('add', (filePath: string) => {
      if (!filePath.endsWith('.jsonl')) return

      void (async () => {
        // Gap 3: retry once after 500ms if the file isn't fully flushed yet
        let info = await readSessionInfo(filePath)
        if (!info) {
          await new Promise<void>((r) => setTimeout(r, 500))
          info = await readSessionInfo(filePath)
        }
        if (!info) return

        const normalizedCwd = normalizePath(info.cwd)
        const queue = pendingByCwd.get(normalizedCwd)
        if (!queue?.length) return

        // FIFO: the oldest pending session for this cwd claims this file
        const pending = queue.shift()
        if (!queue.length) pendingByCwd.delete(normalizedCwd)
        if (!pending) return

        pending.cleanup()
        pending.mainWindow.webContents.send('session:detected', pending.ptyId, info.sessionId)
      })()
    })
  })
}

export class SessionSpawner {
  constructor(private ptyManager: PtyManager, private mainWindow: BrowserWindow) {}

  async spawnNew(cwd: string): Promise<{ ptyId: string; sessionId: string | null }> {
    const ptyId = this.ptyManager.createClaude(cwd)
    this._writeWhenPromptReady(ptyId, 'claude\r')
    this._watchForNewSession(ptyId, cwd)
    return { ptyId, sessionId: null }
  }

  async spawnResume(sessionId: string, cwd: string): Promise<{ ptyId: string }> {
    const ptyId = this.ptyManager.createClaude(cwd)
    this._writeWhenPromptReady(ptyId, `claude --resume ${sessionId}\r`)
    return { ptyId }
  }

  private _watchForNewSession(ptyId: string, spawnCwd: string): void {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects')
    fs.mkdirSync(projectsDir, { recursive: true })

    ensureSharedWatcher(projectsDir)

    const normalizedCwd = normalizePath(spawnCwd)
    const mainWindow = this.mainWindow
    let cancelled = false

    const removePending = () => {
      const queue = pendingByCwd.get(normalizedCwd)
      if (!queue) return
      const idx = queue.indexOf(pending)
      if (idx >= 0) queue.splice(idx, 1)
      if (!queue.length) pendingByCwd.delete(normalizedCwd)
    }

    const cleanup = () => {
      if (cancelled) return
      cancelled = true
      clearTimeout(timeout)
      this.ptyManager.off('exit', onExit)
      removePending()
    }

    // Gap 2: cancel if the PTY exits before detection completes
    const onExit = (exitId: string) => {
      if (exitId !== ptyId) return
      cleanup()
    }
    this.ptyManager.on('exit', onExit)

    const timeout = setTimeout(cleanup, 60_000)

    const pending: PendingDetection = { ptyId, mainWindow, cleanup }

    if (!pendingByCwd.has(normalizedCwd)) {
      pendingByCwd.set(normalizedCwd, [])
    }
    pendingByCwd.get(normalizedCwd)!.push(pending)
  }

  // Wait until the shell has printed its prompt (detected by 'PS ' or '$ ' or '> '
  // in the PTY output) before sending the command. This is more reliable than any
  // fixed timeout because startup time varies by machine and PowerShell version.
  private _writeWhenPromptReady(ptyId: string, command: string): void {
    let sent = false
    let outputBuffer = ''
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null

    const send = () => {
      if (sent) return
      sent = true
      if (fallbackTimer) clearTimeout(fallbackTimer)
      this.ptyManager.write(ptyId, command)
    }

    const isPromptReady = (text: string): boolean => {
      // PowerShell: "PS C:\...>"
      if (text.includes('PS ') && text.includes('>')) return true
      // cmd.exe: "C:\...>"
      if (/[A-Z]:\\.*>/.test(text)) return true
      // bash/zsh: ends with $ or %
      if (/[$%]\s*$/.test(text)) return true
      return false
    }

    const onReady = (readyId: string) => {
      if (readyId !== ptyId) return
      this.ptyManager.off('ready', onReady)

      const onData = (dataId: string, data: string) => {
        if (dataId !== ptyId) return
        outputBuffer += data
        // Gap 6: prevent unbounded buffer growth
        if (outputBuffer.length > 4096) outputBuffer = outputBuffer.slice(-4096)

        if (isPromptReady(outputBuffer)) {
          this.ptyManager.off('data', onData)
          // Small pause so the shell finishes drawing the prompt line
          setTimeout(send, 150)
        }
      }

      this.ptyManager.on('data', onData)

      // Fallback: send after 10s even if we never detect the prompt
      fallbackTimer = setTimeout(() => {
        this.ptyManager.off('data', onData)
        send()
      }, 10_000)
    }

    this.ptyManager.on('ready', onReady)
  }
}

function normalizePath(p: string): string {
  return path.resolve(p).toLowerCase()
}

// sessionId and cwd may appear on different lines - accumulate from first 10 lines
async function readSessionInfo(filePath: string): Promise<{ sessionId: string; cwd: string } | null> {
  return new Promise((resolve) => {
    try {
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
      let sessionId = ''
      let cwd = ''
      let lineCount = 0

      rl.on('line', (line) => {
        if (sessionId && cwd) return
        lineCount++
        if (lineCount > 10) {
          rl.close()
          stream.destroy()
          return
        }
        try {
          const record = JSON.parse(line) as { sessionId?: string; cwd?: string }
          if (!sessionId && record.sessionId) sessionId = record.sessionId
          if (!cwd && record.cwd) cwd = record.cwd
          if (sessionId && cwd) {
            rl.close()
            stream.destroy()
          }
        } catch { /* skip malformed lines */ }
      })

      rl.on('close', () => resolve(sessionId && cwd ? { sessionId, cwd } : null))
      rl.on('error', () => resolve(null))
      stream.on('error', () => resolve(null))
    } catch {
      resolve(null)
    }
  })
}
