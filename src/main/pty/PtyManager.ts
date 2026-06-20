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
  | { type: 'spawn'; id: string; cwd: string; cmd: string[]; env: Record<string, string>; cols: number; rows: number }
  | { type: 'write'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'pause'; id: string }
  | { type: 'resume'; id: string }
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
  private pausedIds = new Set<string>()
  // PTYs that must NOT be flow-controlled: their output is relayed straight to
  // xterm (seq=0 direct write) instead of the coalesce/ack pipeline. Shell panes
  // use this so short no-scroll output (e.g. `git pull`) is never dropped.
  private directIds = new Set<string>()

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
          this.pausedIds.delete(msg.id)
          this.emit('exit', msg.id, msg.exitCode, msg.signal)
          // Delete after emit so the exit handler can still check isDirect().
          this.directIds.delete(msg.id)
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
    options: { flowControl?: boolean; envProfile?: 'agent' | 'shell' } = {},
  ): string {
    const id = randomUUID()
    // flowControl defaults to true (agents). Shell panes pass false so handlers
    // relays their output directly (seq=0) without coalescing/ack.
    if (options.flowControl === false) this.directIds.add(id)
    setImmediate(() => {
      this._send({
        type: 'spawn',
        id,
        cwd: existsSync(cwd) ? cwd : homedir(),
        cmd,
        env: buildEnv(extraEnv, options.envProfile ?? 'agent'),
        cols: initialSize.cols,
        rows: initialSize.rows,
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
    return this.createDeferred(cwd, this._shellCmd(), undefined, initialSize, {
      flowControl: false,
      envProfile: 'shell',
    })
  }

  /** True for shell panes — their output must be relayed directly, not coalesced. */
  isDirect(ptyId: string): boolean {
    return this.directIds.has(ptyId)
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

  pause(ptyId: string): void {
    if (this.pausedIds.has(ptyId)) return
    this.pausedIds.add(ptyId)
    this._send({ type: 'pause', id: ptyId })
  }

  resume(ptyId: string): void {
    if (!this.pausedIds.has(ptyId)) return
    this.pausedIds.delete(ptyId)
    this._send({ type: 'resume', id: ptyId })
  }

  kill(ptyId: string): void {
    this.pendingResizes.delete(ptyId)
    this.readyIds.delete(ptyId)
    this.readyEvents.delete(ptyId)
    this.pausedIds.delete(ptyId)
    this._send({ type: 'kill', id: ptyId })
  }

  getReadyEvent(ptyId: string): PtyReadyEvent | undefined {
    return this.readyEvents.get(ptyId)
  }

  destroy(): void {
    this.directIds.clear()
    this.worker.kill()
  }
}

function buildEnv(
  extraVars?: Record<string, string>,
  profile: 'agent' | 'shell' = 'agent',
): Record<string, string> {
  const env = { ...process.env } as Record<string, string>

  delete env['ELECTRON_RUN_AS_NODE']
  delete env['ELECTRON_NO_ASAR']

  if (env['ANTHROPIC_API_KEY'] === '') delete env['ANTHROPIC_API_KEY']

  env['TERM'] = 'xterm-256color'
  env['COLORTERM'] = 'truecolor'

  // Claude Code keys its embedded-terminal rendering path on TERM_PROGRAM=vscode.
  // Shell integration (shellIntegration.ps1) also gates on it, so both profiles
  // need it. Changing this value breaks Claude's xterm.js rendering mode.
  env['TERM_PROGRAM'] = 'vscode'

  if (profile === 'agent') {
    // CLAUDECODE=1 activates claude's embedded-terminal rendering path, which
    // works correctly inside our ConPTY. The DISABLE_* flags suppress alternate-
    // screen switching and mouse capture, both of which break in xterm.js. These
    // are scoped to agent panes so plain shell panes get a clean environment.
    env['CLAUDECODE'] = '1'
    env['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN'] = '1'
    env['CLAUDE_CODE_DISABLE_MOUSE'] = '1'
    env['CLAUDE_CODE_DISABLE_TERMINAL_TITLE'] = '1'
  }

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
