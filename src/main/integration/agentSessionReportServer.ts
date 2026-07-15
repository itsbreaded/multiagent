/**
 * agentSessionReportServer — a localhost HTTP loopback endpoint the managed agent
 * SessionStart hook (assets/multiagent-agent-state.ps1) POSTs to, reporting the session
 * id + transcript path for a (CLI-launched, promoted) agent (spec 047 phase 3 / phase 4).
 *
 * Self-contained transport: no external host runtime, no named-pipe complexity. The hook
 * inherits MULTIAGENT_HOOK_PORT from the pane env and POSTs
 * `{ ptyId, agentKind, sessionId, transcriptPath }` to `http://127.0.0.1:<port>/agent-
 * session`. Main links the session to the pane by ptyId and emits `session:detected`
 * with the reported `agentKind`.
 *
 * Only runs while the session-linking feature is enabled (default-on under phase 4).
 * Bound to 127.0.0.1 only — never exposes a port to the network.
 */

import * as http from 'http'
import type { AgentKind } from '../../shared/types'

const VALID_AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex']

export interface AgentSessionReport {
  ptyId: string
  agentKind: AgentKind
  sessionId: string
  transcriptPath?: string
}

export interface AgentSessionReportServerDeps {
  /** Called for each well-formed report. Main emits `session:detected` from here. */
  onReport: (report: AgentSessionReport) => void
}

export class AgentSessionReportServer {
  private server: http.Server | null = null
  private _port: number | null = null

  constructor(private deps: AgentSessionReportServerDeps) {}

  get port(): number | null { return this._port }

  start(): boolean {
    if (this.server) return true
    this.server = http.createServer((req, res) => this.handle(req, res))
    // Synchronous listen on 127.0.0.1 only. If the OS cannot assign a port, fail closed
    // (the feature degrades to phase-2 filesystem linking for Claude).
    let assigned = false
    this.server.listen(0, '127.0.0.1', () => {
      const addr = this.server?.address()
      this._port = addr && typeof addr === 'object' ? addr.port : null
      assigned = true
    })
    // http.Server.listen is async, but a port is assigned synchronously on the next tick
    // in practice; callers that need the port immediately poll `this.port` after a tick.
    this.server.on('error', (err) => {
      console.error('[MultiAgent] agent session report server error:', err)
      this.stop()
    })
    // Return a provisional true; the actual port is available after listen's callback.
    void assigned
    return true
  }

  /** Resolve once listen has assigned a port (or failed). */
  async ready(): Promise<number | null> {
    if (!this.server) return null
    if (this._port !== null) return this._port
    return new Promise((resolve) => {
      const check = () => {
        if (this._port !== null) resolve(this._port)
        else if (!this.server) resolve(null)
        else setTimeout(check, 5)
      }
      check()
    })
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
      this._port = null
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/agent-session') {
      res.writeHead(404); res.end(); return
    }
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as Partial<AgentSessionReport>
        if (
          typeof parsed.ptyId === 'string' &&
          typeof parsed.agentKind === 'string' &&
          (VALID_AGENT_KINDS as readonly string[]).includes(parsed.agentKind) &&
          typeof parsed.sessionId === 'string' && parsed.sessionId
        ) {
          this.deps.onReport({
            ptyId: parsed.ptyId,
            agentKind: parsed.agentKind as AgentKind,
            sessionId: parsed.sessionId,
            transcriptPath: parsed.transcriptPath,
          })
          res.writeHead(204); res.end()
        } else {
          res.writeHead(400); res.end()
        }
      } catch {
        res.writeHead(400); res.end()
      }
    })
  }
}