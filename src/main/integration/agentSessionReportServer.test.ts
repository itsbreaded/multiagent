import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as http from 'http'
import { AgentSessionReportServer, type AgentSessionReport } from './agentSessionReportServer'

// Spec 047 phase 3 / phase 4: the report server parses the hook's POST and calls onReport
// with the reported agentKind. Drives it with a real localhost HTTP round-trip (Node http
// is available in the main test env).

function post(port: number, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/agent-session', method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => { res.resume(); resolve(res.statusCode ?? 0) },
    )
    req.on('error', reject)
    req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

describe('AgentSessionReportServer', () => {
  let server: AgentSessionReportServer

  beforeEach(() => { server = new AgentSessionReportServer({ onReport: () => {} }) })
  afterEach(() => { server.stop() })

  it('starts, assigns a port, and invokes onReport for a well-formed Claude POST', async () => {
    const reports: AgentSessionReport[] = []
    server = new AgentSessionReportServer({ onReport: (r) => reports.push(r) })
    server.start()
    const port = await server.ready()
    expect(typeof port).toBe('number')
    const status = await post(port!, { ptyId: 'p1', agentKind: 'claude', sessionId: 'sess-1', transcriptPath: 'C:\\t.jsonl' })
    expect(status).toBe(204)
    expect(reports).toEqual([{ ptyId: 'p1', agentKind: 'claude', sessionId: 'sess-1', transcriptPath: 'C:\\t.jsonl' }])
  })

  it('accepts a codex report and surfaces its agentKind', async () => {
    const reports: AgentSessionReport[] = []
    server = new AgentSessionReportServer({ onReport: (r) => reports.push(r) })
    server.start()
    const port = await server.ready()
    const status = await post(port!, { ptyId: 'p2', agentKind: 'codex', sessionId: 'sess-2' })
    expect(status).toBe(204)
    expect(reports).toEqual([{ ptyId: 'p2', agentKind: 'codex', sessionId: 'sess-2', transcriptPath: undefined }])
  })

  it('rejects an unknown agentKind with 400 and does not invoke onReport', async () => {
    const reports: unknown[] = []
    server = new AgentSessionReportServer({ onReport: (r) => reports.push(r) })
    server.start()
    const port = await server.ready()
    const status = await post(port!, { ptyId: 'p3', agentKind: 'gemini', sessionId: 'sess-3' })
    expect(status).toBe(400)
    expect(reports).toHaveLength(0)
  })

  it('rejects a malformed body with 400 and does not invoke onReport', async () => {
    const reports: unknown[] = []
    server = new AgentSessionReportServer({ onReport: (r) => reports.push(r) })
    server.start()
    const port = await server.ready()
    const status = await post(port!, { nope: true })
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
