import { createServer, type Server as HttpServer } from 'http'
import type { AddressInfo } from 'net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { requireNumber, requireString, optionalNumber, optionalString, type ToolArgs } from './toolArgs'
import { AppUiManager } from '../uiAutomation/AppUiManager'

type Target = { endpoint: string }
const TOOLS = ['ui_targets', 'ui_attach_target', 'ui_windows', 'ui_content', 'ui_click', 'ui_type', 'ui_scroll', 'ui_keyboard', 'ui_drag', 'ui_wait_for', 'ui_screenshot', 'ui_evaluate', 'ui_console', 'ui_network']

export class AppUiMcpServer {
  private targets = new Map<string, Target>()
  private httpServer: HttpServer | null = null
  private windowQueues = new Map<string, Promise<unknown>>()
  constructor(private ui: AppUiManager) {}
  private server(): Server {
    const server = new Server({ name: 'multiagent-ui', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS.map((name) => ({ name, description: `Operate the target-scoped live MultiAgent UI via ${name}. Use target_id and window_id for every window operation; ui_attach_target requires endpoint.`, inputSchema: { type: 'object' as const, properties: { target_id: { type: 'string' }, window_id: { type: 'number' }, endpoint: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, source: { type: 'string' }, target: { type: 'string' }, key: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, timeout_ms: { type: 'number' }, js: { type: 'string' } } } })),
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => this.call(request.params.name, request.params.arguments))
    return server
  }
  private async call(name: string, args: ToolArgs): Promise<any> {
    try {
      if (name === 'ui_targets') return text(JSON.stringify([{ target_id: 'self', endpoint: null }]))
      if (name === 'ui_attach_target') {
        const endpoint = requireString(args, 'endpoint').replace(/\/$/, '')
        if (!/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(endpoint)) throw new Error('Endpoint must be a local http://127.0.0.1:<port>/mcp URL')
        const id = `target-${crypto.randomUUID()}`; this.targets.set(id, { endpoint }); return text(JSON.stringify({ target_id: id, endpoint }))
      }
      const targetId = optionalString(args, 'target_id') ?? 'self'
      if (name === 'ui_windows') return targetId === 'self' ? text(JSON.stringify(this.ui.windows())) : await this.proxy(targetId, name, args)
      const windowId = requireNumber(args, 'window_id')
      return await this.enqueue(`${targetId}:${windowId}`, async () => {
        if (targetId !== 'self') return this.proxy(targetId, name, args)
      switch (name) {
        case 'ui_content': return text(await this.ui.content(windowId))
        case 'ui_click': await this.ui.click(windowId, requireString(args, 'selector')); return text('Clicked')
        case 'ui_type': await this.ui.type(windowId, requireString(args, 'selector'), requireString(args, 'text')); return text('Typed')
        case 'ui_scroll': await this.ui.scroll(windowId, optionalNumber(args, 'x', 0) ?? 0, optionalNumber(args, 'y', 0) ?? 0); return text('Scrolled')
        case 'ui_keyboard': await this.ui.keyboard(windowId, requireString(args, 'key')); return text('Key sent')
        case 'ui_drag': await this.ui.drag(windowId, requireString(args, 'source'), requireString(args, 'target')); return text('Dragged')
        case 'ui_wait_for': await this.ui.waitFor(windowId, requireString(args, 'selector'), optionalNumber(args, 'timeout_ms', 5000) ?? 5000); return text('Element found')
        case 'ui_screenshot': { const data = await this.ui.screenshot(windowId); return { content: [{ type: 'image', data: data.replace(/^data:image\/\w+;base64,/, ''), mimeType: 'image/png' }] } }
        case 'ui_evaluate': {
          const result = await this.ui.evaluate(windowId, requireString(args, 'js'))
          return text(result === undefined ? 'undefined' : JSON.stringify(result))
        }
        case 'ui_console': return text(JSON.stringify(this.ui.consoleEntries(windowId)))
        case 'ui_network': return text(JSON.stringify(this.ui.networkEntries(windowId)))
        default: throw new Error(`Unknown tool: ${name}`)
      }
      })
    } catch (error) { return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true } }
  }
  private enqueue(key: string, operation: () => Promise<any>): Promise<any> {
    const prior = this.windowQueues.get(key) ?? Promise.resolve()
    const queued = prior.catch(() => undefined).then(operation)
    this.windowQueues.set(key, queued.finally(() => {
      if (this.windowQueues.get(key) === queued) this.windowQueues.delete(key)
    }))
    return queued
  }
  private async proxy(targetId: string, name: string, args: unknown): Promise<any> {
    const target = this.targets.get(targetId); if (!target) throw new Error(`Unknown target: ${targetId}`)
    const forwarded = { ...(args as Record<string, unknown>) }; delete forwarded.target_id
    let response: Response
    try {
      response = await fetch(target.endpoint, { signal: AbortSignal.timeout(10_000), method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: forwarded } }) })
    } catch (error) {
      throw new Error(`Target ${targetId} is unavailable: ${(error as Error).message}`)
    }
    if (!response.ok) throw new Error(`Target ${targetId} returned HTTP ${response.status}`)
    const body = await response.text(); const data = body.split(/\r?\n/).find((line) => line.startsWith('data: '))?.slice(6) ?? body
    const payload = JSON.parse(data) as { result?: unknown; error?: { message: string } }; if (payload.error) throw new Error(payload.error.message); return payload.result
  }
  async startHttp(port: number): Promise<number> {
    if (this.httpServer) throw new Error('UI automation server is already running')
    const http = createServer(async (req, res) => { try {
      if (req.method !== 'POST' || new URL(req.url ?? '/', 'http://x').pathname !== '/mcp') { res.writeHead(404).end(); return }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const server = this.server(); const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); await server.connect(transport); await transport.handleRequest(req, res, body); res.on('close', () => { void transport.close(); void server.close() })
    } catch (error) { if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ error: (error as Error).message })) } })
    this.httpServer = http
    return new Promise((resolve, reject) => { http.listen(port, '127.0.0.1', () => resolve((http.address() as AddressInfo).port)); http.once('error', (error) => { this.httpServer = null; reject(error) }) })
  }
  async close(): Promise<void> {
    const http = this.httpServer
    this.httpServer = null
    this.targets.clear()
    this.windowQueues.clear()
    if (!http) return
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()))
  }
}
function text(value: string): any { return { content: [{ type: 'text', text: value }] } }
