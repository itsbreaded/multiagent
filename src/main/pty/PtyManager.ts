/**
 * PtyManager
 *
 * Delegates all PTY spawning to a child process (ptyWorker) so that node-pty
 * never runs inside Electron's main process. Electron holds open Chromium IPC
 * handles that would otherwise be inherited through ConPTY into claude (a Bun
 * binary) and crash it. VS Code uses the same isolation pattern for its PTY host.
 */

import { EventEmitter } from 'events'
import { spawn, ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { defaultShell } from './shell'

type WorkerMessage =
  | { type: 'spawn'; id: string; cwd: string; cmd: string[]; env: Record<string, string>; cols: number; rows: number }
  | { type: 'write'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'kill'; id: string }

type ParentMessage =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number; signal?: number }
  | { type: 'ready'; id: string }
  | { type: 'error'; id: string; message: string }

export class PtyManager extends EventEmitter {
  private worker: ChildProcess
  private pendingResizes = new Map<string, { cols: number; rows: number }>()
  private readyIds = new Set<string>()

  constructor() {
    super()
    // ELECTRON_RUN_AS_NODE=1 makes electron.exe run as plain Node — no Chromium
    // init, no inherited Chromium handles. stdio 'ipc' gives us message passing.
    this.worker = spawn(
      process.execPath,                    // electron.exe
      [join(__dirname, 'ptyWorker.js')],
      {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',       // pure Node.js mode, no Chromium
        },
      }
    )

    this.worker.stderr?.on('data', (d: Buffer) => {
      const text = d.toString().trim()
      // node-pty forks conpty_console_list_agent on kill() to enumerate the
      // console process list. If the shell already exited, AttachConsole fails.
      // This is a benign race — node-pty handles it with a fallback.
      if (text.includes('AttachConsole failed')) return
      console.error('[ptyWorker stderr]', text)
    })

    this.worker.on('message', (msg: ParentMessage) => {
      switch (msg.type) {
        case 'data':
          this.emit('data', msg.id, msg.data)
          break
        case 'exit':
          this.emit('exit', msg.id, msg.exitCode, msg.signal)
          break
        case 'ready': {
          this.readyIds.add(msg.id)
          const pending = this.pendingResizes.get(msg.id)
          if (pending) {
            this.pendingResizes.delete(msg.id)
            this._send({ type: 'resize', id: msg.id, cols: pending.cols, rows: pending.rows })
          }
          this.emit('ready', msg.id)
          break
        }
        case 'error':
          this.emit('error', msg.id, new Error(msg.message))
          break
      }
    })

    this.worker.on('error', (err) => {
      console.error('[PtyManager] worker error:', err)
    })

    this.worker.on('exit', (code) => {
      console.error('[PtyManager] worker exited with code', code)
    })
  }

  private _send(msg: WorkerMessage) {
    this.worker.send(msg)
  }

  createDeferred(cwd: string, cmd: string[], extraEnv?: Record<string, string>): string {
    const id = randomUUID()
    setImmediate(() => {
      this._send({
        type: 'spawn',
        id,
        cwd: existsSync(cwd) ? cwd : homedir(),
        cmd,
        env: buildEnv(extraEnv),
        cols: 80,
        rows: 24,
      })
    })
    return id
  }

  private _shellCmd(): string[] {
    if (process.platform === 'win32') {
      // Use [char]27/[char]7 for ESC/BEL — backtick-e is unreliable in Windows PowerShell 5.x.
      // The wrapped prompt emits an OSC 7 sequence (parsed by main process for CWD tracking)
      // before the visible prompt text. -NoLogo suppresses the copyright banner.
      const script = [
        '$__mp = if (Test-Path Function:prompt) { ${Function:prompt} } else { $null }',
        "function prompt { $e=[char]27; $bel=[char]7; $b = if ($__mp) { & $__mp } else { 'PS ' + $pwd + '> ' }; $c = $pwd.Path.Replace('\\', '/'); \"${e}]7;file:///$c${bel}$b\" }",
      ].join('; ')
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      return ['powershell.exe', '-NoLogo', '-NoExit', '-EncodedCommand', encoded]
    }
    return [defaultShell()]
  }

  createShell(cwd: string): string {
    return this.createDeferred(cwd, this._shellCmd())
  }

  createClaude(cwd: string): string {
    return this.createDeferred(cwd, this._shellCmd(), { CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL: '1' })
  }

  write(ptyId: string, data: string): void {
    this._send({ type: 'write', id: ptyId, data })
  }

  resize(ptyId: string, cols: number, rows: number): void {
    // Pre-ready: queue so the 'ready' handler can apply it once the PTY exists.
    // Post-ready: the immediate send below is sufficient.
    if (!this.readyIds.has(ptyId)) {
      this.pendingResizes.set(ptyId, { cols, rows })
    }
    this._send({ type: 'resize', id: ptyId, cols, rows })
  }

  kill(ptyId: string): void {
    this.pendingResizes.delete(ptyId)
    this.readyIds.delete(ptyId)
    this._send({ type: 'kill', id: ptyId })
  }

  destroy(): void {
    this.worker.kill()
  }
}

function buildEnv(extraVars?: Record<string, string>): Record<string, string> {
  const env = { ...process.env } as Record<string, string>

  delete env['ELECTRON_RUN_AS_NODE']
  delete env['ELECTRON_NO_ASAR']

  if (env['ANTHROPIC_API_KEY'] === '') delete env['ANTHROPIC_API_KEY']

  if (process.platform !== 'win32') {
    env['TERM'] = 'xterm-256color'
    env['COLORTERM'] = 'truecolor'
  }

  // CLAUDECODE=1 activates claude's embedded-terminal rendering path, which
  // works correctly inside our ConPTY. The DISABLE_* flags suppress alternate-
  // screen switching and mouse capture, both of which break in xterm.js.
  env['CLAUDECODE'] = '1'
  env['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN'] = '1'
  env['CLAUDE_CODE_DISABLE_MOUSE'] = '1'

  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')
    const npmGlobal = join(appData, 'npm')
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const nodeSystem = join(programFiles, 'nodejs')
    const localBin = join(homedir(), '.local', 'bin')
    const additions = [npmGlobal, nodeSystem, localBin].filter(existsSync)
    if (additions.length > 0) {
      const current = env['PATH'] ?? env['Path'] ?? ''
      env['PATH'] = [...additions, current].join(';')
    }
  }

  if (extraVars) Object.assign(env, extraVars)

  return env
}
