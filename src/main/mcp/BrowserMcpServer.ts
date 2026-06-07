import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { BrowserViewManager } from '../browser/BrowserViewManager'

export class BrowserMcpServer {
  private server: Server

  constructor(private browser: BrowserViewManager) {
    this.server = new Server(
      { name: 'multiagent-browser', version: '1.0.0' },
      { capabilities: { tools: {} } }
    )
    this._registerHandlers()
  }

  private _registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
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
            'Take a screenshot of the current browser view. Returns a base64-encoded PNG.',
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
          description: 'Get the visible text content of the current page',
          inputSchema: { type: 'object' as const, properties: {} },
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
          description: 'Wait for a CSS selector to appear in the page',
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
          description: 'Get the current URL of the browser',
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
          description: 'Return all elements matching a CSS selector with their tag, visible text, value, id, classes, and bounding box (x/y/width/height). Use this to discover selectors, inspect the DOM, or find element coordinates before browser_click_at / browser_hover_at.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              selector: { type: 'string', description: 'CSS selector to query' },
            },
            required: ['selector'],
          },
        },
        {
          name: 'browser_wait_for_text',
          description: 'Wait until the given text appears anywhere on the page (case-insensitive). Useful for confirming a login succeeded, an error message appeared, or an async action completed.',
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

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params
      try {
        switch (name) {
          case 'browser_navigate':
            await this.browser.navigate(args!.url as string)
            return { content: [{ type: 'text' as const, text: `Navigated to ${args!.url}` }] }

          case 'browser_click':
            await this.browser.click(args!.selector as string)
            return { content: [{ type: 'text' as const, text: `Clicked ${args!.selector}` }] }

          case 'browser_type':
            await this.browser.type(args!.selector as string, args!.text as string)
            return { content: [{ type: 'text' as const, text: 'Typed text' }] }

          case 'browser_screenshot': {
            const dataUrl = await this.browser.screenshot()
            const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
            return {
              content: [{ type: 'image' as const, data: base64, mimeType: 'image/png' as const }],
            }
          }

          case 'browser_evaluate': {
            const result = await this.browser.evaluate(args!.js as string)
            return { content: [{ type: 'text' as const, text: result === undefined ? 'undefined' : JSON.stringify(result) }] }
          }

          case 'browser_get_content': {
            const text = await this.browser.getContent()
            return { content: [{ type: 'text' as const, text }] }
          }

          case 'browser_scroll':
            await this.browser.scroll(
              (args!.x ?? 0) as number,
              (args!.y ?? 0) as number
            )
            return { content: [{ type: 'text' as const, text: 'Scrolled' }] }

          case 'browser_wait_for':
            await this.browser.waitFor(
              args!.selector as string,
              (args!.timeout_ms ?? 5000) as number
            )
            return {
              content: [{ type: 'text' as const, text: `Element found: ${args!.selector}` }],
            }

          case 'browser_go_back':
            await this.browser.goBack()
            return { content: [{ type: 'text' as const, text: `Navigated back to ${this.browser.getCurrentUrl()}` }] }

          case 'browser_go_forward':
            await this.browser.goForward()
            return { content: [{ type: 'text' as const, text: `Navigated forward to ${this.browser.getCurrentUrl()}` }] }

          case 'browser_hover':
            await this.browser.hover(args!.selector as string)
            return { content: [{ type: 'text' as const, text: `Hovered ${args!.selector}` }] }

          case 'browser_keyboard':
            await this.browser.keyboard(
              args!.key as string,
              (args!.modifiers ?? []) as string[]
            )
            return { content: [{ type: 'text' as const, text: `Sent key: ${args!.key}` }] }

          case 'browser_wait_for_load':
            await this.browser.waitForLoad((args!.timeout_ms ?? 10000) as number)
            return { content: [{ type: 'text' as const, text: 'Page finished loading' }] }

          case 'browser_select':
            await this.browser.selectOption(args!.selector as string, args!.value as string)
            return { content: [{ type: 'text' as const, text: `Selected "${args!.value}" in ${args!.selector}` }] }

          case 'browser_get_url':
            return { content: [{ type: 'text' as const, text: this.browser.getCurrentUrl() }] }

          case 'browser_click_text':
            await this.browser.clickText(args!.text as string, (args!.exact ?? false) as boolean)
            return { content: [{ type: 'text' as const, text: `Clicked element with text: ${args!.text}` }] }

          case 'browser_click_at':
            await this.browser.clickAt(args!.x as number, args!.y as number)
            return { content: [{ type: 'text' as const, text: `Clicked at (${args!.x}, ${args!.y})` }] }

          case 'browser_hover_at':
            await this.browser.hoverAt(args!.x as number, args!.y as number)
            return { content: [{ type: 'text' as const, text: `Hovered at (${args!.x}, ${args!.y})` }] }

          case 'browser_get_elements': {
            const elements = await this.browser.getElements(args!.selector as string)
            return { content: [{ type: 'text' as const, text: JSON.stringify(elements, null, 2) }] }
          }

          case 'browser_wait_for_text':
            await this.browser.waitForText(args!.text as string, (args!.timeout_ms ?? 5000) as number)
            return { content: [{ type: 'text' as const, text: `Text found: ${args!.text}` }] }

          case 'browser_set_cookies': {
            const cookies = (args!.cookies as Array<{ url: string; name: string; value: string; domain?: string; path?: string; secure?: boolean; http_only?: boolean; expiration_date?: number }>)
              .map(({ http_only, expiration_date, ...rest }) => ({
                ...rest,
                ...(http_only !== undefined ? { httpOnly: http_only } : {}),
                ...(expiration_date !== undefined ? { expirationDate: expiration_date } : {}),
              }))
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
          const transport = new SSEServerTransport('/message', res)
          transports.set(transport.sessionId, transport)
          transport.onclose = () => transports.delete(transport.sessionId)
          await this.server.connect(transport)
        } else if (req.method === 'POST' && url.pathname === '/message') {
          const sid = url.searchParams.get('sessionId') ?? ''
          const transport = transports.get(sid)
          if (!transport) { res.writeHead(404).end(); return }
          await transport.handlePostMessage(req, res)
        } else {
          res.writeHead(404).end()
        }
      } catch (err) {
        console.error('[BrowserMcpServer] HTTP error:', err)
        if (!res.headersSent) res.writeHead(500).end()
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
    await this.server.connect(transport)
  }
}
