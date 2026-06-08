import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'
import type { BrowserWindow } from 'electron'
import type { PtyManager } from '../pty/PtyManager'
import type { AgentKind } from '../../shared/types'
import { CodexSessionScanner, codexSessionsDir } from './CodexSessionScanner'

// --- Shared watcher state ---
// One chokidar instance watches ~/.claude/projects/ for all sessions.
// All pending detections share a single global FIFO queue. Sessions are
// always started by sequential user action, and Claude Code writes its
// JSONL in that same order, so the first JSONL that appears belongs to
// the oldest pending entry. Per-cwd routing was tried but is fragile:
// if the requested cwd doesn't exist on the machine, the PTY falls back
// to a different directory and the JSONL cwd never matches.

interface PendingDetection {
  ptyId: string
  mainWindow: BrowserWindow
  cleanup: () => void
}

const pendingQueue: PendingDetection[] = []
let watcherReady = false

const codexPendingQueue: PendingDetection[] = []
let codexWatcherReady = false

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
        // Retry once after 500ms if the file isn't fully flushed yet
        let info = await readSessionInfo(filePath)
        if (!info) {
          await new Promise<void>((r) => setTimeout(r, 500))
          info = await readSessionInfo(filePath)
        }
        if (!info) return

        const pending = pendingQueue.shift()
        if (!pending) return

        pending.cleanup()
        pending.mainWindow.webContents.send('session:detected', pending.ptyId, 'claude', info.sessionId)
      })()
    })
  })
}

function ensureCodexWatcher(sessionsDir: string): void {
  if (codexWatcherReady) return
  codexWatcherReady = true

  void import('chokidar').then(({ watch }) => {
    const watcher = watch(sessionsDir, {
      ignoreInitial: true,
      depth: 5,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    })

    watcher.on('add', (filePath: string) => {
      if (!filePath.endsWith('.jsonl')) return

      void (async () => {
        let info = await readCodexSessionInfo(filePath)
        if (!info) {
          await new Promise<void>((r) => setTimeout(r, 500))
          info = await readCodexSessionInfo(filePath)
        }
        if (!info) return

        const pending = codexPendingQueue.shift()
        if (!pending) return

        pending.cleanup()
        pending.mainWindow.webContents.send('session:detected', pending.ptyId, 'codex', info.sessionId)
      })()
    })
  })
}

export class SessionSpawner {
  constructor(private ptyManager: PtyManager, private mainWindow: BrowserWindow) {}

  async spawnNew(agentKind: AgentKind, cwd: string): Promise<{ ptyId: string; sessionId: string | null }> {
    const ptyId = this.ptyManager.createAgent(cwd, agentKind)
    const startedAt = Date.now()
    this._watchForNewSession(agentKind, ptyId, cwd, startedAt)
    this._writeWhenPromptReady(ptyId, `${agentKind === 'claude' ? 'claude' : 'codex'}\r`)
    return { ptyId, sessionId: null }
  }

  async spawnResume(agentKind: AgentKind, sessionId: string, cwd: string): Promise<{ ptyId: string }> {
    const ptyId = this.ptyManager.createAgent(cwd, agentKind)
    const command = agentKind === 'claude'
      ? `claude --resume ${shellArg(sessionId)}\r`
      : `codex resume -C ${shellArg(cwd)} ${shellArg(sessionId)}\r`
    this._writeWhenPromptReady(ptyId, command)
    return { ptyId }
  }

  private _watchForNewSession(agentKind: AgentKind, ptyId: string, cwd: string, startedAt: number): void {
    if (agentKind === 'codex') {
      this._watchForNewCodexSession(ptyId, cwd, startedAt)
      return
    }

    const projectsDir = path.join(os.homedir(), '.claude', 'projects')
    fs.mkdirSync(projectsDir, { recursive: true })

    ensureSharedWatcher(projectsDir)

    const mainWindow = this.mainWindow
    let cancelled = false

    const cleanup = () => {
      if (cancelled) return
      cancelled = true
      clearTimeout(timeout)
      this.ptyManager.off('exit', onExit)
      const idx = pendingQueue.indexOf(pending)
      if (idx >= 0) pendingQueue.splice(idx, 1)
    }

    // Cancel if the PTY exits before detection completes
    const onExit = (exitId: string) => {
      if (exitId !== ptyId) return
      cleanup()
    }
    this.ptyManager.on('exit', onExit)

    const timeout = setTimeout(cleanup, 60_000)

    const pending: PendingDetection = { ptyId, mainWindow, cleanup }
    pendingQueue.push(pending)
  }

  private _watchForNewCodexSession(ptyId: string, cwd: string, startedAt: number): void {
    const sessionsDir = codexSessionsDir()
    fs.mkdirSync(sessionsDir, { recursive: true })

    ensureCodexWatcher(sessionsDir)

    const mainWindow = this.mainWindow
    let cancelled = false
    let pollTimer: ReturnType<typeof setInterval> | null = null

    const cleanup = () => {
      if (cancelled) return
      cancelled = true
      if (pollTimer) clearInterval(pollTimer)
      clearTimeout(timeout)
      this.ptyManager.off('exit', onExit)
      const idx = codexPendingQueue.indexOf(pending)
      if (idx >= 0) codexPendingQueue.splice(idx, 1)
    }

    const onExit = (exitId: string) => {
      if (exitId !== ptyId) return
      cleanup()
    }
    this.ptyManager.on('exit', onExit)

    const scanner = new CodexSessionScanner()
    pollTimer = setInterval(() => {
      void (async () => {
        if (cancelled) return
        const sessions = await scanner.scanAll()
        const normalizedCwd = normalizePath(cwd)
        const match = sessions
          .filter((session) =>
            normalizePath(session.cwd) === normalizedCwd &&
            session.mtimeMs >= startedAt - 5_000
          )
          .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
        if (!match) return

        cleanup()
        mainWindow.webContents.send('session:detected', ptyId, 'codex', match.sessionId)
      })().catch(() => {})
    }, 1_000)

    const timeout = setTimeout(cleanup, 60_000)

    const pending: PendingDetection = { ptyId, mainWindow, cleanup }
    codexPendingQueue.push(pending)
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

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_\-.:\\/]+$/.test(value)) return value
  return `"${value.replace(/"/g, '\\"')}"`
}

function normalizePath(value: string): string {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
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

async function readCodexSessionInfo(filePath: string): Promise<{ sessionId: string; cwd: string } | null> {
  return new Promise((resolve) => {
    try {
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
      let lineCount = 0

      rl.on('line', (line) => {
        lineCount++
        if (lineCount > 20) {
          rl.close()
          stream.destroy()
          return
        }
        try {
          const record = JSON.parse(line) as {
            type?: string
            payload?: { id?: string; cwd?: string }
          }
          if (record.type === 'session_meta' && record.payload?.id && record.payload.cwd) {
            rl.close()
            stream.destroy()
            resolve({ sessionId: record.payload.id, cwd: record.payload.cwd })
          }
        } catch { /* skip malformed lines */ }
      })

      rl.on('close', () => resolve(null))
      rl.on('error', () => resolve(null))
      stream.on('error', () => resolve(null))
    } catch {
      resolve(null)
    }
  })
}
