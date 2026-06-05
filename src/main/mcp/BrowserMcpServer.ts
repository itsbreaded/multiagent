import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
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
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
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

  // Connect to a stdio transport (for running as a subprocess)
  async connectStdio(): Promise<void> {
    const transport = new StdioServerTransport()
    await this.server.connect(transport)
  }

  // For in-process use: expose the server directly
  getServer(): Server {
    return this.server
  }
}
