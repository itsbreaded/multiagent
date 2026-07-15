import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const repoRoot = resolve(__dirname, '..')
const electronPath = require('electron') as string
const TAB_DRAG_MIME = 'application/x-multiagent-tab'
interface SavedTab {
  id: string
  detached?: boolean
  rootNode?: { ptyId?: string }
}

function launchEnv(userDataDir: string, homeDir: string): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
  return {
    ...inherited,
    GH_UPDATE_TOKEN: '',
    MULTIAGENT_ALLOW_MULTI_INSTANCE: '1',
    MULTIAGENT_E2E_USER_DATA_DIR: userDataDir,
    MULTIAGENT_E2E_AGENT_COMMAND: `node "${join(repoRoot, 'e2e', 'fixtures', 'framed-agent.cjs')}"`,
    MULTIAGENT_E2E_FRAME_INTERVAL_MS: '2',
    HOME: homeDir,
    USERPROFILE: homeDir,
  }
}

interface SavedPaneNode {
  type?: 'leaf' | 'split'
  id?: string
  ptyId?: string
  paneType?: string
  agentKind?: string
  first?: SavedPaneNode
  second?: SavedPaneNode
}

function savedLeaves(node: SavedPaneNode | undefined): SavedPaneNode[] {
  if (!node) return []
  if (node.type === 'split') return [...savedLeaves(node.first), ...savedLeaves(node.second)]
  return [node]
}

function framedSequences(chunks: Array<{ ptyId: string; data: string }>, ptyId: string): number[] {
  const stream = chunks.filter((chunk) => chunk.ptyId === ptyId).map((chunk) => chunk.data).join('')
  return Array.from(stream.matchAll(/\x1b\]777;(?:FRAME|RESIZE):(\d{8})\x07/g), (match) => Number(match[1]))
}

async function spawnShell(page: Page, userDataDir: string): Promise<{ tab: SavedTab; ptyId: string }> {
  await page.getByTitle(/Command palette/).click()
  const commandSearch = page.getByPlaceholder('Search commands…')
  await expect(commandSearch).toBeVisible()
  await commandSearch.fill('New Shell Pane')
  await page.keyboard.press('Enter')

  const layoutPath = join(userDataDir, 'layout.json')
  let tab: SavedTab | undefined
  let ptyId = ''
  await expect.poll(async () => {
    const saved = JSON.parse(await readFile(layoutPath, 'utf8')) as { tabs: SavedTab[] }
    tab = saved.tabs[0]
    ptyId = tab?.rootNode?.ptyId ?? ''
    return ptyId
  }).not.toBe('')
  return { tab: tab!, ptyId }
}

async function closeApp(target: ElectronApplication): Promise<void> {
  // Graceful close can stall on macOS: the main process intentionally does not quit on
  // window-all-closed (darwin) and preventDefaults before-quit until its shutdown cleanup
  // (PTY worker teardown, MCP/agent-report HTTP servers, detached-window state collection)
  // resolves. If any of that hangs on a CI runner, app.close() blocks indefinitely — the
  // test then blows its 30s timeout mid-afterEach, which surfaces as "Worker teardown
  // timeout of 30000ms exceeded". Race graceful close against a hard SIGKILL of the whole
  // Electron process tree so teardown always completes in bounded time.
  let proc: ReturnType<ElectronApplication['process']> | undefined
  try {
    proc = target.process()
  } catch {
    // Application already disposed (the test closed the app itself before afterEach).
    // Like app.close(), this must be an idempotent no-op on an already-closed app.
    return
  }
  const hardKill = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try { proc!.kill('SIGKILL') } catch { /* already exited */ }
      resolve()
    }, 5_000)
    timer.unref?.()
  })
  await Promise.race([
    target.close().catch(() => {}),
    hardKill,
  ])
}

async function tearOffTab(app: ElectronApplication, page: Page, tabName: string): Promise<Page> {
  const tabElement = page.locator('.tab-strip').getByText(tabName, { exact: true }).locator('..')
  const transfer = await page.evaluateHandle(() => new DataTransfer())
  await tabElement.dispatchEvent('mousedown', { button: 0 })
  await tabElement.dispatchEvent('dragstart', { dataTransfer: transfer })
  await tabElement.dispatchEvent('dragend', { dataTransfer: transfer, screenX: -1_000, screenY: -1_000 })
  await expect.poll(() => app.windows().length).toBe(2)
  return app.windows().find((candidate) => candidate !== page)!
}

test.describe('cold-start layout restore', () => {
  let app: ElectronApplication
  let page: Page
  let userDataDir: string
  let homeDir: string
  let projectCwd: string
  let repairedProjectCwd: string

  async function launchTestApp(): Promise<void> {
    app = await electron.launch({
      executablePath: electronPath,
      args: ['.'],
      cwd: repoRoot,
      env: launchEnv(userDataDir, homeDir),
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
  }

  test.beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'multiagent-e2e-'))
    homeDir = join(userDataDir, 'home')
    const transcriptDir = join(homeDir, '.claude', 'projects', 'fixture-project')
    projectCwd = join(homeDir, 'work', 'fixture-project')
    repairedProjectCwd = join(homeDir, 'work', 'fixture-project-moved')
    await mkdir(transcriptDir, { recursive: true })
    await mkdir(projectCwd, { recursive: true })
    await mkdir(repairedProjectCwd, { recursive: true })
    await writeFile(join(transcriptDir, 'fts-session.jsonl'), `${JSON.stringify({
      type: 'user',
      sessionId: 'fts-session',
      cwd: projectCwd,
      gitBranch: 'main',
      timestamp: '2026-06-29T12:00:00.000Z',
      message: { role: 'user', content: 'The quasarneedle appears only in this fixture.' },
    })}\n`, 'utf8')
    // Multi-term fixture for the implicit-AND summary-search assertion (spec 036, item 7).
    await writeFile(join(transcriptDir, 'multi-term-session.jsonl'), `${JSON.stringify({
      type: 'user',
      sessionId: 'multi-term-session',
      cwd: projectCwd,
      gitBranch: 'main',
      timestamp: '2026-06-29T12:00:00.000Z',
      message: { role: 'user', content: 'alpha bravo charlie — contains both tokens.' },
    })}\n`, 'utf8')
    await writeFile(join(transcriptDir, 'alpha-only-session.jsonl'), `${JSON.stringify({
      type: 'user',
      sessionId: 'alpha-only-session',
      cwd: projectCwd,
      gitBranch: 'main',
      timestamp: '2026-06-29T12:00:00.000Z',
      message: { role: 'user', content: 'alpha without the other token.' },
    })}\n`, 'utf8')
    const fixture = {
      tabs: [
        { id: 'tab-alpha', focusedPaneId: '', customLabel: 'Alpha' },
        { id: 'tab-beta', focusedPaneId: '', customLabel: 'Beta' },
      ],
      sidebarWidth: 220,
      sidebarOpen: true,
      activeTabId: 'tab-alpha',
      sidebarSectionOpen: {},
      sidebarPanelSizes: {},
    }
    await writeFile(join(userDataDir, 'layout.json'), JSON.stringify(fixture), 'utf8')

    await launchTestApp()
  })

  test.afterEach(async () => {
    await closeApp(app)
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  })

  test('restores each saved tab exactly once and saves only to the isolated profile', async () => {
    await expect(page.getByText('Alpha').first()).toBeVisible()
    await expect(page.getByText('Beta').first()).toBeVisible()

    const actualUserData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    expect(actualUserData).toBe(userDataDir)

    const layoutPath = join(userDataDir, 'layout.json')
    const initialMtime = (await stat(layoutPath)).mtimeMs
    await expect.poll(async () => (await stat(layoutPath)).mtimeMs).toBeGreaterThan(initialMtime)

    const saved = JSON.parse(await readFile(layoutPath, 'utf8')) as {
      tabs: Array<{ id: string }>
      activeTabId: string
    }
    expect(saved.tabs.map((tab) => tab.id)).toEqual(['tab-alpha', 'tab-beta'])
    expect(new Set(saved.tabs.map((tab) => tab.id)).size).toBe(2)
    expect(saved.activeTabId).toBe('tab-alpha')
  })

  test('loads the Electron-ABI SQLite index and executes a real FTS5 MATCH query', async () => {
    await page.evaluate(() => window.ipc.invoke('sessions:refresh'))
    const matches = await page.evaluate(() => window.ipc.invoke('sessions:search', 'quasarneedle')) as Array<{
      sessionId: string
      firstMessage: string | null
    }>
    const misses = await page.evaluate(() => window.ipc.invoke('sessions:search', 'definitelyabsenttoken')) as unknown[]

    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      sessionId: 'fts-session',
      firstMessage: 'The quasarneedle appears only in this fixture.',
    })
    expect(misses).toEqual([])
  })

  test('keeps valid sessions visible when one transcript is malformed', async () => {
    const transcriptDir = join(homeDir, '.claude', 'projects', 'fixture-project')
    await writeFile(join(transcriptDir, 'malformed.jsonl'), '{this is not valid json\n', 'utf8')
    const sessions = await page.evaluate(() => window.ipc.invoke('sessions:refresh')) as Array<{ sessionId: string }>
    expect(sessions.map((session) => session.sessionId)).toContain('fts-session')
  })

  test('commits comma-formatted scrollback through the real settings UI', async () => {
    await page.getByTitle('Settings').click()
    await page.getByText('Terminal', { exact: true }).click()
    const row = page.getByText('Scrollback lines', { exact: true }).locator('..').locator('..')
    const input = row.locator('input')
    await input.fill('500,000')
    await input.blur()
    await expect(input).toHaveValue('500000')
  })

  test('broadcasts an external session deletion to a detached window', async () => {
    const detached = await tearOffTab(app, page, 'Alpha')
    await detached.waitForLoadState('domcontentloaded')
    const update = detached.evaluate(() => new Promise<Array<{ sessionId: string }>>((resolve) => {
      const unsubscribe = window.ipc.on('sessions:updated', (sessions: unknown) => {
        unsubscribe()
        resolve(sessions as Array<{ sessionId: string }>)
      })
    }))
    await page.evaluate(() => window.ipc.invoke('sessions:delete', 'claude', 'fts-session'))
    const sessions = await update
    expect(sessions.map((session) => session.sessionId)).not.toContain('fts-session')
  })

  test('closing a detached shell tab from the primary sidebar kills its process', async () => {
    const { ptyId } = await spawnShell(page, userDataDir)
    const ready = await page.evaluate((id) => window.ipc.invoke('pty:get-ready', id), ptyId) as { pid: number }
    const pid = ready.pid
    const detached = await tearOffTab(app, page, 'Alpha')
    await expect(page.locator('.tab-strip').getByText('Alpha', { exact: true })).toHaveCount(0)

    await page.getByText('Alpha', { exact: true }).click({ button: 'right' })
    await page.getByText('Close tab', { exact: true }).click()
    await expect.poll(() => app.evaluate((_electron, childPid) => {
      try { process.kill(childPid, 0); return true } catch { return false }
    }, pid)).toBe(false)
    const detachedAlphaCount = () => detached.isClosed()
      ? Promise.resolve(0)
      : detached.locator('.tab-strip').getByText('Alpha', { exact: true }).count()
    await expect.poll(detachedAlphaCount).toBe(0)
    await page.waitForTimeout(5_500)
    expect(await detachedAlphaCount()).toBe(0)
  })

  test('surfaces a missing PTY worker instead of leaving a shell pane hanging', async () => {
    test.setTimeout(60_000)
    await closeApp(app)
    const workerPath = join(repoRoot, 'out', 'main', 'ptyWorker.js')
    const hiddenWorkerPath = `${workerPath}.e2e-hidden`
    await rename(workerPath, hiddenWorkerPath)
    try {
      await launchTestApp()
      await page.evaluate(() => {
        localStorage.setItem('multiagent:settings', JSON.stringify({
          optimizedTerminalRenderer: true,
          terminalGpuAcceleration: 'off',
        }))
      })
      await page.reload()
      await page.waitForLoadState('domcontentloaded')
      await page.getByTitle(/Command palette/).click()
      await page.keyboard.type('New Shell Pane')
      await page.keyboard.press('Enter')
      await expect(page.locator('.xterm-rows')).toContainText('terminal error:', { timeout: 10_000 })
    } finally {
      await closeApp(app)
      await rename(hiddenWorkerPath, workerPath)
    }
  })

  test('moves a closed agent pane back to Recent while a refresh is in flight', async () => {
    const sessionRow = page.getByTitle(projectCwd, { exact: true }).filter({
      hasText: 'The quasarneedle appears only in this fixture.',
    })
    await sessionRow.click()
    await expect(sessionRow).toHaveCount(0)
    const closePane = page.getByTitle(/^Close pane \(/)
    await expect(closePane).toHaveCount(1)

    await page.evaluate(() => { void window.ipc.invoke('sessions:refresh') })
    await closePane.click()
    await expect(page.getByTitle(projectCwd, { exact: true }).filter({
      hasText: 'The quasarneedle appears only in this fixture.',
    })).toHaveCount(1)
  })

  test('summary search never rejects on FTS-adversarial queries (spec 036 item 7)', async () => {
    await page.evaluate(() => window.ipc.invoke('sessions:refresh'))
    // Each of these used to throw SqliteError from the raw FTS5 MATCH expression.
    // After spec 036 (tokenize + quote-escape, LIKE fallback, handler try/catch),
    // every invoke must resolve to an array — never reject.
    const adversarial = [
      'C:\\Code\\multiagent', // FTS5 column filter on a nonexistent column `C`
      '"unbalanced', // unbalanced quote
      'foo AND', // dangling operator
      'foo(', // unbalanced paren
      '-foo', // leading NOT-without-operand
      'NEAR(', // operator + paren
      'a:b:c', // multiple colons
    ]
    for (const q of adversarial) {
      const result = await page.evaluate(
        (query) => window.ipc.invoke('sessions:search', query),
        q
      )
      expect(Array.isArray(result)).toBe(true)
    }
  })

  test('summary search preserves implicit-AND multi-term semantics (spec 036 item 7)', async () => {
    await page.evaluate(() => window.ipc.invoke('sessions:refresh'))
    const both = await page.evaluate(
      (q) => window.ipc.invoke('sessions:search', q),
      'alpha bravo'
    ) as Array<{ sessionId: string }>
    const onlyAlpha = await page.evaluate(
      (q) => window.ipc.invoke('sessions:search', q),
      'alpha'
    ) as Array<{ sessionId: string }>

    const bothIds = new Set(both.map((r) => r.sessionId))
    expect(bothIds.has('multi-term-session')).toBe(true)
    // A row containing only `alpha` must NOT match the AND query.
    expect(bothIds.has('alpha-only-session')).toBe(false)
    // The single-term query is strictly broader.
    expect(onlyAlpha.map((r) => r.sessionId)).toContain('alpha-only-session')
  })

  test('persists cwd overrides when the original transcript is reindexed after restart', async () => {
    await page.evaluate(() => window.ipc.invoke('sessions:refresh'))
    const repair = await page.evaluate(
      ({ oldCwd, newCwd }) => window.ipc.invoke('sessions:repair-cwd', oldCwd, newCwd),
      { oldCwd: projectCwd, newCwd: repairedProjectCwd }
    ) as { ok: boolean; sessions: Array<{ sessionId: string; cwd: string }> }
    expect(repair.ok).toBe(true)
    expect(repair.sessions).toContainEqual(expect.objectContaining({
      sessionId: 'fts-session',
      cwd: repairedProjectCwd,
    }))

    await closeApp(app)
    await launchTestApp()
    await page.evaluate(() => window.ipc.invoke('sessions:refresh'))
    const matches = await page.evaluate(
      () => window.ipc.invoke('sessions:search', 'quasarneedle')
    ) as Array<{ agentKind: string; sessionId: string; cwd: string }>

    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      agentKind: 'claude',
      sessionId: 'fts-session',
      cwd: repairedProjectCwd,
    })
  })

  test('spawns a shell pane and exposes its pty:ready metadata', async () => {
    await page.evaluate(() => {
      localStorage.setItem('multiagent:settings', JSON.stringify({
        optimizedTerminalRenderer: true,
        terminalGpuAcceleration: 'off',
      }))
    })
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    const { ptyId } = await spawnShell(page, userDataDir)

    const ready = await page.evaluate(
      (id) => window.ipc.invoke('pty:get-ready', id),
      ptyId
    ) as { pid: number | null; cwd: string } | undefined
    expect(ready).toMatchObject({ cwd: homeDir })
    expect(typeof ready?.pid).toBe('number')

    const relayed = await page.evaluate((id) => new Promise<{ data: string; seq: number }>((resolve, reject) => {
      let output = ''
      const timer = window.setTimeout(() => {
        unsubscribe()
        reject(new Error('Timed out waiting for direct PTY output'))
      }, 15_000)
      const unsubscribe = window.ipc.on(
        'pty:data',
        (receivedId: unknown, chunk: unknown, seq: unknown) => {
          if (receivedId !== id || typeof chunk !== 'string') return
          output += chunk
          if (!output.includes('__multiagent_direct_output__')) return
          window.clearTimeout(timer)
          unsubscribe()
          resolve({ data: output, seq: typeof seq === 'number' ? seq : -1 })
        }
      )
      window.ipc.send('pty:write', id, 'echo __multiagent_direct_output__\r')
    }), ptyId)
    expect(relayed.data).toContain('__multiagent_direct_output__')
    expect(relayed.seq).toBe(0)
    await expect(page.locator('.xterm-rows')).toContainText('__multiagent_direct_output__')
  })

  test('commits tab:absorb before releasing the source window and reroutes its PTY', async () => {
    const { tab, ptyId } = await spawnShell(page, userDataDir)
    const primaryWindowId = await page.evaluate(() => window.ipc.invoke('window:get-id')) as number
    const tabElement = page.locator('.tab-strip').getByText('Alpha').locator('..')
    const transfer = await page.evaluateHandle(() => new DataTransfer())
    await tabElement.dispatchEvent('mousedown', { button: 0 })
    await tabElement.dispatchEvent('dragstart', { dataTransfer: transfer })
    await tabElement.dispatchEvent('dragend', {
      dataTransfer: transfer,
      screenX: -1_000,
      screenY: -1_000,
    })
    await expect.poll(() => app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
    )).toBe(2)
    const detachedWindowId = await app.evaluate(
      ({ BrowserWindow }, primaryId) =>
        BrowserWindow.getAllWindows().find((candidate) => candidate.id !== primaryId)?.id ?? null,
      primaryWindowId
    )
    expect(typeof detachedWindowId).toBe('number')
    // Real renderer tear-off must remove the tab from the local tab strip before
    // the destination drop. This makes receiveTab application observable rather
    // than letting a pre-existing destination copy mask a no-op regression.
    await expect(page.locator('.tab-strip').getByText('Alpha')).toHaveCount(0)
    await page.waitForTimeout(1_000)
    const sourceInfo = await app.evaluate(
      ({ BrowserWindow }, windowId) => {
        const source = BrowserWindow.getAllWindows().find((candidate) => candidate.id === windowId)
        return source ? { loading: source.webContents.isLoading(), url: source.webContents.getURL() } : null
      },
      detachedWindowId
    )
    expect(sourceInfo).toMatchObject({ loading: false })
    expect(sourceInfo?.url).toContain('index.html')
    // React effects install the release/commit listeners just after load.
    await page.waitForTimeout(250)

    await page.locator('.tab-strip').evaluate(
      (strip, payload) => {
        const transfer = new DataTransfer()
        transfer.setData(payload.mime, JSON.stringify(payload.dragPayload))
        strip.dispatchEvent(new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }))
        strip.dispatchEvent(new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }))
      },
      {
        mime: TAB_DRAG_MIME,
        dragPayload: { tab, ptyIds: [ptyId], sourceWindowId: detachedWindowId },
      }
    )

    await expect(page.locator('.tab-strip').getByText('Alpha')).toHaveCount(1)

    await expect.poll(() => app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
    )).toBe(1)
    const readyAtDestination = await page.evaluate(
      (id) => window.ipc.invoke('pty:get-ready', id),
      ptyId
    ) as { cwd: string } | null
    expect(readyAtDestination).toMatchObject({ cwd: homeDir })

    const layoutPath = join(userDataDir, 'layout.json')
    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(layoutPath, 'utf8')) as { tabs: SavedTab[] }
      return saved.tabs.filter((candidate) => candidate.id === tab.id && !candidate.detached).length
    }).toBe(1)
  })

  test('completes the Claude deferred-spawn size handshake with a deterministic fake agent', async () => {
    await page.getByTitle(/Command palette/).click()
    const commandSearch = page.getByPlaceholder('Search commands…')
    await commandSearch.fill('New Claude Session')
    await page.keyboard.press('Enter')

    const layoutPath = join(userDataDir, 'layout.json')
    let ptyId = ''
    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(layoutPath, 'utf8')) as {
        tabs: Array<{
          rootNode?: { paneType?: string; agentKind?: string; ptyId?: string }
        }>
      }
      const pane = saved.tabs[0]?.rootNode
      if (pane?.paneType !== 'agent' || pane.agentKind !== 'claude') return ''
      ptyId = pane.ptyId ?? ''
      return ptyId
    }).not.toBe('')

    await expect.poll(async () => {
      const metadata = await page.evaluate(
        (id) => window.ipc.invoke('pty:get-ready', id),
        ptyId
      ) as { cwd: string; pid: number | null } | null
      return metadata?.cwd ?? ''
    }).toBe(homeDir)
    const ready = await page.evaluate(
      (id) => window.ipc.invoke('pty:get-ready', id),
      ptyId
    ) as { cwd: string; pid: number | null } | null
    expect(ready).toMatchObject({ cwd: homeDir })
    expect(typeof ready?.pid).toBe('number')
  })

  test('preserves a nested right-column agent across repeated horizontal splits', async () => {
    test.setTimeout(90_000)
    const layoutPath = join(userDataDir, 'layout.json')
    await closeApp(app)
    await writeFile(layoutPath, JSON.stringify({
      tabs: [{
        id: 'tab-restored-nested',
        focusedPaneId: 'restored-agent',
        defaultCwd: projectCwd,
        rootNode: {
          type: 'split',
          id: 'restored-columns',
          direction: 'vertical',
          ratio: 0.5,
          first: {
            type: 'leaf',
            id: 'restored-shell',
            paneType: 'shell',
            cwd: projectCwd,
          },
          second: {
            type: 'leaf',
            id: 'restored-agent',
            paneType: 'agent',
            agentKind: 'claude',
            cwd: projectCwd,
            sessionId: 'fts-session',
          },
        },
      }],
      sidebarWidth: 220,
      sidebarOpen: true,
      activeTabId: 'tab-restored-nested',
      sidebarSectionOpen: {},
      sidebarPanelSizes: {},
    }), 'utf8')
    await launchTestApp()

    const trackedPaneId = 'restored-agent'
    let trackedPtyId = ''
    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(layoutPath, 'utf8')) as { tabs: Array<{ rootNode?: SavedPaneNode }> }
      const pane = savedLeaves(saved.tabs[0]?.rootNode).find(
        (leaf) => leaf.id === trackedPaneId && leaf.paneType === 'agent' && !!leaf.ptyId
      )
      trackedPtyId = pane?.ptyId ?? ''
      return trackedPtyId
    }).not.toBe('')
    await expect(page.locator('.xterm')).toHaveCount(2)

    const before = await page.evaluate(
      (id) => window.ipc.invoke('pty:get-ready', id),
      trackedPtyId
    ) as { pid: number | null } | null
    expect(typeof before?.pid).toBe('number')
    await expect(page.locator(`[data-pane-id="${trackedPaneId}"] .xterm`)).toHaveCount(1)
    await page.evaluate(() => window.e2ePtyTrace?.reset())

    for (let i = 0; i < 100; i += 1) {
      const shellPane = page.locator('[data-pane-id="restored-shell"]').last()
      const trackedPane = page.locator(`[data-pane-id="${trackedPaneId}"]`).last()
      if (i === 0) {
        const shellBox = await shellPane.boundingBox()
        const trackedBox = await trackedPane.boundingBox()
        expect(shellBox).toBeTruthy()
        expect(trackedBox).toBeTruthy()
        expect(trackedBox!.x).toBeGreaterThan(shellBox!.x + shellBox!.width * 0.8)
        expect(Math.abs(trackedBox!.y - shellBox!.y)).toBeLessThan(4)
      }
      await trackedPane.getByTitle('Split pane / new session').click()
      // First menu section is Claude, Codex, Shell; choose Shell's direction
      // button so the stress loop creates no additional agent process.
      await page.getByTitle('Split horizontal').nth(2).click()
      await expect(page.locator('.xterm')).toHaveCount(3)
      if (i === 0) {
        const trackedBox = await trackedPane.boundingBox()
        const newPane = page.locator('[data-pane-id]').filter({ hasNot: page.locator('[data-never-matches]') }).evaluateAll(
          (nodes) => nodes
            .map((node) => node.getAttribute('data-pane-id'))
            .find((id) => id !== 'restored-shell' && id !== 'restored-agent') ?? ''
        )
        const newPaneId = await newPane
        const newBox = await page.locator(`[data-pane-id="${newPaneId}"]`).last().boundingBox()
        expect(trackedBox).toBeTruthy()
        expect(newBox).toBeTruthy()
        expect(Math.abs(newBox!.x - trackedBox!.x)).toBeLessThan(4)
        expect(newBox!.y).toBeGreaterThan(trackedBox!.y + trackedBox!.height * 0.8)
      }
      await page.keyboard.press('Control+Shift+W')
      await expect(page.locator('.xterm')).toHaveCount(2)
    }

    await page.waitForTimeout(250)
    const after = await page.evaluate(
      (id) => window.ipc.invoke('pty:get-ready', id),
      trackedPtyId
    ) as { pid: number | null } | null
    expect(after?.pid).toBe(before?.pid)
    await expect(page.locator(`[data-pane-id="${trackedPaneId}"] .xterm`)).toHaveCount(1)

    const trace = await page.evaluate(() => window.e2ePtyTrace?.snapshot())
    expect(trace).toBeTruthy()
    const preloadFrames = framedSequences(trace!.preloadChunks, trackedPtyId)
    const terminalFrames = framedSequences(trace!.terminalChunks, trackedPtyId)
    expect(preloadFrames.length).toBeGreaterThan(100)
    expect(terminalFrames).toEqual(preloadFrames)

    const writesToOriginal = trace!.sends.filter(
      (entry) => entry.channel === 'pty:write' && entry.args[0] === trackedPtyId
    )
    const nonEmptyWrites = writesToOriginal
      .map((entry) => String(entry.args[1] ?? ''))
      .filter((data) => data.length > 0)
    expect(nonEmptyWrites.every((data) => data === '\x1b[I' || data === '\x1b[O')).toBe(true)
    const originalResizes = trace!.sends.filter(
      (entry) => entry.channel === 'pty:resize' && entry.args[0] === trackedPtyId
    )
    expect(originalResizes.length).toBeGreaterThan(0)
    expect(originalResizes.every((entry) => (
      typeof entry.args[1] === 'number' && entry.args[1] > 0 &&
      typeof entry.args[2] === 'number' && entry.args[2] > 0
    ))).toBe(true)
    expect(trace!.invokes.some((entry) => entry.channel === 'session:resume')).toBe(false)
  })
})
