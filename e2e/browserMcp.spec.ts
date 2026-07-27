import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createServer } from 'http'
import { readFile } from 'fs/promises'
import { join, resolve } from 'path'

const repoRoot = resolve(__dirname, '..')
const electronPath = require('electron') as string

interface McpToolResult {
  isError: boolean
  text: string
}

async function readMcpPayload<T>(response: Response): Promise<T> {
  const body = await response.text()
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    return JSON.parse(body) as T
  }
  const data = body.split(/\r?\n/).find((line) => line.startsWith('data: '))
  if (!data) throw new Error(`MCP SSE response did not include JSON data: ${body}`)
  return JSON.parse(data.slice('data: '.length)) as T
}

async function callBrowserTool(port: number, name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const payload = await readMcpPayload<{
    error?: { message: string }
    result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> }
  }>(response)
  if (payload.error) throw new Error(payload.error.message)
  const content = payload.result?.content ?? []
  return {
    isError: Boolean(payload.result?.isError),
    text: content.find((item) => item.type === 'text')?.text ?? '',
  }
}

async function listBrowserTools(port: number): Promise<string[]> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  })
  const payload = await readMcpPayload<{ error?: { message: string }; result?: { tools?: Array<{ name: string }> } }>(response)
  if (payload.error) throw new Error(payload.error.message)
  return (payload.result?.tools ?? []).map((tool) => tool.name).sort()
}

async function startFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const html = await readFile(join(repoRoot, 'e2e', 'fixtures', 'browser-async-toggle.html'))
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(html)
  })
  await new Promise<void>((resolveServer, reject) => {
    server.listen(0, '127.0.0.1', resolveServer)
    server.once('error', reject)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveServer) => server.close(() => resolveServer())),
  }
}

async function startObservabilityFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url === '/ok') {
      response.writeHead(204).end()
      return
    }
    if (request.url === '/failed') {
      response.destroy()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><script>
      console.error('observability console error');
      Promise.allSettled([fetch('/ok'), fetch('/failed')]).then(() => { window.observabilityDone = true });
    </script>`)
  })
  await new Promise<void>((resolveServer, reject) => {
    server.listen(0, '127.0.0.1', resolveServer)
    server.once('error', reject)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Observability fixture server did not bind a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveServer) => server.close(() => resolveServer())),
  }
}

async function closeApp(target: ElectronApplication): Promise<void> {
  // A JavaScript prompt/confirm can leave a native macOS sheet alive after its
  // BrowserWindow is destroyed. On macOS the app also keeps running after the
  // last window closes, so Playwright's graceful close can then wait forever.
  // Keep teardown bounded and terminate the launched Electron process if its
  // own shutdown cleanup does not finish promptly.
  let proc: ReturnType<ElectronApplication['process']> | undefined
  try {
    proc = target.process()
  } catch {
    return
  }
  const hardKill = new Promise<void>((resolveKill) => {
    const timer = setTimeout(() => {
      try { proc!.kill('SIGKILL') } catch { /* application already exited */ }
      resolveKill()
    }, 5_000)
    timer.unref?.()
  })
  await Promise.race([
    target.close().catch(() => {}),
    hardKill,
  ])
}

test.describe('browser MCP Electron runtime', () => {
  let app: ElectronApplication

  test.beforeEach(async () => {
    app = await electron.launch({
      executablePath: electronPath,
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...process.env,
        MULTIAGENT_ALLOW_MULTI_INSTANCE: '1',
        MULTIAGENT_E2E_BROWSER_MCP_TRACE: '1',
      },
    })
    // Let the main window finish loading before teardown can close the session index.
    // The app sends its initial session snapshot from this load callback.
    await (await app.firstWindow()).waitForLoadState('load')
  })

  test.afterEach(async () => {
    await closeApp(app)
  })

  test('executeJavaScript supports expressions, statements, synchronous functions, and async functions', async () => {
    const results = await app.evaluate(async ({ BrowserWindow }) => {
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
      try {
        await win.loadURL('data:text/html,<title>browser-mcp-runtime</title>')
        const evaluate = (js: string) => win.webContents.executeJavaScript(
          `(async () => { const v = eval(${JSON.stringify('PLACEHOLDER')}); return typeof v === 'function' ? await v() : v; })()`
            .replace(JSON.stringify('PLACEHOLDER'), JSON.stringify(js)),
          true
        )
        return {
          expression: await evaluate('1 + 1'),
          statements: await evaluate('const n = 2; n * 3'),
          synchronousFunction: await evaluate('() => 7'),
          asyncFunction: await evaluate('async () => await Promise.resolve(9)'),
        }
      } finally {
        win.destroy()
      }
    })

    expect(results).toEqual({ expression: 2, statements: 6, synchronousFunction: 7, asyncFunction: 9 })
  })

  test('drives separate manager click and wait calls through MCP against the async fixture', async () => {
    const page = await app.firstWindow()
    await app.evaluate(() => {
      ;(globalThis as typeof globalThis & { __multiagentBrowserMcpWaitTrace?: unknown[] })
        .__multiagentBrowserMcpWaitTrace = []
    })
    await expect.poll(
      () => page.evaluate(() => window.ipc.invoke('mcp:get-status'))
    ).toMatchObject({ running: true })
    const mcpStatus = await page.evaluate(() => window.ipc.invoke('mcp:get-status')) as { port: number | null; tools: string[] }
    expect(mcpStatus.port).not.toBeNull()
    expect(await listBrowserTools(mcpStatus.port!)).toEqual([...mcpStatus.tools].sort())
    const fixture = await startFixtureServer()
    const trace: Array<{ iteration: number; actionCompletedMs: number; waitCompletedMs: number; result: string }> = []

    try {
      for (let iteration = 0; iteration < 10; iteration += 1) {
        const start = Date.now()
        const navigate = await callBrowserTool(mcpStatus.port!, 'browser_navigate', { url: fixture.url })
        expect(navigate).toMatchObject({ isError: false })
        const click = await callBrowserTool(mcpStatus.port!, 'browser_click', { selector: '#reveal' })
        expect(click).toMatchObject({ isError: false })
        const actionCompletedMs = Date.now() - start
        const wait = await callBrowserTool(mcpStatus.port!, 'browser_wait_for_text', {
          text: 'Reveal complete',
          timeout_ms: 1000,
        })
        trace.push({ iteration, actionCompletedMs, waitCompletedMs: Date.now() - start, result: wait.text })
        expect(wait).toEqual({ isError: false, text: 'Text found: Reveal complete' })
      }
    } finally {
      await fixture.close()
    }

    expect(trace).toHaveLength(10)
    expect(trace.every((entry) => entry.result === 'Text found: Reveal complete')).toBe(true)
    const polls = await app.evaluate(() => (
      (globalThis as typeof globalThis & {
        __multiagentBrowserMcpWaitTrace?: Array<{ text: string; timestamp: number; found: boolean }>
      }).__multiagentBrowserMcpWaitTrace ?? []
    ))
    expect(polls.length).toBeGreaterThanOrEqual(10)
    expect(polls.every((poll) => poll.text === 'Reveal complete' && Number.isFinite(poll.timestamp))).toBe(true)
    expect(polls.filter((poll) => poll.found)).toHaveLength(10)
  })

  test('returns console and completed/failed network metadata through MCP', async () => {
    const page = await app.firstWindow()
    await expect.poll(
      () => page.evaluate(() => window.ipc.invoke('mcp:get-status'))
    ).toMatchObject({ running: true })
    const { port } = await page.evaluate(() => window.ipc.invoke('mcp:get-status')) as { port: number | null }
    expect(port).not.toBeNull()
    const fixture = await startObservabilityFixtureServer()

    try {
      await expect(callBrowserTool(port!, 'browser_navigate', { url: fixture.url })).resolves.toMatchObject({ isError: false })
      await expect(callBrowserTool(port!, 'browser_evaluate', {
        js: 'async () => { while (!window.observabilityDone) await new Promise(resolve => setTimeout(resolve, 10)); return true }',
      })).resolves.toEqual({ isError: false, text: 'true' })

      const consoleEntries = JSON.parse((await callBrowserTool(port!, 'browser_get_console')).text) as {
        entries: Array<{ level: number; message: string; sourceUrl: string; line: number; timestamp: number }>
        truncated: boolean
      }
      expect(consoleEntries.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: 'observability console error', sourceUrl: expect.any(String), line: expect.any(Number), timestamp: expect.any(Number) }),
      ]))
      expect(consoleEntries.entries.map((entry) => entry.timestamp)).toEqual([...consoleEntries.entries.map((entry) => entry.timestamp)].sort((a, b) => a - b))

      const networkEntries = JSON.parse((await callBrowserTool(port!, 'browser_get_network')).text) as {
        entries: Array<{ method: string; url: string; resourceType: string; status: number | null; failure: string | null; timestamp: number; durationMs: number }>
      }
      const completed = networkEntries.entries.find((entry) => entry.url.endsWith('/ok'))
      const failed = networkEntries.entries.find((entry) => entry.url.endsWith('/failed'))
      expect(completed).toMatchObject({ method: 'GET', resourceType: expect.stringMatching(/^(fetch|xhr)$/), status: 204, failure: null })
      expect(failed).toMatchObject({ method: 'GET', resourceType: expect.stringMatching(/^(fetch|xhr)$/), status: null, failure: expect.any(String) })
      for (const entry of [completed, failed]) {
        expect(entry).toEqual(expect.objectContaining({ timestamp: expect.any(Number), durationMs: expect.any(Number) }))
        expect(Object.keys(entry!)).toEqual(['method', 'url', 'resourceType', 'status', 'failure', 'timestamp', 'durationMs'])
      }

    } finally {
      await fixture.close()
    }
  })

  test('documents Electron 42 native dialogs as nonblocking and absent from CDP events', async () => {
    const result = await app.evaluate(async ({ BrowserWindow }, fixturePath) => {
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
      const messages: string[] = []
      try {
        await win.loadFile(fixturePath)
        win.webContents.debugger.attach('1.3')
        win.webContents.debugger.on('message', (_event, method) => messages.push(method))

        const settlesWithin = async (promise: Promise<unknown>, timeoutMs: number): Promise<boolean> => {
          let timer: ReturnType<typeof setTimeout> | undefined
          const result = await Promise.race([
            promise.then(() => true, () => true),
            new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) }),
          ])
          if (timer) clearTimeout(timer)
          return result
        }

        const promptSettled = await settlesWithin(
          win.webContents.executeJavaScript("window.prompt('Native prompt?', 'Guest')", true),
          500
        )
        const confirmSettled = await settlesWithin(
          win.webContents.executeJavaScript("window.confirm('Native confirm?')", true),
          500
        )
        const responsive = await settlesWithin(win.webContents.executeJavaScript('true', true), 500)
        return { promptSettled, confirmSettled, responsive, messages }
      } finally {
        if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
        win.destroy()
      }
    }, join(repoRoot, 'e2e', 'fixtures', 'browser-async-toggle.html'))

    expect(result).toEqual({ promptSettled: true, confirmSettled: true, responsive: true, messages: [] })
  })

})
