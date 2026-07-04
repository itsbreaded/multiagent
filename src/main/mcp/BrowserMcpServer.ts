import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { BrowserContentResult, BrowserViewManager } from '../browser/BrowserViewManager'
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  optionalStringArray,
  requireCookies,
  requireNumber,
  requireString,
} from './toolArgs'

export class BrowserMcpServer {
  constructor(private browser: BrowserViewManager) {}

  private _makeServer(): Server {
    const server = new Server(
      { name: 'multiagent-browser', version: '1.0.0' },
      { capabilities: { tools: {} } }
    )
    this._registerHandlers(server)
    return server
  }

  private _registerHandlers(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'browser_navigate',
          description: 'Navigate the embedded browser to a URL',
          inputSchema: {
            type: 'object' as const,
            properties: { url: { type: 'string', description: 'URL to navigate to' } },
            required: ['url'],
          },
        },
        {
          name: 'browser_click',
          description: 'Click an element by CSS selector',
          inputSchema: {
            type: 'object' as const,
            properties: { selector: { type: 'string' } },
            required: ['selector'],
          },
        },
        {
          name: 'browser_type',
          description: 'Type text into an element',
          inputSchema: {
            type: 'object' as const,
            properties: {
              selector: { type: 'string' },
              text: { type: 'string' },
            },
            required: ['selector', 'text'],
          },
        },
        {
          name: 'browser_screenshot',
          description:
            'Take a screenshot of the current browser view. Use when visual layout matters; use text/link/element tools for semantic checks.',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'browser_evaluate',
          description: 'Execute JavaScript in the browser and return the result',
          inputSchema: {
            type: 'object' as const,
            properties: { js: { type: 'string', description: 'JavaScript to execute' } },
            required: ['js'],
          },
        },
        {
          name: 'browser_get_content',
          description: 'Get visible text. Prefer browser_get_url for URL checks, browser_wait_for_text for confirmation, browser_get_elements for scoped text/attributes, and browser_get_links for links. With no selector this returns whole-page text and can be large; reserve it for orientation or broad audits.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              selector: { type: 'string', description: 'Optional CSS selector to scope text to one element instead of the whole page' },
              max_chars: { type: 'number', description: 'Optional positive character limit. If exceeded, text is truncated and metadata reports the full size.' },
            },
          },
        },
        {
          name: 'browser_scroll',
          description: 'Scroll the page by x/y pixels',
          inputSchema: {
            type: 'object' as const,
            properties: {
              x: { type: 'number', default: 0 },
              y: { type: 'number', default: 0 },
            },
          },
        },
        {
          name: 'browser_wait_for',
          description: 'Wait for a CSS selector to appear in the page. Use this for targeted readiness checks instead of dumping page text.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              selector: { type: 'string' },
              timeout_ms: { type: 'number', default: 5000 },
            },
            required: ['selector'],
          },
        },
        {
          name: 'browser_go_back',
          description: 'Navigate back one step in the browser history',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'browser_go_forward',
          description: 'Navigate forward one step in the browser history',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'browser_hover',
          description: 'Hover over an element by CSS selector, triggering mouseover/mouseenter and native mouse-move events',
          inputSchema: {
            type: 'object' as const,
            properties: { selector: { type: 'string' } },
            required: ['selector'],
          },
        },
        {
          name: 'browser_keyboard',
          description: 'Send a keyboard key press (keydown + keyup). Common keys: Return, Escape, Tab, Space, Backspace, Delete, Up, Down, Left, Right, F1-F12',
          inputSchema: {
            type: 'object' as const,
            properties: {
              key: { type: 'string', description: 'Key name, e.g. "Return", "Escape", "Tab", "a"' },
              modifiers: {
                type: 'array',
                items: { type: 'string', enum: ['shift', 'ctrl', 'alt', 'meta'] },
                description: 'Optional modifier keys',
              },
            },
            required: ['key'],
          },
        },
        {
          name: 'browser_wait_for_load',
          description: 'Wait for the current page to finish loading (spinner stops)',
          inputSchema: {
            type: 'object' as const,
            properties: { timeout_ms: { type: 'number', default: 10000 } },
          },
        },
        {
          name: 'browser_select',
          description: 'Set the value of a <select> dropdown by CSS selector',
          inputSchema: {
            type: 'object' as const,
            properties: {
              selector: { type: 'string' },
              value: { type: 'string', description: 'The option value to select' },
            },
            required: ['selector', 'value'],
          },
        },
        {
          name: 'browser_get_url',
          description: 'Get the current URL of the browser. Preferred for URL/location checks.',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'browser_click_text',
          description: 'Click the first visible element whose text content matches the given string. Preferred over browser_click when you know the label but not the CSS selector — e.g. clicking a menu item, button, or link by its visible label.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              text: { type: 'string', description: 'Visible text to search for (case-insensitive substring match by default)' },
              exact: { type: 'boolean', description: 'If true, require an exact full-text match (default false)' },
            },
            required: ['text'],
          },
        },
        {
          name: 'browser_click_at',
          description: 'Click at specific (x, y) pixel coordinates in the browser viewport. Use when a CSS selector is ambiguous or two elements overlap — check element positions first with browser_get_elements.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              x: { type: 'number', description: 'Horizontal pixel coordinate' },
              y: { type: 'number', description: 'Vertical pixel coordinate' },
            },
            required: ['x', 'y'],
          },
        },
        {
          name: 'browser_hover_at',
          description: 'Hover at specific (x, y) pixel coordinates, firing native mouse-move and JS mouse events at the element underneath. Use when browser_hover triggers the wrong element due to overlapping selectors.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              x: { type: 'number', description: 'Horizontal pixel coordinate' },
              y: { type: 'number', description: 'Vertical pixel coordinate' },
            },
            required: ['x', 'y'],
          },
        },
        {
          name: 'browser_get_elements',
          description: 'Return all elements matching a CSS selector with their tag, text, value, id, classes, href, role, and bounding box (x/y/width/height). Use this to inspect the DOM or find coordinates before browser_click_at / browser_hover_at. For link navigation, prefer browser_get_links which is scoped to <a> elements.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              selector: { type: 'string', description: 'CSS selector to query' },
            },
            required: ['selector'],
          },
        },
        {
          name: 'browser_get_links',
          description: 'Return all visible <a> links on the page with their text and href URL. Use this when you need to navigate to a link — find the href here, then call browser_navigate with it directly. Much more reliable than browser_click_text for complex nested link structures. Optionally filter by text substring.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              text_filter: { type: 'string', description: 'Optional substring to filter links by their visible text (case-insensitive)' },
            },
          },
        },
        {
          name: 'browser_wait_for_text',
          description: 'Wait until the given text appears anywhere on the page (case-insensitive). Preferred for simple confirmation after an action instead of browser_get_content.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              text: { type: 'string', description: 'Text to wait for' },
              timeout_ms: { type: 'number', default: 5000 },
            },
            required: ['text'],
          },
        },
        {
          name: 'browser_set_cookies',
          description: 'Set one or more cookies in the browser session',
          inputSchema: {
            type: 'object' as const,
            properties: {
              cookies: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    url: { type: 'string' },
                    name: { type: 'string' },
                    value: { type: 'string' },
                    domain: { type: 'string' },
                    path: { type: 'string' },
                    secure: { type: 'boolean' },
                    http_only: { type: 'boolean' },
                    expiration_date: { type: 'number' },
                  },
                  required: ['url', 'name', 'value'],
                },
              },
            },
            required: ['cookies'],
          },
        },
      ],
    }))

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params
      try {
        switch (name) {
          case 'browser_navigate': {
            const url = requireString(args, 'url')
            const nav = await this.browser.navigate(url)
            return { content: [{ type: 'text' as const, text: `Navigated to ${nav.url}\nTitle: ${nav.title}` }] }
          }

          case 'browser_click': {
            const selector = requireString(args, 'selector')
            const nav = await this.browser.click(selector)
            return { content: [{ type: 'text' as const, text: `Clicked ${selector}\nURL: ${nav.url}\nTitle: ${nav.title}` }] }
          }

          case 'browser_type': {
            const selector = requireString(args, 'selector')
            const text = requireString(args, 'text')
            await this.browser.type(selector, text)
            return { content: [{ type: 'text' as const, text: 'Typed text' }] }
          }

          case 'browser_screenshot': {
            const dataUrl = await this.browser.screenshot()
            const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
            return {
              content: [{ type: 'image' as const, data: base64, mimeType: 'image/png' as const }],
            }
          }

          case 'browser_evaluate': {
            const js = requireString(args, 'js')
            const result = await this.browser.evaluate(js)
            return { content: [{ type: 'text' as const, text: result === undefined ? 'undefined' : JSON.stringify(result) }] }
          }

          case 'browser_get_content': {
            const selector = optionalString(args, 'selector')
            const maxChars = optionalNumber(args, 'max_chars')
            const result = await this.browser.getContent({ selector, maxChars })
            return { content: [{ type: 'text' as const, text: formatContentResult(result) }] }
          }

          case 'browser_scroll': {
            const x = optionalNumber(args, 'x', 0) ?? 0
            const y = optionalNumber(args, 'y', 0) ?? 0
            await this.browser.scroll(x, y)
            return { content: [{ type: 'text' as const, text: 'Scrolled' }] }
          }

          case 'browser_wait_for': {
            const selector = requireString(args, 'selector')
            const timeoutMs = optionalNumber(args, 'timeout_ms', 5000) ?? 5000
            await this.browser.waitFor(selector, timeoutMs)
            return {
              content: [{ type: 'text' as const, text: `Element found: ${selector}` }],
            }
          }

          case 'browser_go_back': {
            const nav = await this.browser.goBack()
            return { content: [{ type: 'text' as const, text: `Navigated back to ${nav.url}\nTitle: ${nav.title}` }] }
          }

          case 'browser_go_forward': {
            const nav = await this.browser.goForward()
            return { content: [{ type: 'text' as const, text: `Navigated forward to ${nav.url}\nTitle: ${nav.title}` }] }
          }

          case 'browser_hover': {
            const selector = requireString(args, 'selector')
            await this.browser.hover(selector)
            return { content: [{ type: 'text' as const, text: `Hovered ${selector}` }] }
          }

          case 'browser_keyboard': {
            const key = requireString(args, 'key')
            const modifiers = optionalStringArray(args, 'modifiers')
            await this.browser.keyboard(key, modifiers)
            return { content: [{ type: 'text' as const, text: `Sent key: ${key}` }] }
          }

          case 'browser_wait_for_load': {
            const timeoutMs = optionalNumber(args, 'timeout_ms', 10000) ?? 10000
            await this.browser.waitForLoad(timeoutMs)
            return { content: [{ type: 'text' as const, text: 'Page finished loading' }] }
          }

          case 'browser_select': {
            const selector = requireString(args, 'selector')
            const value = requireString(args, 'value')
            await this.browser.selectOption(selector, value)
            return { content: [{ type: 'text' as const, text: `Selected "${value}" in ${selector}` }] }
          }

          case 'browser_get_url':
            return { content: [{ type: 'text' as const, text: this.browser.getCurrentUrl() }] }

          case 'browser_click_text': {
            const text = requireString(args, 'text')
            const exact = optionalBoolean(args, 'exact', false)
            const nav = await this.browser.clickText(text, exact)
            return { content: [{ type: 'text' as const, text: `Clicked element with text: ${text}\nURL: ${nav.url}\nTitle: ${nav.title}` }] }
          }

          case 'browser_click_at': {
            const x = requireNumber(args, 'x')
            const y = requireNumber(args, 'y')
            const nav = await this.browser.clickAt(x, y)
            return { content: [{ type: 'text' as const, text: `Clicked at (${x}, ${y})\nURL: ${nav.url}\nTitle: ${nav.title}` }] }
          }

          case 'browser_hover_at': {
            const x = requireNumber(args, 'x')
            const y = requireNumber(args, 'y')
            await this.browser.hoverAt(x, y)
            return { content: [{ type: 'text' as const, text: `Hovered at (${x}, ${y})` }] }
          }

          case 'browser_get_elements': {
            const selector = requireString(args, 'selector')
            const elements = await this.browser.getElements(selector)
            return { content: [{ type: 'text' as const, text: JSON.stringify(elements, null, 2) }] }
          }

          case 'browser_get_links': {
            const textFilter = optionalString(args, 'text_filter')
            const links = await this.browser.getLinks(textFilter)
            return { content: [{ type: 'text' as const, text: JSON.stringify(links, null, 2) }] }
          }

          case 'browser_wait_for_text': {
            const text = requireString(args, 'text')
            const timeoutMs = optionalNumber(args, 'timeout_ms', 5000) ?? 5000
            await this.browser.waitForText(text, timeoutMs)
            return { content: [{ type: 'text' as const, text: `Text found: ${text}` }] }
          }

          case 'browser_set_cookies': {
            const cookies = requireCookies(args, 'cookies')
            await this.browser.setCookies(cookies)
            return { content: [{ type: 'text' as const, text: `Set ${cookies.length} cookie(s)` }] }
          }

          default:
            throw new Error(`Unknown tool: ${name}`)
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        }
      }
    })
  }

  // Start an HTTP server exposing SSE at /sse and message handling at /message.
  // Returns the port the server is actually listening on (OS assigns when port=0).
  async startHttp(port = 0): Promise<number> {
    const transports = new Map<string, SSEServerTransport>()

    const httpServer = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://x')

        if (req.method === 'GET' && url.pathname === '/sse') {
          const server = this._makeServer()
          const transport = new SSEServerTransport('/message', res)
          transports.set(transport.sessionId, transport)
          transport.onclose = () => transports.delete(transport.sessionId)
          await server.connect(transport)
        } else if (req.method === 'POST' && url.pathname === '/message') {
          const sid = url.searchParams.get('sessionId') ?? ''
          const transport = transports.get(sid)
          if (!transport) { res.writeHead(404).end(); return }
          await transport.handlePostMessage(req, res)
        } else if (url.pathname === '/mcp') {
          if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json' }).end(JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Method not allowed.' },
              id: null,
            }))
            return
          }

          const server = this._makeServer()
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
          await server.connect(transport)
          await transport.handleRequest(req, res, await readJsonBody(req))
          res.on('close', () => {
            transport.close().catch(() => {})
            server.close().catch(() => {})
          })
        } else {
          res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Not found.' },
            id: null,
          }))
        }
      } catch (err) {
        console.error('[BrowserMcpServer] HTTP error:', err)
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }))
        }
      }
    })

    return new Promise<number>((resolve, reject) => {
      httpServer.listen(port, '127.0.0.1', () => {
        resolve((httpServer.address() as AddressInfo).port)
      })
      httpServer.on('error', reject)
    })
  }

  // Connect to a stdio transport (for running as a subprocess)
  async connectStdio(): Promise<void> {
    const transport = new StdioServerTransport()
    await this._makeServer().connect(transport)
  }
}

async function readJsonBody(req: import('http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : undefined
}

function formatContentResult(result: BrowserContentResult): string {
  const scoped = Boolean(result.selector)
  const largeUnscoped = !scoped && result.characters > 12000
  if (!scoped && !result.truncated && !largeUnscoped) return result.text

  const metadata = [
    `characters=${result.characters}`,
    `lines=${result.lines}`,
    `truncated=${result.truncated}`,
    ...(result.selector ? [`selector=${JSON.stringify(result.selector)}`] : []),
  ].join(', ')
  const warning = largeUnscoped
    ? '\n\n[warning: browser_get_content without selector returned a large whole-page text dump. Prefer browser_get_elements, browser_get_links, browser_wait_for_text, or browser_get_url when they answer the question.]'
    : ''
  return `${result.text}\n\n[content metadata: ${metadata}]${warning}`
}
