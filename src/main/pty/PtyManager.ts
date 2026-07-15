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
import { shellIntegrationCommand, unixShellLaunch } from './terminalEnvironment'
import { buildEnv } from './buildEnv'

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
  | { type: 'shutdown' }

type ParentMessage =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number; signal?: number }
  | { type: 'ready'; id: string; pid: number | null; cwd: string; windowsPty?: PtyReadyEvent['windowsPty'] }
  | { type: 'error'; id: string; message: string }
  | { type: 'shutdown-complete' }

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

export interface PtyManagerOptions {
  /**
   * Per-pane env vars to merge into every PTY's environment at creation (spec 047 phase 3).
   * Called with the freshly-generated ptyId so the caller can inject `MULTIAGENT_PTY_ID`
   * etc. when the opt-in CLI session-linking feature is enabled; return {} otherwise.
   * buildEnv scrubs inherited copies first, so a nested MultiAgent never reuses these.
   */
  getPaneEnv?: (ptyId: string) => Record<string, string | undefined>
}

export class PtyManager extends EventEmitter {
  private worker: ChildProcess
  private pendingResizes = new Map<string, { cols: number; rows: number }>()
  private pendingSpawns = new Map<string, PendingSpawn>()
  private spawnedIds = new Set<string>()
  private readyIds = new Set<string>()
  private readyEvents = new Map<string, PtyReadyEvent>()
  private destroyPromise: Promise<void> | null = null
  private destroying = false
  // Latched the first time the worker exits unexpectedly while we are not
  // destroying. Once true, post-crash creates fail loudly instead of hanging.
  private workerDead = false
  private readonly getPaneEnv?: (ptyId: string) => Record<string, string | undefined>

  constructor(options: PtyManagerOptions = {}) {
    super()
    this.getPaneEnv = options.getPaneEnv
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
        case 'shutdown-complete':
          // The worker exits immediately after this acknowledgement. The destroy
          // promise resolves on its exit event so Windows has released handles.
          break
      }
    })

    this.worker.on('error', (err) => {
      console.error('[PtyManager] worker error:', err)
      this._handleWorkerCrash(null)
    })

    this.worker.on('exit', (code) => {
      if (this.destroying) return
      console.error('[PtyManager] worker exited with code', code)
      this._handleWorkerCrash(code)
    })
  }

  /**
   * Fan out a worker crash to every live PTY and pending spawn. Called once from
   * the worker `exit` handler (latched via `workerDead`). Each spawned id gets an
   * `exit` event so handlers.ts can show the per-pane exited banner, send
   * `pty:exit`, unroute, and clean direct-output buffers — the existing surfacing
   * path. Pending deferred spawns never reached the worker, so they fail as
   * `error`, matching the existing missing-cwd spawn-error path the renderer
   * already renders as a spawn failure. Respawning the worker is out of scope.
   */
  private _handleWorkerCrash(code: number | null): void {
    if (this.destroying || this.workerDead) return
    this.workerDead = true
    const exitCode = typeof code === 'number' ? code : 1
    for (const [id, entry] of this.pendingSpawns) {
      if (entry.timeout !== null) clearTimeout(entry.timeout)
      this.emit('error', id, new Error(`Terminal host process exited unexpectedly (code ${exitCode})`))
    }
    this.pendingSpawns.clear()
    const ids = [...this.spawnedIds]
    this.spawnedIds.clear()
    this.readyIds.clear()
    this.readyEvents.clear()
    this.pendingResizes.clear()
    for (const id of ids) this.emit('exit', id, exitCode)
  }

  private _send(msg: WorkerMessage) {
    if (this.destroying || !this.worker.connected) return
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
    // Merge per-pane identity env (spec 047 phase 3) before buildEnv scrubs+applies.
    const paneEnv = this.getPaneEnv?.(id) ?? {}
    const mergedExtraEnv = { ...extraEnv, ...paneEnv }

    if (this.workerDead) {
      // The worker host is gone; refuse to queue another silent-hang spawn.
      // setImmediate preserves the contract that callers attach listeners
      // before events fire.
      const deadId = id
      setImmediate(() => this.emit('error', deadId, new Error('Terminal host process is not running')))
      return id
    }

    if (deferSpawn) {
      // Register the pending entry synchronously so that a pty:resize arriving
      // before setImmediate fires (extremely unlikely but theoretically possible)
      // is captured correctly. setImmediate is used only for the existsSync check,
      // which must be async so the caller can attach error listeners first.
      const entry: PendingSpawn = {
        cwd,
        cmd,
        env: buildEnv(mergedExtraEnv),
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
      this._spawn(id, cwdExists ? cwd : homedir(), cmd, buildEnv(mergedExtraEnv), initialSize.cols, initialSize.rows, allowCwdFallback)
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

  private _shellCmd(): { cmd: string[]; env?: Record<string, string> } {
    if (process.platform === 'win32') {
      return { cmd: ['powershell.exe', ...shellIntegrationCommand()] }
    }
    // Unix: wire the shell-integration script (OSC 633;P;Cwd + OSC 7) into bash/zsh. Falls
    // back to the bare shell if the integration script can't be materialized.
    return unixShellLaunch(defaultShell())
  }

  createShell(cwd: string, initialSize?: { cols: number; rows: number }): string {
    // Shell panes may fall back to the home directory for deleted cwd paths.
    // Agent panes validate cwd before spawning and should fail loudly instead.
    const { cmd, env } = this._shellCmd()
    return this.createDeferred(cwd, cmd, env, initialSize, true)
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

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise
    this.destroying = true
    for (const entry of this.pendingSpawns.values()) {
      if (entry.timeout !== null) clearTimeout(entry.timeout)
    }
    this.pendingSpawns.clear()
    this.pendingResizes.clear()
    this.spawnedIds.clear()
    this.readyIds.clear()
    this.readyEvents.clear()

    this.destroyPromise = new Promise((resolve) => {
      if (this.worker.exitCode !== null || this.worker.signalCode !== null) {
        resolve()
        return
      }
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(forceTimer)
        clearTimeout(finalTimer)
        resolve()
      }
      this.worker.once('exit', finish)
      const forceTimer = setTimeout(() => {
        if (this.worker.exitCode === null && this.worker.signalCode === null) this.worker.kill()
      }, 2000)
      const finalTimer = setTimeout(finish, 3500)
      try {
        this.worker.send({ type: 'shutdown' } satisfies WorkerMessage, (error) => {
          if (error && this.worker.exitCode === null && this.worker.signalCode === null) this.worker.kill()
        })
      } catch {
        this.worker.kill()
      }
    })
    return this.destroyPromise
  }
}

