/**
 * terminalStatusScraper -- the main-side per-pane owner of Detector instances
 * (spec 050 phase 4).
 *
 * This is the orchestrator around the pure `terminalStatusDetector`. PtyManager does
 * not track agentKind and the pure detector must stay IO-free, so this module owns:
 *   - a lazy `ptyId -> Detector` map (created on first data for a codex pane),
 *   - the gating policy (read main's authoritative `agentStatusScraping` flag +
 *     the `ptyId -> agentKind` map populated by SessionSpawner), and
 *   - the IPC fanout (`pane:terminal-status` via windowManager.sendToWindowForPty).
 *
 * The detector itself never touches Electron; the scraper is the seam that keeps
 * that invariant. Read-only observer on the PTY stream -- it never writes to user
 * agent config, never installs hooks, never spawns anything.
 */

import type { AgentKind } from '../../shared/types'
import { createDetector, TERMINAL_STATUS_PATTERNS, type Detector } from './terminalStatusDetector'

export interface ScraperDeps {
  /** The ptyId -> agentKind map populated by SessionSpawner (v1: app-spawned only). */
  getAgentKind: (ptyId: string) => AgentKind | undefined
  /** Reads main's authoritative copy of the `agentStatusScraping` setting. */
  isEnabled: () => boolean
  /** Cross-window delivery -- sends pane:terminal-status to the owning window. */
  sendToWindowForPty: (ptyId: string, channel: string, ...args: unknown[]) => void
}

export class TerminalStatusScraper {
  private detectors = new Map<string, Detector>()

  constructor(private deps: ScraperDeps) {}

  /**
   * Feed a chunk of PTY output. Gated by the setting and by agentKind -- when the
   * setting is off or the pane is not a codex pane, this is a cheap early-out with
   * no Detector allocation. The detector is created lazily on the first eligible
   * chunk so a pane that never errors pays no ongoing cost.
   */
  feed(ptyId: string, data: string): void {
    if (!this.deps.isEnabled() || !data) return
    const agentKind = this.deps.getAgentKind(ptyId)
    if (agentKind === undefined) return
    // Cheap structural check: only build a Detector for agentKinds that actually
    // have patterns. claude is empty today (StopFailure covers its error path).
    // This keeps the agent-agnostic plumbing from allocating for agents we can't
    // help yet, without weaving agentKind special-cases into the pipeline.
    if (TERMINAL_STATUS_PATTERNS[agentKind].length === 0) return
    let detector = this.detectors.get(ptyId)
    if (!detector) {
      detector = createDetector(agentKind)
      this.detectors.set(ptyId, detector)
    }
    const event = detector.feed(data)
    if (event) {
      // Same IPC shape as pane:agent-event (sans turnId) -- the renderer handler
      // feeds it straight into eventToState. Scraping is explicitly NOT a second
      // status write path; it adds one event type to the existing union.
      this.deps.sendToWindowForPty(ptyId, 'pane:terminal-status', ptyId, event.event, event.detail)
    }
  }

  /** Drop a pane's detector state. Called from the router's releasePty on PTY exit. */
  release(ptyId: string): void {
    const d = this.detectors.get(ptyId)
    if (d) {
      d.reset()
      this.detectors.delete(ptyId)
    }
  }

  /**
   * Drop every detector. Called when the setting flips OFF so we stop carrying
   * per-pane state for a feature the user just disabled -- the next time it flips
   * back on, detectors re-create lazily on fresh data.
   */
  clearAll(): void {
    for (const d of this.detectors.values()) d.reset()
    this.detectors.clear()
  }

  dispose(): void {
    this.clearAll()
  }
}
