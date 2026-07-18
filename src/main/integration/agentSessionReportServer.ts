/**
 * agentSessionReportServer -- a localhost HTTP loopback endpoint the managed agent
 * hook (assets/multiagent-agent-state.ps1 / .sh) POSTs to.
 *
 * Two routes (spec 047 + spec 032):
 *   - POST /agent-session : the 047 session-linking report
 *     `{ ptyId, agentKind, sessionId, transcriptPath? }` -> onReport -> `session:detected`.
 *   - POST /agent-event   : the 032 lifecycle-event report (status badges)
 *     `{ ptyId, agentKind, event, detail?, turnId? }` -> onEvent -> `pane:agent-event`.
 *
 * Self-contained transport: no external host runtime, no named-pipe complexity. The hook
 * inherits MULTIAGENT_HOOK_PORT from the pane env. Only runs while the session-linking
 * feature is enabled (default-on). Bound to 127.0.0.1 only -- never exposes a port to the
 * network.
 */

import * as http from 'http'
import type { AgentKind, AgentLifecycleEvent } from '../../shared/types'

const VALID_AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex']

// The lifecycle events the hook script may report (spec 032). NO promote/demote (those are
// synthetic, renderer-only via the sweeper) and NO subagent_* (out of scope for v1).
const VALID_EVENTS: readonly AgentLifecycleEvent[] = [
  'session_start', 'user_prompt_submit', 'pre_tool_use', 'post_tool_use',
  'stop', 'permission_request', 'stop_failure',
] as const

export interface AgentSessionReport {
  ptyId: string
  agentKind: AgentKind
  sessionId: string
  transcriptPath?: string
}

export interface AgentEventReport {
  ptyId: string
  agentKind: AgentKind
  event: AgentLifecycleEvent
  detail?: string
  turnId?: string
}

export interface AgentSessionReportServerDeps {
  /** Called for each well-formed /agent-session report. Main emits `session:detected`. */
  onReport: (report: AgentSessionReport) => void
  /** Called for each well-formed /agent-event report. Main forwards `pane:agent-event`. */
  onEvent: (report: AgentEventReport) => void
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
    this.server.on('error', (err) => {
      console.error('[MultiAgent] agent session report server error:', err)
      this.stop()
    })
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
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return }
    if (req.url === '/agent-session') { this.handleSession(req, res); return }
    if (req.url === '/agent-event') { this.handleEvent(req, res); return }
    res.writeHead(404); res.end()
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    return new Promise((resolve) => req.on('end', () => resolve(body)))
  }

  private handleSession(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req).then((body) => {
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

  private handleEvent(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req).then((body) => {
      try {
        const parsed = JSON.parse(body) as Partial<AgentEventReport>
        if (
          typeof parsed.ptyId === 'string' && parsed.ptyId &&
          typeof parsed.agentKind === 'string' &&
          (VALID_AGENT_KINDS as readonly string[]).includes(parsed.agentKind) &&
          typeof parsed.event === 'string' &&
          (VALID_EVENTS as readonly string[]).includes(parsed.event)
        ) {
          this.deps.onEvent({
            ptyId: parsed.ptyId,
            agentKind: parsed.agentKind as AgentKind,
            event: parsed.event as AgentLifecycleEvent,
            detail: typeof parsed.detail === 'string' ? parsed.detail : undefined,
            turnId: typeof parsed.turnId === 'string' ? parsed.turnId : undefined,
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