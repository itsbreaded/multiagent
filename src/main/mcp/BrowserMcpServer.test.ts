import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { BrowserViewManager } from '../browser/BrowserViewManager'
import { BrowserMcpServer } from './BrowserMcpServer'

/**
 * The MCP SDK does not validate tool `arguments` against the declared JSON
 * `inputSchema`, so the BrowserMcpServer CallTool handler must validate them
 * itself (via `toolArgs`) and convert any throw into an `isError` result.
 *
 * These tests instantiate the server against a stubbed BrowserViewManager (the
 * server imports BrowserViewManager type-only) and drive it through the SDK's
 * in-memory transport with a real MCP Client — covering the catch->isError
 * conversion for both bad-args and the closed-window guard.
 */
async function withServer(browser: Partial<BrowserViewManager>, fn: (client: Client) => Promise<void>) {
  const server = new BrowserMcpServer(browser as BrowserViewManager)
  // `_makeServer` is private; reach in via cast to wire it through the
  // in-memory transport without spinning up HTTP/stdio.
  const mcpServer = (server as unknown as { _makeServer: () => import('@modelcontextprotocol/sdk/server/index.js').Server })._makeServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([
    client.connect(clientTransport),
    mcpServer.connect(serverTransport),
  ])
  try {
    await fn(client)
  } finally {
    await Promise.all([client.close(), mcpServer.close()])
  }
}

async function callTool(client: Client, name: string, args: Record<string, unknown> | undefined) {
  const result = await client.callTool({ name, arguments: args }, CallToolResultSchema)
  // The SDK types `content` loosely; pull text out of the first text-shaped block.
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? []
  const text = content.find((c) => c.type === 'text')?.text ?? ''
  return {
    isError: Boolean((result as { isError?: boolean }).isError),
    text,
  }
}

describe('BrowserMcpServer — argument validation + closed-window guard', () => {
  it('returns isError for a missing required argument', async () => {
    await withServer({}, async (client) => {
      const result = await callTool(client, 'browser_click_at', { y: 200 })
      expect(result.isError).toBe(true)
      expect(result.text).toMatch(/Error: Invalid arguments: "x" must be a finite number/)
      expect(result.text).toContain('got undefined')
    })
  })

  it('returns isError for a wrong-type argument', async () => {
    await withServer({}, async (client) => {
      const result = await callTool(client, 'browser_click_at', { x: '300', y: 200 })
      expect(result.isError).toBe(true)
      expect(result.text).toMatch(
        /Error: Invalid arguments: "x" must be a finite number \(got string\)/
      )
    })
  })

  it('returns isError with the shared window-not-open message when the manager throws it', async () => {
    const browser: Partial<BrowserViewManager> = {
      click: async () => {
        throw new Error('Browser window not open — call browser_navigate to open it')
      },
    }
    await withServer(browser, async (client) => {
      const result = await callTool(client, 'browser_click', { selector: '#foo' })
      expect(result.isError).toBe(true)
      expect(result.text).toBe('Error: Browser window not open — call browser_navigate to open it')
    })
  })

  it('returns isError when browser_set_cookies gets a non-array', async () => {
    await withServer({}, async (client) => {
      const result = await callTool(client, 'browser_set_cookies', { cookies: {} })
      expect(result.isError).toBe(true)
      expect(result.text).toMatch(
        /Error: Invalid arguments: "cookies" must be an array \(got object\)/
      )
    })
  })

  it('happy path returns a non-error result', async () => {
    const browser: Partial<BrowserViewManager> = {
      getCurrentUrl: () => 'https://example.com/page',
    }
    await withServer(browser, async (client) => {
      const result = await callTool(client, 'browser_get_url', undefined)
      expect(result.isError).toBe(false)
      expect(result.text).toBe('https://example.com/page')
    })
  })
})
