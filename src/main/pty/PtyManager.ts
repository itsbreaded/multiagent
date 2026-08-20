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
  | { type: 'host-ready' }
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

export type PtyPurpose = 'shell' | 'new-agent' | 'resume-agent'

export interface PtyHostFailure {
  incidentId: string
  code: number | null
  affectedPtyIds: string[]
  unreadyPtyIds: string[]
  unreadyNewAgentPtyIds: string[]
}

export interface PtyHostRecoveryFailure extends PtyHostFailure {
  message: string
}

type HostState = 'starting' | 'ready' | 'recovering' | 'failed' | 'destroying'

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
  private worker!: ChildProcess
  private workerGeneration = 0
  private pendingResizes = new Map<string, { cols: number; rows: number }>()
  private pendingSpawns = new Map<string, PendingSpawn>()
  private reservedIds = new Set<string>()
  private spawnedIds = new Set<string>()
  private readyIds = new Set<string>()
  private readyEvents = new Map<string, PtyReadyEvent>()
  private purposes = new Map<string, PtyPurpose>()
  private destroyPromise: Promise<void> | null = null
  private destroying = false
  private hostState: HostState = 'starting'
  private incidentId: string | null = null
  private hostWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
  private e2eKillWorkerOnce = process.env['MULTIAGENT_E2E_KILL_PTY_WORKER_ONCE'] === '1'
  private readonly getPaneEnv?: (ptyId: string) => Record<string, string | undefined>

  constructor(options: PtyManagerOptions = {}) {
    super()
    this.getPaneEnv = options.getPaneEnv
    this._startWorker()
  }

  /** Wait until the current worker generation has completed its host handshake. */
  waitForHost(): Promise<void> {
    if (this.hostState === 'ready') return Promise.resolve()
    if (this.hostState === 'failed' || this.hostState === 'destroying') {
      return Promise.reject(new Error('Terminal host process is not running'))
    }
    return new Promise<void>((resolve, reject) => {
      this.hostWaiters.push({ resolve, reject })
    })
  }

  private _startWorker(): void {
    // ELECTRON_RUN_AS_NODE=1 makes electron.exe run as plain Node -- no Chromium
    // init, no inherited Chromium handles. stdio 'ipc' gives us message passing.
    const worker = spawn(
      process.execPath,
      [join(__dirname, 'ptyWorker.js')],
      {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
        },
      },
    )
    this.worker = worker
    const generation = ++this.workerGeneration

    if (this.e2eKillWorkerOnce) {
      this.e2eKillWorkerOnce = false
      const delay = Math.max(0, Number(process.env['MULTIAGENT_E2E_KILL_PTY_WORKER_AFTER_MS'] ?? 2000))
      const timer = setTimeout(() => {
        if (this.destroying) return
        try { worker.kill() } catch { /* already gone */ }
      }, delay)
      timer.unref?.()
    }

    worker.stderr?.on('data', (d: Buffer) => {
      const text = d.toString().trim()
      // node-pty forks conpty_console_list_agent on kill() to enumerate the
      // console process list. If the shell already exited, AttachConsole fails.
      if (text.includes('AttachConsole failed')) return
      console.error('[ptyWorker stderr]', text)
    })

    worker.on('message', (msg: ParentMessage) => {
      if (generation !== this.workerGeneration) return
      switch (msg.type) {
        case 'host-ready':
          this._handleHostReady()
          break
        case 'data':
          this.emit('data', msg.id, msg.data)
          break
        case 'exit':
          this._forgetId(msg.id)
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
          this._forgetId(msg.id)
          this.emit('error', msg.id, new Error(msg.message))
          break
        case 'shutdown-complete':
          // The worker exits immediately after this acknowledgement. The destroy
          // promise resolves on its exit event so Windows has released handles.
          break
      }
    })

    worker.on('error', (err) => {
      if (generation !== this.workerGeneration) return
      this._handleWorkerFailure(null, err)
    })

    worker.on('exit', (code) => {
      if (generation !== this.workerGeneration) return
      this._handleWorkerFailure(code, undefined)
    })
  }

  /**
   * Invalidate the worker generation and start one replacement. Existing PTYs
   * cannot be reattached, so the renderer receives the affected-id snapshot and
   * is responsible for creating fresh shell/resume PTYs after recovery.
   */
  private _handleWorkerFailure(code: number | null, error: Error | undefined): void {
    if (this.destroying || this.hostState === 'destroying' || this.hostState === 'failed') return
    const exitCode = typeof code === 'number' ? code : 1
    if (this.hostState === 'recovering') {
      this._finishRecoveryFailure(exitCode, error)
      return
    }

    const incidentId = randomUUID()
    this.incidentId = incidentId
    this.hostState = 'recovering'
    console.error(`[PtyManager] terminal host failure incident=${incidentId} code=${exitCode}`)
    this._invalidateReservations(incidentId, exitCode, (failure) => {
      // Announce before per-PTY exit events so the renderer can clear the id
      // before its ordinary agent-exit listener sees the stale identifier.
      this.emit('host-failure', failure)
    })

    // An error may arrive without an exit event. Kill the failed generation;
    // generation checks ignore any late event from the old child.
    try {
      if (this.worker.exitCode === null && this.worker.signalCode === null) this.worker.kill()
    } catch { /* already gone */ }
    this._startWorker()
  }

  private _handleHostReady(): void {
    if (this.destroying || this.hostState === 'destroying' || this.hostState === 'failed') return
    const wasRecovering = this.hostState === 'recovering'
    this.hostState = 'ready'
    const incidentId = this.incidentId
    this._resolveHostWaiters()
    if (wasRecovering && incidentId) this.emit('host-recovered', { incidentId })
  }

  private _finishRecoveryFailure(code: number, error: Error | undefined): void {
    const incidentId = this.incidentId ?? randomUUID()
    this.hostState = 'failed'
    const message = error?.message || `Terminal host recovery failed (code ${code})`
    this._invalidateReservations(incidentId, code, (failure) => {
      const event: PtyHostRecoveryFailure = { ...failure, message }
      this.emit('host-recovery-failed', event)
    })
    this._rejectHostWaiters(new Error('Terminal host process is not running'))
    try {
      if (this.worker.exitCode === null && this.worker.signalCode === null) this.worker.kill()
    } catch { /* already gone */ }
  }

  private _invalidateReservations(
    incidentId: string,
    code: number,
    beforePaneEvents?: (failure: PtyHostFailure) => void,
  ): PtyHostFailure {
    const affectedPtyIds = [...this.reservedIds]
    const unreadyPtyIds = affectedPtyIds.filter((id) => !this.readyIds.has(id))
    const unreadyNewAgentPtyIds = unreadyPtyIds.filter((id) => this.purposes.get(id) === 'new-agent')
    for (const entry of this.pendingSpawns.values()) {
      if (entry.timeout !== null) clearTimeout(entry.timeout)
    }
    const pendingIds = new Set(this.pendingSpawns.keys())
    const spawnedIds = new Set(this.spawnedIds)
    this.pendingSpawns.clear()
    this.pendingResizes.clear()
    this.reservedIds.clear()
    this.spawnedIds.clear()
    this.readyIds.clear()
    this.readyEvents.clear()
    const failure = { incidentId, code, affectedPtyIds, unreadyPtyIds, unreadyNewAgentPtyIds }
    beforePaneEvents?.(failure)
    for (const id of affectedPtyIds) {
      this.purposes.delete(id)
      if (!spawnedIds.has(id)) {
        const reason = pendingIds.has(id)
          ? `Terminal host process exited unexpectedly (code ${code})`
          : `Terminal host process became unavailable (code ${code})`
        this.emit('error', id, new Error(reason))
      }
    }
    for (const id of spawnedIds) this.emit('exit', id, code)
    return failure
  }

  private _resolveHostWaiters(): void {
    const waiters = this.hostWaiters.splice(0)
    for (const waiter of waiters) waiter.resolve()
  }

  private _rejectHostWaiters(error: Error): void {
    const waiters = this.hostWaiters.splice(0)
    for (const waiter of waiters) waiter.reject(error)
  }

  private _forgetId(id: string): void {
    this.pendingResizes.delete(id)
    this.pendingSpawns.delete(id)
    this.reservedIds.delete(id)
    this.spawnedIds.delete(id)
    this.readyIds.delete(id)
    this.readyEvents.delete(id)
    this.purposes.delete(id)
  }

  private _send(msg: WorkerMessage): void {
    if (this.destroying || this.hostState === 'failed' || !this.worker.connected) return
    this.worker.send(msg)
  }

  createDeferred(
    cwd: string,
    cmd: string[],
    extraEnv?: Record<string, string | undefined>,
    initialSize: { cols: number; rows: number } = { cols: 80, rows: 24 },
    allowCwdFallback = false,
    deferSpawn = false,
    purpose: PtyPurpose = 'shell',
    requestedId?: string,
  ): string {
    if (this.hostState === 'recovering' || this.hostState === 'failed' || this.destroying) {
      throw new Error('Terminal host process is not running')
    }
    const id = requestedId ?? randomUUID()
    if (this.reservedIds.has(id) || this.pendingSpawns.has(id) || this.spawnedIds.has(id)) {
      throw new Error(`PTY id is already reserved: ${id}`)
    }
    this.reservedIds.add(id)
    this.purposes.set(id, purpose)
    let mergedExtraEnv: Record<string, string | undefined>
    try {
      // Merge per-pane identity env (spec 047 phase 3) before buildEnv scrubs+applies.
      const paneEnv = this.getPaneEnv?.(id) ?? {}
      mergedExtraEnv = { ...extraEnv, ...paneEnv }
    } catch (error) {
      this._forgetId(id)
      throw error
    }
    let builtEnv: Record<string, string>
    try {
      builtEnv = buildEnv(mergedExtraEnv)
    } catch (error) {
      this._forgetId(id)
      throw error
    }

    if (deferSpawn) {
      // Register synchronously so a first resize arriving before setImmediate is
      // captured. The existsSync check remains async so callers attach listeners.
      const entry: PendingSpawn = {
        cwd,
        cmd,
        env: builtEnv,
        allowCwdFallback,
        size: initialSize,
        resized: false,
        timeout: null,
      }
      this.pendingSpawns.set(id, entry)
      setImmediate(() => {
        const pending = this.pendingSpawns.get(id)
        if (!pending || !this.reservedIds.has(id)) return
        const cwdExists = existsSync(pending.cwd)
        if (!cwdExists && !pending.allowCwdFallback) {
          this._forgetId(id)
          this.emit('error', id, new Error(`Working directory does not exist: ${pending.cwd}`))
          return
        }
        pending.cwd = cwdExists ? pending.cwd : homedir()
        if (pending.resized) {
          this.pendingSpawns.delete(id)
          this._spawn(id, pending.cwd, pending.cmd, pending.env, pending.size.cols, pending.size.rows, pending.allowCwdFallback)
          return
        }
        pending.timeout = setTimeout(() => {
          const current = this.pendingSpawns.get(id)
          if (!current || !this.reservedIds.has(id)) return
          this.pendingSpawns.delete(id)
          this._spawn(id, current.cwd, current.cmd, current.env, current.size.cols, current.size.rows, current.allowCwdFallback)
        }, DEFERRED_SPAWN_TIMEOUT_MS)
      })
      return id
    }

    setImmediate(() => {
      if (!this.reservedIds.has(id) || this.hostState === 'recovering' || this.hostState === 'failed') return
      const cwdExists = existsSync(cwd)
      if (!cwdExists && !allowCwdFallback) {
        this._forgetId(id)
        this.emit('error', id, new Error(`Working directory does not exist: ${cwd}`))
        return
      }
      this._spawn(id, cwdExists ? cwd : homedir(), cmd, builtEnv, initialSize.cols, initialSize.rows, allowCwdFallback)
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
    if (!this.reservedIds.has(id) || this.hostState === 'recovering' || this.hostState === 'failed' || this.destroying) return
    this.spawnedIds.add(id)
    this._send({ type: 'spawn', id, cwd, cmd, env, cols, rows, allowCwdFallback })
  }

  private _shellCmd(): { cmd: string[]; env?: Record<string, string> } {
    if (process.platform === 'win32') {
      return { cmd: ['powershell.exe', ...shellIntegrationCommand()] }
    }
    // Unix: wire the shell-integration script (OSC 633;P;Cwd + OSC 7) into bash/zsh.
    return unixShellLaunch(defaultShell())
  }

  createShell(cwd: string, initialSize?: { cols: number; rows: number }): string {
    // Shell panes may fall back to the home directory for deleted cwd paths.
    // Agent panes validate cwd before spawning and should fail loudly instead.
    const { cmd, env } = this._shellCmd()
    return this.createDeferred(cwd, cmd, env, initialSize, true, false, 'shell')
  }

  write(ptyId: string, data: string): void {
    if (!this.reservedIds.has(ptyId)) return
    this._send({ type: 'write', id: ptyId, data })
  }

  resize(ptyId: string, cols: number, rows: number): void {
    if (!this.reservedIds.has(ptyId) || this.hostState === 'recovering' || this.hostState === 'failed') return
    const pending = this.pendingSpawns.get(ptyId)
    if (pending) {
      // First resize for a deferred agent spawn: use this size for the actual
      // spawn so the CLI starts at the fitted dimensions.
      pending.size = { cols, rows }
      pending.resized = true
      if (pending.timeout !== null) {
        clearTimeout(pending.timeout)
        this.pendingSpawns.delete(ptyId)
        this._spawn(ptyId, pending.cwd, pending.cmd, pending.env, cols, rows, pending.allowCwdFallback)
      }
      return
    }
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
    if (!this.reservedIds.has(ptyId)) return
    const pending = this.pendingSpawns.get(ptyId)
    if (pending) {
      if (pending.timeout !== null) clearTimeout(pending.timeout)
      this._forgetId(ptyId)
      return
    }
    const spawned = this.spawnedIds.has(ptyId)
    this._forgetId(ptyId)
    if (spawned) this._send({ type: 'kill', id: ptyId })
  }

  getReadyEvent(ptyId: string): PtyReadyEvent | undefined {
    return this.readyEvents.get(ptyId)
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise
    this.destroying = true
    this.hostState = 'destroying'
    this._rejectHostWaiters(new Error('Terminal host process is shutting down'))
    for (const entry of this.pendingSpawns.values()) {
      if (entry.timeout !== null) clearTimeout(entry.timeout)
    }
    this.pendingSpawns.clear()
    this.pendingResizes.clear()
    this.reservedIds.clear()
    this.spawnedIds.clear()
    this.readyIds.clear()
    this.readyEvents.clear()
    this.purposes.clear()

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
