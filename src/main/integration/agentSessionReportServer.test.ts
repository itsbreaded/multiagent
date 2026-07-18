import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as http from 'http'
import { AgentSessionReportServer, type AgentSessionReport, type AgentEventReport } from './agentSessionReportServer'

// Spec 047 phase 3 / phase 4 + spec 032: the report server parses the hook's POSTs and
// calls onReport (session linking) / onEvent (status badges). Drives it with a real
// localhost HTTP round-trip (Node http is available in the main test env).

function post(port: number, path: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => { res.resume(); resolve(res.statusCode ?? 0) },
    )
    req.on('error', reject)
    req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

describe('AgentSessionReportServer -- /agent-session (spec 047)', () => {
  let server: AgentSessionReportServer

  beforeEach(() => { server = new AgentSessionReportServer({ onReport: () => {}, onEvent: () => {} }) })
  afterEach(() => { server.stop() })

  it('starts, assigns a port, and invokes onReport for a well-formed Claude POST', async () => {
    const reports: AgentSessionReport[] = []
    server = new AgentSessionReportServer({ onReport: (r) => reports.push(r), onEvent: () => {} })
    server.start()
    const port = await server.ready()
    expect(typeof port).toBe('number')
    const status = await post(port!, '/agent-session', { ptyId: 'p1', agentKind: 'claude', sessionId: 'sess-1', transcriptPath: 'C:\\t.jsonl' })
    expect(status).toBe(204)
    expect(reports).toEqual([{ ptyId: 'p1', agentKind: 'claude', sessionId: 'sess-1', transcriptPath: 'C:\\t.jsonl' }])
  })

  it('accepts a codex report and surfaces its agentKind', async () => {
    const reports: AgentSessionReport[] = []
    server = new AgentSessionReportServer({ onReport: (r) => reports.push(r), onEvent: () => {} })
    server.start()
    const port = await server.ready()
    const status = await post(port!, '/agent-session', { ptyId: 'p2', agentKind: 'codex', sessionId: 'sess-2' })
    expect(status).toBe(204)
    expect(reports).toEqual([{ ptyId: 'p2', agentKind: 'codex', sessionId: 'sess-2', transcriptPath: undefined }])
  })

  it('rejects an unknown agentKind with 400 and does not invoke onReport', async () => {
    const reports: unknown[] = []
    server = new AgentSessionReportServer({ onReport: (r) => reports.push(r), onEvent: () => {} })
    server.start()
    const port = await server.ready()
    const status = await post(port!, '/agent-session', { ptyId: 'p3', agentKind: 'gemini', sessionId: 'sess-3' })
    expect(status).toBe(400)
    expect(reports).toHaveLength(0)
  })

  it('rejects a malformed body with 400 and does not invoke onReport', async () => {
    const reports: unknown[] = []
    server = new AgentSessionReportServer({ onReport: (r) => reports.push(r), onEvent: () => {} })
    server.start()
    const port = await server.ready()
    const status = await post(port!, '/agent-session', { nope: true })
    expect(status).toBe(400)
    expect(reports).toHaveLength(0)
  })

  it('returns 404 for an unknown path', async () => {
    server.start()
    const port = await server.ready()
    const status = await new Promise<number>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/other', method: 'POST' }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      req.write('x'); req.end()
    })
    expect(status).toBe(404)
  })
})

describe('AgentSessionReportServer -- /agent-event (spec 032)', () => {
  let server: AgentSessionReportServer

  beforeEach(() => { server = new AgentSessionReportServer({ onReport: () => {}, onEvent: () => {} }) })
  afterEach(() => { server.stop() })

  it('invokes onEvent for a well-formed lifecycle event and returns 204', async () => {
    const events: AgentEventReport[] = []
    server = new AgentSessionReportServer({ onReport: () => {}, onEvent: (e) => events.push(e) })
    server.start()
    const port = await server.ready()
    const status = await post(port!, '/agent-event', {
      ptyId: 'p1', agentKind: 'claude', event: 'pre_tool_use', detail: 'Bash', turnId: 'turn-1',
    })
    expect(status).toBe(204)
    expect(events).toEqual([{ ptyId: 'p1', agentKind: 'claude', event: 'pre_tool_use', detail: 'Bash', turnId: 'turn-1' }])
  })

  it('accepts an event with optional fields omitted (detail/turnId undefined)', async () => {
    const events: AgentEventReport[] = []
    server = new AgentSessionReportServer({ onReport: () => {}, onEvent: (e) => events.push(e) })
    server.start()
    const port = await server.ready()
    const status = await post(port!, '/agent-event', { ptyId: 'p2', agentKind: 'codex', event: 'stop' })
    expect(status).toBe(204)
    expect(events).toEqual([{ ptyId: 'p2', agentKind: 'codex', event: 'stop', detail: undefined, turnId: undefined }])
  })

  it('rejects a synthetic promote/demote event (not in the allow-list) with 400', async () => {
    const events: unknown[] = []
    server = new AgentSessionReportServer({ onReport: () => {}, onEvent: (e) => events.push(e) })
    server.start()
    const port = await server.ready()
    const status = await post(port!, '/agent-event', { ptyId: 'p3', agentKind: 'claude', event: 'promote' })
    expect(status).toBe(400)
    expect(events).toHaveLength(0)
  })

  it('rejects an unknown event name with 400', async () => {
    const events: unknown[] = []
    server = new AgentSessionReportServer({ onReport: () => {}, onEvent: (e) => events.push(e) })
    server.start()
    const port = await server.ready()
    const status = await post(port!, '/agent-event', { ptyId: 'p3', agentKind: 'claude', event: 'subagent_start' })
    expect(status).toBe(400)
    expect(events).toHaveLength(0)
  })

  it('rejects a bad agentKind with 400 and does not invoke onEvent', async () => {
    const events: unknown[] = []
    server = new AgentSessionReportServer({ onReport: () => {}, onEvent: (e) => events.push(e) })
    server.start()
    const port = await server.ready()
    const status = await post(port!, '/agent-event', { ptyId: 'p4', agentKind: 'gemini', event: 'stop' })
    expect(status).toBe(400)
    expect(events).toHaveLength(0)
  })

  it('rejects a missing ptyId with 400', async () => {
    const events: unknown[] = []
    server = new AgentSessionReportServer({ onReport: () => {}, onEvent: (e) => events.push(e) })
    server.start()
    const port = await server.ready()
    const status = await post(port!, '/agent-event', { agentKind: 'claude', event: 'stop' })
    expect(status).toBe(400)
    expect(events).toHaveLength(0)
  })

  it('returns 404 for a GET on /agent-event', async () => {
    server.start()
    const port = await server.ready()
    const status = await new Promise<number>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/agent-event', method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      req.end()
    })
    expect(status).toBe(404)
  })
})