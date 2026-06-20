/**
 * PtyManager
 *
 * Delegates all PTY spawning to a child process (ptyWorker) so that node-pty
 * never runs inside Electron's main process. Electron holds open Chromium IPC
 * handles that would otherwise be inherited through ConPTY into claude (a Bun
 * binary) and crash it. Isolating node-pty in a child process avoids this entirely.
 */

import { EventEmitter } from 'events'
import { spawn, ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { defaultShell } from './shell'
import { shellIntegrationCommand } from './terminalEnvironment'
import type { AgentKind } from '../../shared/types'

export interface PtyReadyEvent {
  id: string
  pid: number | null
  cwd: string
  windowsPty?: {
    backend: 'conpty'
    buildNumber: number
  }
}

type WorkerMessage =
  | { type: 'spawn'; id: string; cwd: string; cmd: string[]; env: Record<string, string>; cols: number; rows: number; allowCwdFallback: boolean }
  | { type: 'write'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'kill'; id: string }

type ParentMessage =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number; signal?: number }
  | { type: 'ready'; id: string; pid: number | null; cwd: string; windowsPty?: PtyReadyEvent['windowsPty'] }
  | { type: 'error'; id: string; message: string }

export class PtyManager extends EventEmitter {
  private worker: ChildProcess
  private pendingResizes = new Map<string, { cols: number; rows: number }>()
  private readyIds = new Set<string>()
  private readyEvents = new Map<string, PtyReadyEvent>()

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
          this.pendingResizes.delete(msg.id)
          this.readyIds.delete(msg.id)
          this.readyEvents.delete(msg.id)
          this.emit('exit', msg.id, msg.exitCode, msg.signal)
          break
        case 'ready': {
          this.readyIds.add(msg.id)
          const readyEvent = {
            id: msg.id,
            pid: msg.pid,
            cwd: msg.cwd,
            windowsPty: msg.windowsPty,
          } satisfies PtyReadyEvent
          this.readyEvents.set(msg.id, readyEvent)
          const pending = this.pendingResizes.get(msg.id)
          if (pending) {
            this.pendingResizes.delete(msg.id)
            this._send({ type: 'resize', id: msg.id, cols: pending.cols, rows: pending.rows })
          }
          this.emit('ready', readyEvent)
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

  createDeferred(
    cwd: string,
    cmd: string[],
    extraEnv?: Record<string, string>,
    initialSize: { cols: number; rows: number } = { cols: 80, rows: 24 },
    envProfile: 'agent' | 'shell' = 'agent',
    allowCwdFallback = envProfile === 'shell',
  ): string {
    const id = randomUUID()
    setImmediate(() => {
      const cwdExists = existsSync(cwd)
      if (!cwdExists && !allowCwdFallback) {
        this.emit('error', id, new Error(`Working directory does not exist: ${cwd}`))
        return
      }
      this._send({
        type: 'spawn',
        id,
        cwd: cwdExists ? cwd : homedir(),
        cmd,
        env: buildEnv(extraEnv, envProfile),
        cols: initialSize.cols,
        rows: initialSize.rows,
        allowCwdFallback,
      })
    })
    return id
  }

  private _shellCmd(): string[] {
    if (process.platform === 'win32') {
      return ['powershell.exe', ...shellIntegrationCommand()]
    }
    return [defaultShell()]
  }

  createShell(cwd: string, initialSize?: { cols: number; rows: number }): string {
    // Shell panes use the 'shell' env profile: no CLAUDE_CODE_* vars (inert for a
    // plain shell). Critically, no env rewrite reorders PATH — that is what broke
    // short no-scroll output like `git pull -> Already up to date.` (see buildEnv).
    return this.createDeferred(cwd, this._shellCmd(), undefined, initialSize, 'shell')
  }

  createClaude(cwd: string): string {
    return this.createDeferred(cwd, this._shellCmd(), {
      CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL: '1',
      CLAUDE_CODE_NO_FLICKER: '1',
    })
  }

  createAgent(cwd: string, agentKind: AgentKind): string {
    if (agentKind === 'claude') return this.createClaude(cwd)
    return this.createDeferred(cwd, this._shellCmd())
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
    this.readyEvents.delete(ptyId)
    this._send({ type: 'kill', id: ptyId })
  }

  getReadyEvent(ptyId: string): PtyReadyEvent | undefined {
    return this.readyEvents.get(ptyId)
  }

  destroy(): void {
    this.worker.kill()
  }
}

// User-defined environment variable overrides from Settings > Environment.
// Applied after process.env but before terminal/profile forced vars, so
// users can override API-level vars (e.g. ANTHROPIC_BASE_URL for DeepSeek)
// without being able to accidentally override rendering-critical vars.
let _customEnvVars: Record<string, string> = {}

export function setCustomEnvVars(vars: Record<string, string>): void {
  _customEnvVars = vars
}

function buildEnv(
  extraVars?: Record<string, string>,
  profile: 'agent' | 'shell' = 'agent',
): Record<string, string> {
  const env = { ...process.env } as Record<string, string>

  delete env['ELECTRON_RUN_AS_NODE']
  delete env['ELECTRON_NO_ASAR']

  if (env['ANTHROPIC_API_KEY'] === '') delete env['ANTHROPIC_API_KEY']

  // Apply user-defined env vars before forced terminal/profile vars so that
  // TERM, COLORTERM, TERM_PROGRAM, CLAUDECODE etc. always win.
  if (Object.keys(_customEnvVars).length > 0) Object.assign(env, _customEnvVars)

  env['TERM'] = 'xterm-256color'
  env['COLORTERM'] = 'truecolor'

  // Claude Code keys its embedded-terminal rendering path on TERM_PROGRAM=vscode,
  // and the shell integration script gates on it too, so both profiles set it.
  env['TERM_PROGRAM'] = 'vscode'

  if (profile === 'agent') {
    // CLAUDECODE=1 activates claude's embedded-terminal rendering path, which
    // works correctly inside our ConPTY. The DISABLE_* flags suppress alternate-
    // screen switching and mouse capture, both of which break in xterm.js. Scoped
    // to agents so plain shells get a clean, inert environment.
    env['CLAUDECODE'] = '1'
    env['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN'] = '1'
    env['CLAUDE_CODE_DISABLE_MOUSE'] = '1'
    env['CLAUDE_CODE_DISABLE_TERMINAL_TITLE'] = '1'
  }

  // NOTE: we deliberately do NOT rewrite PATH. An earlier version prepended
  // %APPDATA%\npm, %ProgramFiles%\nodejs, and ~/.local/bin to PATH for agents.
  // Those dirs are already on the inherited PATH (agents launch and shells run
  // fine without the prepend), so it only *reordered* PATH — which shifted git's
  // startup timing into ConPTY's no-scroll flush race and dropped short output
  // like `git pull -> Already up to date.`. This was the real root cause of the
  // whole "no-scroll drop" investigation (see spec 013); do not reintroduce it.

  if (extraVars) Object.assign(env, extraVars)

  return env
}
