/**
 * agentProcessSweeper — the single app-global poller that promotes/demotes shell panes
 * based on the foreground process in their tree.
 *
 * One instance lives next to PtyManager/SessionSpawner in registerIpcHandlers
 * (PtyManager is a singleton; cross-window delivery is windowManager.sendToWindowForPty,
 * so the sweeper is global, not per-window). It tracks ONLY shell panes (the `pty:create`
 * handler calls trackShell); SessionSpawner's agent panes are never tracked.
 *
 * On each tick (only while at least one shell pane is tracked) it snapshots the process
 * table once (shared across all tracked panes), runs the pure selector per ptyId, and
 * emits `pane:agent-detected(ptyId, agentKind | null)` ONLY on a confirmed transition.
 * Two consecutive identical observations are required before promoting or demoting, so a
 * transient `claude --version` does not flap the pane kind (worst-case latency ≈ 2× the
 * sweep interval). See spec 047 phase 1c.
 */

import type { EventEmitter } from 'events'
import type { AgentKind } from '../../shared/types'
import { selectForegroundAgent, type ProcessEntry } from './agentProcessDetect'

export interface SweeperDeps {
  /** PtyManager (singleton). Used only for `on('ready')`/`on('exit')` subscriptions. */
  ptyManager: EventEmitter
  /** Cross-window delivery — sends to whichever window owns the ptyId. */
  sendToWindowForPty: (ptyId: string, channel: string, ...args: unknown[]) => boolean
  /** Process-table snapshot. Injected so tests can supply synthetic entries. */
  snapshot?: () => Promise<ProcessEntry[]>
  /**
   * Fired on every confirmed transition (promotion to an agent kind, or demotion to null).
   * Used by handlers.ts to drive session-id linking (spec 047 phase 2) for the promoted
   * pane. Optional so the selector/sweeper tests need not wire a linker.
   */
  onDetected?: (ptyId: string, agentKind: AgentKind | null) => void
}

const SWEEP_INTERVAL_MS = 2500

export class AgentProcessSweeper {
  private tracked = new Set<string>()          // shell-pane ptyIds
  private pids = new Map<string, number>()     // ptyId -> shell pid (from pty:ready)
  private lastObserved = new Map<string, AgentKind | null>()  // last single observation
  private emitted = new Map<string, AgentKind | null>()       // last emitted (confirmed) kind
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight = false
  private readonly snapshot: () => Promise<ProcessEntry[]>
  private readonly onReady: (e: { id: string; pid: number | null }) => void
  private readonly onExit: (id: string) => void

  constructor(private deps: SweeperDeps) {
    this.snapshot = deps.snapshot ?? defaultSnapshot
    this.onReady = (e) => {
      if (this.tracked.has(e.id) && typeof e.pid === 'number') this.pids.set(e.id, e.pid)
    }
    this.onExit = (id) => this.untrack(id)
    deps.ptyManager.on('ready', this.onReady)
    deps.ptyManager.on('exit', this.onExit)
  }

  /** Start watching a shell pane. Called from the pty:create handler. */
  trackShell(ptyId: string): void {
    if (this.tracked.has(ptyId)) return
    this.tracked.add(ptyId)
    if (this.timer === null) this.startTimer()
  }

  /** Stop watching a pane (pty exited or app shutdown). */
  untrack(ptyId: string): void {
    this.tracked.delete(ptyId)
    this.pids.delete(ptyId)
    this.lastObserved.delete(ptyId)
    this.emitted.delete(ptyId)
    if (this.tracked.size === 0) this.stopTimer()
  }

  private startTimer(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => { void this.tick() }, SWEEP_INTERVAL_MS)
    // setInterval keeps the process alive; unref so it never blocks app shutdown.
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** One sweep. Public so tests can drive it deterministically with a synthetic snapshot. */
  async tick(): Promise<void> {
    if (this.inFlight || this.tracked.size === 0) return
    this.inFlight = true
    let entries: ProcessEntry[]
    try {
      entries = await this.snapshot()
    } catch {
      // Fail closed: a snapshot error means no candidates this tick — no transition.
      this.inFlight = false
      return
    } finally {
      this.inFlight = false
    }
    // Re-check tracked after the async snapshot; panes may have exited mid-sweep.
    for (const ptyId of [...this.tracked]) {
      const pid = this.pids.get(ptyId)
      if (pid === undefined) continue
      const observed = selectForegroundAgent(pid, entries)
      const prev = this.lastObserved.get(ptyId) ?? null
      const current = this.emitted.get(ptyId) ?? null
      // Two consecutive identical observations, and a change from the last emitted kind.
      if (observed === prev && observed !== current) {
        this.emitted.set(ptyId, observed)
        this.deps.sendToWindowForPty(ptyId, 'pane:agent-detected', ptyId, observed)
        this.deps.onDetected?.(ptyId, observed)
      }
      this.lastObserved.set(ptyId, observed)
    }
  }

  dispose(): void {
    this.stopTimer()
    this.deps.ptyManager.off('ready', this.onReady)
    this.deps.ptyManager.off('exit', this.onExit)
    this.tracked.clear()
    this.pids.clear()
    this.lastObserved.clear()
    this.emitted.clear()
  }
}

/** Default snapshot source — the platform-specific seam in processSnapshot.ts. */
async function defaultSnapshot(): Promise<ProcessEntry[]> {
  const { snapshotProcesses } = await import('./processSnapshot.js')
  return snapshotProcesses()
}