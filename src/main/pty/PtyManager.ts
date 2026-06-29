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

type PendingSpawn = {
  cwd: string
  cmd: string[]
  env: Record<string, string>
  allowCwdFallback: boolean
  size: { cols: number; rows: number }
  resized: boolean
  timeout: ReturnType<typeof setTimeout> | null
}

// How long to wait for the renderer's first pty:resize before falling back to
// the 80x24 default. In practice the renderer sends the resize within one React
// render cycle (~16 ms), so 500 ms is a conservative backstop.
const DEFERRED_SPAWN_TIMEOUT_MS = 500

export class PtyManager extends EventEmitter {
  private worker: ChildProcess
  private pendingResizes = new Map<string, { cols: number; rows: number }>()
  private pendingSpawns = new Map<string, PendingSpawn>()
  private spawnedIds = new Set<string>()
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
          this.spawnedIds.delete(msg.id)
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
          this.pendingResizes.delete(msg.id)
          this.spawnedIds.delete(msg.id)
          this.readyIds.delete(msg.id)
          this.readyEvents.delete(msg.id)
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
    extraEnv?: Record<string, string | undefined>,
    initialSize: { cols: number; rows: number } = { cols: 80, rows: 24 },
    allowCwdFallback = false,
    deferSpawn = false,
  ): string {
    const id = randomUUID()

    if (deferSpawn) {
      // Register the pending entry synchronously so that a pty:resize arriving
      // before setImmediate fires (extremely unlikely but theoretically possible)
      // is captured correctly. setImmediate is used only for the existsSync check,
      // which must be async so the caller can attach error listeners first.
      const entry: PendingSpawn = {
        cwd,
        cmd,
        env: buildEnv(extraEnv),
        allowCwdFallback,
        size: initialSize,
        resized: false,
        timeout: null,
      }
      this.pendingSpawns.set(id, entry)
      setImmediate(() => {
        const e = this.pendingSpawns.get(id)
        if (!e) return // already killed or spawned by an early resize
        const cwdExists = existsSync(e.cwd)
        if (!cwdExists && !e.allowCwdFallback) {
          this.pendingSpawns.delete(id)
          this.emit('error', id, new Error(`Working directory does not exist: ${e.cwd}`))
          return
        }
        e.cwd = cwdExists ? e.cwd : homedir()
        if (e.resized) {
          // First resize already arrived before setImmediate ran; spawn now.
          this.pendingSpawns.delete(id)
          this._spawn(id, e.cwd, e.cmd, e.env, e.size.cols, e.size.rows, e.allowCwdFallback)
          return
        }
        // Wait for the renderer's first pty:resize; fall back to 80x24 on timeout.
        e.timeout = setTimeout(() => {
          const p = this.pendingSpawns.get(id)
          if (!p) return
          this.pendingSpawns.delete(id)
          this._spawn(id, p.cwd, p.cmd, p.env, p.size.cols, p.size.rows, p.allowCwdFallback)
        }, DEFERRED_SPAWN_TIMEOUT_MS)
      })
      return id
    }

    setImmediate(() => {
      const cwdExists = existsSync(cwd)
      if (!cwdExists && !allowCwdFallback) {
        this.emit('error', id, new Error(`Working directory does not exist: ${cwd}`))
        return
      }
      this._spawn(id, cwdExists ? cwd : homedir(), cmd, buildEnv(extraEnv), initialSize.cols, initialSize.rows, allowCwdFallback)
    })
    return id
  }

  private _spawn(
    id: string,
    cwd: string,
    cmd: string[],
    env: Record<string, string>,
    cols: number,
    rows: number,
    allowCwdFallback: boolean,
  ): void {
    this.spawnedIds.add(id)
    this._send({ type: 'spawn', id, cwd, cmd, env, cols, rows, allowCwdFallback })
  }

  private _shellCmd(): string[] {
    if (process.platform === 'win32') {
      return ['powershell.exe', ...shellIntegrationCommand()]
    }
    return [defaultShell()]
  }

  createShell(cwd: string, initialSize?: { cols: number; rows: number }): string {
    // Shell panes may fall back to the home directory for deleted cwd paths.
    // Agent panes validate cwd before spawning and should fail loudly instead.
    return this.createDeferred(cwd, this._shellCmd(), undefined, initialSize, true)
  }

  createClaude(cwd: string): string {
    return this.createDeferred(cwd, this._shellCmd())
  }

  createAgent(cwd: string, agentKind: AgentKind): string {
    if (agentKind === 'claude') return this.createClaude(cwd)
    return this.createDeferred(cwd, this._shellCmd())
  }

  write(ptyId: string, data: string): void {
    this._send({ type: 'write', id: ptyId, data })
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const pending = this.pendingSpawns.get(ptyId)
    if (pending) {
      // First pty:resize for a deferred agent spawn: use this size for the actual
      // spawn so Claude never renders its banner at 80x24 and gets a corrective redraw.
      pending.size = { cols, rows }
      pending.resized = true
      if (pending.timeout !== null) {
        // setImmediate already ran and started the fallback timer; spawn now.
        clearTimeout(pending.timeout)
        this.pendingSpawns.delete(ptyId)
        this._spawn(ptyId, pending.cwd, pending.cmd, pending.env, cols, rows, pending.allowCwdFallback)
      }
      // else: setImmediate hasn't run yet; it will see resized=true and spawn.
      // Do not forward a resize message; the spawn itself carries the correct size.
      return
    }
    // Pre-ready: queue so the 'ready' handler can apply it once the PTY exists.
    // Post-ready: the immediate send below is sufficient.
    if (!this.readyIds.has(ptyId)) {
      if (this.spawnedIds.has(ptyId)) {
        this._send({ type: 'resize', id: ptyId, cols, rows })
        return
      }
      this.pendingResizes.set(ptyId, { cols, rows })
      return
    }
    this._send({ type: 'resize', id: ptyId, cols, rows })
  }

  kill(ptyId: string): void {
    const pending = this.pendingSpawns.get(ptyId)
    if (pending) {
      if (pending.timeout !== null) clearTimeout(pending.timeout)
      this.pendingSpawns.delete(ptyId)
      // The worker never received a spawn message, so no kill is needed.
      return
    }
    this.pendingResizes.delete(ptyId)
    this.spawnedIds.delete(ptyId)
    this.readyIds.delete(ptyId)
    this.readyEvents.delete(ptyId)
    this._send({ type: 'kill', id: ptyId })
  }

  getReadyEvent(ptyId: string): PtyReadyEvent | undefined {
    return this.readyEvents.get(ptyId)
  }

  destroy(): void {
    for (const entry of this.pendingSpawns.values()) {
      if (entry.timeout !== null) clearTimeout(entry.timeout)
    }
    this.pendingSpawns.clear()
    this.spawnedIds.clear()
    this.worker.kill()
  }
}

function buildEnv(
  extraVars?: Record<string, string | undefined>,
): Record<string, string> {
  const env = { ...process.env } as Record<string, string>

  delete env['ELECTRON_RUN_AS_NODE']
  delete env['ELECTRON_NO_ASAR']
  delete env['CLAUDECODE']
  delete env['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN']
  delete env['CLAUDE_CODE_DISABLE_MOUSE']
  delete env['CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL']
  delete env['CLAUDE_CODE_NO_FLICKER']

  env['TERM'] = 'xterm-256color'
  env['COLORTERM'] = 'truecolor'

  // Claude Code keys its embedded-terminal rendering path on TERM_PROGRAM=vscode,
  // and the shell integration script gates on it too, so both profiles set it.
  env['TERM_PROGRAM'] = 'vscode'

  // Agent-specific CLI environment belongs in SessionSpawner.agentEnv(), where
  // the concrete agent kind is known. Keep this profile terminal-like; VS Code
  // and Warp do not set Claude-only renderer flags for a normal PTY session.

  // NOTE: we deliberately do NOT rewrite PATH. An earlier version prepended
  // %APPDATA%\npm, %ProgramFiles%\nodejs, and ~/.local/bin to PATH for agents.
  // Those dirs are already on the inherited PATH (agents launch and shells run
  // fine without the prepend), so it only *reordered* PATH — which shifted git's
  // startup timing into ConPTY's no-scroll flush race and dropped short output
  // like `git pull -> Already up to date.`. This was the real root cause of the
  // whole "no-scroll drop" investigation (see spec 013); do not reintroduce it.

  // Undefined values explicitly remove inherited variables. Agent provider
  // profiles use this to prevent disabled credentials from reaching the PTY.
  for (const [key, value] of Object.entries(extraVars ?? {})) {
    // Windows treats environment names case-insensitively. Remove every casing
    // before deleting or assigning so `Anthropic_Api_Key` cannot bypass a scrub
    // (and assignments cannot create ambiguous duplicate names).
    const matchingKeys = process.platform === 'win32'
      ? Object.keys(env).filter((existing) => existing.toLowerCase() === key.toLowerCase())
      : [key]
    for (const matchingKey of matchingKeys) delete env[matchingKey]
    if (value !== undefined) env[key] = value
  }

  return env
}
