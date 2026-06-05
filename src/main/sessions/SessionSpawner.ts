import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'
import type { BrowserWindow } from 'electron'
import type { PtyManager } from '../pty/PtyManager'

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

  // Watch ~/.claude/projects/ for a new JSONL file that appears after spawning.
  // When found, read its sessionId field and notify the renderer so the pane
  // can persist and resume the session across restarts.
  private _watchForNewSession(ptyId: string, spawnCwd: string): void {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects')
    fs.mkdirSync(projectsDir, { recursive: true })

    const spawnTime = Date.now()
    const mainWindow = this.mainWindow
    const normalizedSpawnCwd = normalizePath(spawnCwd)

    // chokidar v5 is ESM-only; use dynamic import to avoid CJS require() error
    void import('chokidar').then(({ watch }) => {
      let closed = false

      const cleanup = () => {
        if (closed) return
        closed = true
        clearTimeout(timeout)
        this.ptyManager.off('exit', onExit)
        watcher.close()
      }

      // Gap 2: cancel watcher early if the PTY exits before detection completes
      const onExit = (exitId: string) => {
        if (exitId !== ptyId) return
        cleanup()
      }
      this.ptyManager.on('exit', onExit)

      const timeout = setTimeout(cleanup, 60_000)

      const watcher = watch(projectsDir, {
        ignoreInitial: true,
        depth: 1,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      })

      watcher.on('add', (filePath: string) => {
        if (closed || !filePath.endsWith('.jsonl')) return
        if (Date.now() - spawnTime > 60_000) { cleanup(); return }

        void (async () => {
          // Gap 3: retry once after 500ms if the file isn't flushed yet
          let info = await readSessionInfo(filePath)
          if (!info) {
            await new Promise<void>((r) => setTimeout(r, 500))
            info = await readSessionInfo(filePath)
          }
          if (!info || closed) return

          // Gap 1: verify the JSONL's cwd matches the spawning cwd to avoid
          // cross-linking sessions from concurrent Claude instances
          if (normalizePath(info.cwd) !== normalizedSpawnCwd) return

          cleanup()
          mainWindow.webContents.send('session:detected', ptyId, info.sessionId)
        })()
      })
    })
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

async function readSessionInfo(filePath: string): Promise<{ sessionId: string; cwd: string } | null> {
  return new Promise((resolve) => {
    try {
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
      let found = false

      rl.on('line', (line) => {
        if (found) return
        try {
          const record = JSON.parse(line) as { sessionId?: string; cwd?: string }
          if (record.sessionId && record.cwd) {
            found = true
            rl.close()
            stream.destroy()
            resolve({ sessionId: record.sessionId, cwd: record.cwd })
          }
        } catch { /* skip malformed lines */ }
      })

      rl.on('close', () => { if (!found) resolve(null) })
      rl.on('error', () => resolve(null))
      stream.on('error', () => resolve(null))
    } catch {
      resolve(null)
    }
  })
}
