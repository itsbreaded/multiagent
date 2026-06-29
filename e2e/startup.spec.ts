import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
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
    MULTIAGENT_E2E_AGENT_COMMAND: `node -e "console.log('__multiagent_fake_agent__'); setTimeout(() => {}, 30000)"`,
    HOME: homeDir,
    USERPROFILE: homeDir,
  }
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
    await app?.close()
    await rm(userDataDir, { recursive: true, force: true })
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

    await app.close()
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
      }, 5_000)
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
})
