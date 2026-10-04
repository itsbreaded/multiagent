import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { spawnSync } from 'child_process'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const repoRoot = resolve(__dirname, '..')
const electronPath = require('electron') as string
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
    MULTIAGENT_ALLOW_MULTI_INSTANCE: '1',
    MULTIAGENT_E2E_USER_DATA_DIR: userDataDir,
    MULTIAGENT_E2E_AGENT_COMMAND: `node "${join(repoRoot, 'e2e', 'fixtures', 'framed-agent.cjs')}"`,
    MULTIAGENT_E2E_FRAME_INTERVAL_MS: '2',
    MULTIAGENT_E2E_MINIMIZED: '1',
    HOME: homeDir,
    USERPROFILE: homeDir,
  }
}

async function expectE2eWindowsMinimized(app: ElectronApplication, count: number): Promise<void> {
  // Xvfb provides a display but no window manager, so Linux cannot report
  // native minimized state even though the harness still uses showInactive().
  if (process.platform === 'linux') return
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((win) => win.isMinimized()))).toEqual(
    new Array(count).fill(true),
  )
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
  // localStorage is synchronous to the renderer but Chromium may defer its
  // profile write. Flush the Electron session before exercising a relaunch so
  // the next renderer observes the final settings state.
  await target.evaluate(({ session }) => session.defaultSession.flushStorageData()).catch(() => {})
  const processExit = new Promise<void>((resolve) => {
    if (proc?.exitCode !== null || proc?.signalCode !== null) {
      resolve()
      return
    }
    proc?.once('exit', () => resolve())
  })
  const hardKill = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') {
          spawnSync(`taskkill /pid ${proc!.pid} /T /F`, { shell: true, stdio: 'ignore' })
        } else if (proc!.pid) {
          process.kill(-proc!.pid, 'SIGKILL')
        }
      } catch { /* already exited */ }
      resolve()
    }, 5_000)
    timer.unref?.()
  })
  // ElectronApplication.close() can release Playwright's connection before the
  // child process has exited. Do not launch another app against the same profile
  // until the previous process is gone; otherwise Chromium can expose stale
  // localStorage state on the replacement renderer.
  await Promise.race([
    target.close().catch(() => {}).then(() => processExit),
    hardKill,
  ])
}

async function tearOffTab(app: ElectronApplication, page: Page, tabName: string): Promise<Page> {
  const existingWindows = new Set(app.windows())
  await page.getByTitle(tabName, { exact: true }).click({ button: 'right' })
  await page.getByRole('button', { name: 'Move Tab to New Window', exact: true }).click()
  await expect.poll(() => app.windows().some((candidate) => !existingWindows.has(candidate))).toBe(true)
  await expectE2eWindowsMinimized(app, app.windows().length)
  return app.windows().find((candidate) => !existingWindows.has(candidate))!
}

async function dragSidebarTabOutside(page: Page, tabName: string, screenX: number, screenY: number): Promise<void> {
  await page.getByTitle(tabName, { exact: true }).locator('..').evaluate((header, point) => {
    const dataTransfer = new DataTransfer()
    header.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }))
    header.dispatchEvent(new DragEvent('dragend', {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      screenX: point.screenX,
      screenY: point.screenY,
    }))
  }, { screenX, screenY })
}

async function dropSidebarTab(
  page: Page,
  targetTabName: string,
  tab: Record<string, unknown>,
  ptyIds: string[],
  sourceWindowId: number,
): Promise<void> {
  await page.getByTitle(targetTabName, { exact: true }).locator('..').evaluate((header, payload) => {
    const dataTransfer = new DataTransfer()
    dataTransfer.setData('application/x-multiagent-tab', JSON.stringify(payload))
    const eventInit = { bubbles: true, cancelable: true, dataTransfer, clientY: 1 }
    header.dispatchEvent(new DragEvent('dragover', eventInit))
    header.dispatchEvent(new DragEvent('drop', eventInit))
  }, { tab, ptyIds, sourceWindowId })
}

test.describe('cold-start layout restore', () => {
  let app: ElectronApplication
  let page: Page
  let userDataDir: string
  let homeDir: string
  let projectCwd: string
  let repairedProjectCwd: string

  async function launchTestApp(expectedInitialTab = 'Alpha', extraEnv: Record<string, string> = {}): Promise<void> {
    app = await electron.launch({
      executablePath: electronPath,
      args: ['.'],
      cwd: repoRoot,
      env: { ...launchEnv(userDataDir, homeDir), ...extraEnv },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // App layout restoration is asynchronous. Do not let a test create a pane
    // before the saved layout applies, otherwise that late hydration can replace
    // the newly-created pane and conceal the behavior being tested.
    if (expectedInitialTab) {
      await expect(page.getByText(expectedInitialTab, { exact: true }).first()).toBeVisible()
    }
    await expectE2eWindowsMinimized(app, 1)
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

  test('shows an inactive unhydrated agent as disconnected until its tab is activated', async () => {
    await closeApp(app)
    const layoutPath = join(userDataDir, 'layout.json')
    const betaPaneId = 'beta-agent-pane'
    await writeFile(layoutPath, JSON.stringify({
      tabs: [
        { id: 'tab-alpha', focusedPaneId: '', customLabel: 'Alpha' },
        {
          id: 'tab-beta',
          focusedPaneId: betaPaneId,
          customLabel: 'Beta',
          rootNode: {
            type: 'leaf',
            id: betaPaneId,
            paneType: 'agent',
            agentKind: 'claude',
            cwd: projectCwd,
            sessionId: 'fts-session',
          },
        },
      ],
      sidebarWidth: 220,
      sidebarOpen: true,
      activeTabId: 'tab-alpha',
      sidebarSectionOpen: { 'tab:tab-beta': true },
      sidebarPanelSizes: {},
    }), 'utf8')

    await launchTestApp()
    await expect(page.getByTitle('Disconnected')).toBeVisible()
    const beforeActivation = JSON.parse(await readFile(layoutPath, 'utf8')) as { activeTabId: string }
    expect(beforeActivation.activeTabId).toBe('tab-alpha')

    await page.getByText('Beta', { exact: true }).last().click()
    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(layoutPath, 'utf8')) as {
        tabs: Array<{ id: string; rootNode?: { ptyId?: string } }>
      }
      return saved.tabs.find((tab) => tab.id === 'tab-beta')?.rootNode?.ptyId ?? ''
    }).not.toBe('')
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

  test('keeps renderer implementation switches and contrast defaults out of Terminal settings', async () => {
    await page.getByTitle('Settings').click()
    await page.getByText('Terminal', { exact: true }).click()
    await expect(page.getByText('Optimized renderer', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Rescale overlapping glyphs', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Minimum contrast ratio', { exact: true })).toHaveCount(0)

    const search = page.getByPlaceholder('Search settings')
    await search.fill('optimized')
    await expect(page.getByText('Optimized renderer', { exact: true })).toHaveCount(0)
    await search.fill('rescale')
    await expect(page.getByText('Rescale overlapping glyphs', { exact: true })).toHaveCount(0)
    await search.fill('contrast')
    await expect(page.getByText('Minimum contrast ratio', { exact: true })).toHaveCount(0)
  })

  test('persists a provider selection made in Settings through a normal restart', async () => {
    await page.getByTitle('Settings').click()
    await page.getByText('Providers', { exact: true }).click()
    const claudeCard = page.getByText('Claude Code', { exact: true }).locator('..').locator('..')
    await claudeCard.getByText('DeepSeek', { exact: true }).click()
    // Two edits in the same interaction must serialize; the later choice wins.
    await claudeCard.getByText('Alibaba', { exact: true }).click()
    await claudeCard.getByRole('checkbox', { name: 'Enabled' }).uncheck()

    await expect(page.getByText(/Provider settings could not be saved|Retry to keep this change/)).toHaveCount(0)
    await closeApp(app)
    await launchTestApp()
    await page.getByTitle('Settings').click()
    await page.getByText('Providers', { exact: true }).click()
    const restoredCard = page.getByText('Claude Code', { exact: true }).locator('..').locator('..')
    await expect(restoredCard.getByText('Alibaba', { exact: true })).toBeVisible()
    await expect(restoredCard.getByRole('checkbox', { name: 'Enabled' })).not.toBeChecked()
  })

  test('shows an enabled built-in provider selection in the reopened Settings UI', async () => {
    await page.getByTitle('Settings').click()
    await page.getByText('Providers', { exact: true }).click()
    const claudeCard = page.getByText('Claude Code', { exact: true }).locator('..').locator('..')
    await claudeCard.getByText('DeepSeek', { exact: true }).click()
    await expect(claudeCard.getByRole('checkbox', { name: 'Enabled' })).toBeChecked()

    await closeApp(app)
    await launchTestApp()
    await page.getByTitle('Settings').click()
    await page.getByText('Providers', { exact: true }).click()
    const restoredCard = page.getByText('Claude Code', { exact: true }).locator('..').locator('..')
    await expect(restoredCard.getByText('DeepSeek', { exact: true })).toBeVisible()
    await expect(restoredCard.getByRole('checkbox', { name: 'Enabled' })).toBeChecked()
  })

  test('restores a custom provider and its routing draft through the real Settings UI', async () => {
    await page.getByTitle('Settings').click()
    await page.getByText('Providers', { exact: true }).click()
    const claudeCard = page.getByText('Claude Code', { exact: true }).locator('..').locator('..')
    await claudeCard.getByText('+ Add custom', { exact: true }).click()
    const customName = claudeCard.getByPlaceholder('provider name')
    await customName.fill('Fixture provider')
    await customName.press('Enter')
    const baseUrl = claudeCard.getByPlaceholder('https://api.example.com/anthropic')
    await baseUrl.fill('https://fixture.invalid/anthropic')
    await baseUrl.blur()
    await claudeCard.getByPlaceholder('sk-...').fill('fixture-token')
    await claudeCard.getByPlaceholder('sk-...').blur()
    const extraEnv = claudeCard.getByRole('button', { name: 'Extra env vars' })
    await extraEnv.scrollIntoViewIfNeeded()
    await extraEnv.click()
    await claudeCard.getByText('+ Add var', { exact: true }).click()
    await claudeCard.getByPlaceholder('KEY').fill('FIXTURE_ROUTE')
    await claudeCard.getByPlaceholder('value').fill('enabled')
    await claudeCard.getByText('Save', { exact: true }).click()
    await claudeCard.getByRole('checkbox', { name: 'Enabled' }).uncheck()

    await closeApp(app)
    await launchTestApp()
    await page.getByTitle('Settings').click()
    await page.getByText('Providers', { exact: true }).click()
    const restoredCard = page.getByText('Claude Code', { exact: true }).locator('..').locator('..')
    await expect(restoredCard.getByText('Fixture provider', { exact: true })).toBeVisible()
    await expect(restoredCard.getByPlaceholder('https://api.example.com/anthropic')).toHaveValue('https://fixture.invalid/anthropic')
    expect(await restoredCard.getByPlaceholder('sk-...').inputValue()).not.toBe('')
    await expect(restoredCard.getByPlaceholder('sk-...')).toHaveAttribute('type', 'password')
    await expect(restoredCard.getByRole('checkbox', { name: 'Enabled' })).not.toBeChecked()
    const restoredExtraEnv = restoredCard.getByRole('button', { name: 'Extra env vars' })
    await restoredExtraEnv.scrollIntoViewIfNeeded()
    await restoredExtraEnv.click()
    await expect(restoredCard.getByText('FIXTURE_ROUTE', { exact: true })).toBeVisible()
  })

  test('keeps saved preferences when a provider CLI is unavailable and blocks launches', async () => {
    await closeApp(app)
    await launchTestApp()
    await page.getByTitle('Settings').click()
    await page.getByText('Providers', { exact: true }).click()
    const configuredCard = page.getByText('Claude Code', { exact: true }).locator('..').locator('..')
    await configuredCard.getByText('DeepSeek', { exact: true }).click()
    await expect(configuredCard.getByRole('checkbox', { name: 'Enabled' })).toBeChecked()
    await closeApp(app)
    await launchTestApp('Alpha', { MULTIAGENT_E2E_PROVIDER_AVAILABILITY: '{"claude":false,"codex":true,"opencode":true}' })
    await page.getByTitle('Settings').click()
    await page.getByText('Providers', { exact: true }).click()
    const claudeCard = page.getByText('Claude Code', { exact: true }).locator('..').locator('..')
    await expect(claudeCard.getByRole('checkbox', { name: 'Enabled' })).toBeChecked()
    await expect(claudeCard.getByText('CLI not found on PATH — install it to enable this provider.', { exact: true })).toBeVisible()
    await expect(page.evaluate(() => window.ipc.invoke('session:new', 'claude', window.homeDir))).rejects.toThrow('Provider CLI not available on PATH')
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

  test('closing a detached shell tab from its sidebar kills its process', async () => {
    const { ptyId } = await spawnShell(page, userDataDir)
    const ready = await page.evaluate((id) => window.ipc.invoke('pty:get-ready', id), ptyId) as { pid: number }
    const pid = ready.pid
    const detached = await tearOffTab(app, page, 'Alpha')
    await expect(page.getByTitle('Alpha', { exact: true })).toHaveCount(0)

    await detached.getByTitle('Alpha', { exact: true }).click({ button: 'right' })
    await detached.getByText('Close tab', { exact: true }).click().catch(() => {})
    await expect.poll(() => app.evaluate((_electron, childPid) => {
      try { process.kill(childPid, 0); return true } catch { return false }
    }, pid)).toBe(false)
    // The window can close between the isClosed() check and the locator call (it auto-closes
    // once its last tab is removed — App.tsx's `if (tabs.length === 0) window.close()`), so
    // treat a closed-page error the same as isClosed() === true: no window means no Alpha tab.
    const detachedAlphaCount = () => detached.isClosed()
      ? Promise.resolve(0)
      : detached.getByTitle('Alpha', { exact: true }).count().catch(() => 0)
    await expect.poll(detachedAlphaCount).toBe(0)
    await page.waitForTimeout(5_500)
    expect(await detachedAlphaCount()).toBe(0)
  })

  test('closing the detached native window closes its owned tab and kills its process', async () => {
    const { ptyId } = await spawnShell(page, userDataDir)
    const ready = await page.evaluate((id) => window.ipc.invoke('pty:get-ready', id), ptyId) as { pid: number }
    const pid = ready.pid
    const detached = await tearOffTab(app, page, 'Alpha')
    await detached.waitForLoadState('domcontentloaded')
    await expect(detached.getByTitle('Alpha', { exact: true })).toBeVisible()
    await expect(page.getByTitle('Alpha', { exact: true })).toHaveCount(0)

    await detached.evaluate(() => window.ipc.invoke('window:close')).catch(() => {})
    await expect(page.getByTitle('Alpha', { exact: true })).toHaveCount(0)
    await expect.poll(() => app.evaluate((_electron, childPid) => {
      try { process.kill(childPid, 0); return true } catch { return false }
    }, pid)).toBe(false)
    await expect.poll(() => app.windows().length).toBe(1)
  })

  test('opens the command palette from a detached window with the local shortcut', async () => {
    const detached = await tearOffTab(app, page, 'Alpha')
    await detached.waitForLoadState('domcontentloaded')

    // The E2E harness deliberately creates windows without taking desktop focus.
    // Activate this target explicitly because the behavior under test is a
    // keyboard shortcut handled by the detached renderer.
    await detached.bringToFront()
    await detached.keyboard.press('Control+Shift+P')
    await expect(detached.getByRole('textbox')).toBeVisible()
    await detached.keyboard.press('Escape')
    await expect(detached.getByRole('textbox')).toHaveCount(0)
  })

  test('renders and uses the shared local controls in a detached window', async () => {
    const detached = await tearOffTab(app, page, 'Alpha')
    await detached.waitForLoadState('domcontentloaded')

    await expect(detached.getByTitle(/Collapse sidebar/)).toBeVisible()
    await expect(detached.getByTitle(/Session browser/)).toBeVisible()
    await expect(detached.getByTitle(/Command palette/)).toBeVisible()
    await expect(detached.getByTitle('Settings', { exact: true })).toBeVisible()
    await expect(detached.locator('.tab-strip')).toHaveCount(0)

    await detached.getByTitle(/Collapse sidebar/).click()
    await expect(detached.getByTitle(/Open sidebar/)).toBeVisible()
    await expect(detached.getByTitle('Alpha', { exact: true })).toHaveCount(0)
    await detached.getByTitle(/Open sidebar/).click()
    await expect(detached.getByTitle('Alpha', { exact: true })).toBeVisible()
    await detached.keyboard.press('Control+B')
    await expect(detached.getByTitle(/Open sidebar/)).toBeVisible()
    await detached.keyboard.press('Control+B')
    await expect(detached.getByTitle('Alpha', { exact: true })).toBeVisible()

    await detached.getByTitle('Settings', { exact: true }).click()
    await expect(detached.getByRole('dialog', { name: 'Settings' })).toBeVisible()
    await expect(detached.getByPlaceholder('Search settings')).toBeFocused()
    await detached.keyboard.press('Escape')
    await expect(detached.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
    await detached.getByTitle('Settings', { exact: true }).click()
    await expect(detached.getByRole('dialog', { name: 'Settings' })).toBeVisible()
    await detached.keyboard.press('Escape')

    await detached.getByTitle(/Session browser/).click()
    await expect(detached.getByPlaceholder('Search sessions...')).toBeVisible()
    await detached.getByPlaceholder('Search sessions...').press('Escape')
    await expect(detached.getByPlaceholder('Search sessions...')).toHaveCount(0)
    await detached.keyboard.press('Control+Shift+O')
    await expect(detached.getByPlaceholder('Search sessions...')).toBeVisible()
    await detached.keyboard.press('Escape')
    await detached.getByTitle(/Session browser/).click()
    await expect(detached.getByPlaceholder('Search sessions...')).toBeVisible()
    await detached.keyboard.press('Escape')

    await detached.keyboard.press('Control+Shift+P')
    const commandSearch = detached.getByRole('textbox')
    await expect(commandSearch).toBeVisible()
    await commandSearch.fill('Open Settings')
    await detached.keyboard.press('Enter')
    await expect(detached.getByRole('dialog', { name: 'Settings' })).toBeVisible()
    await detached.keyboard.press('Escape')
  })

  test('keeps workspace overlays globally singleton across primary and detached windows', async () => {
    test.setTimeout(90_000)
    const detached = await tearOffTab(app, page, 'Alpha')
    await detached.waitForLoadState('domcontentloaded')

    const only = async (name: 'Settings' | 'Session Browser' | 'Command Palette', owner: Page, other: Page): Promise<void> => {
      await expect(owner.getByRole('dialog', { name, exact: true })).toBeVisible()
      if (owner !== other) await expect(other.getByRole('dialog', { name, exact: true })).toHaveCount(0)
      for (const otherName of ['Settings', 'Session Browser', 'Command Palette'] as const) {
        if (otherName !== name) {
          await expect(owner.getByRole('dialog', { name: otherName, exact: true })).toHaveCount(0)
          if (owner !== other) await expect(other.getByRole('dialog', { name: otherName, exact: true })).toHaveCount(0)
        }
      }
    }

    // Button path from primary, then the same button from detached: the first
    // renderer remains the only mounted owner and receives focus again.
    await page.getByTitle('Settings', { exact: true }).click()
    await only('Settings', page, detached)
    await expect(page.getByPlaceholder('Search settings')).toBeFocused()

    // Commit a real Settings edit, hand ownership to the detached command
    // palette, then reopen Settings in the primary and verify the persisted
    // value survived the unmount/handoff.
    await page.getByText('Terminal', { exact: true }).click()
    const scrollbackRow = page.getByText('Scrollback lines', { exact: true }).locator('..').locator('..')
    const scrollbackInput = scrollbackRow.locator('input')
    await scrollbackInput.fill('500,000')
    await scrollbackInput.blur()
    await expect(scrollbackInput).toHaveValue('500000')
    await detached.getByTitle(/Command palette/).click()
    await only('Command Palette', detached, page)
    await detached.keyboard.press('Escape')
    await page.getByTitle('Settings', { exact: true }).click()
    await only('Settings', page, detached)
    await page.getByText('Terminal', { exact: true }).click()
    await expect(page.getByText('Scrollback lines', { exact: true }).locator('..').locator('..').locator('input')).toHaveValue('500000')

    await detached.getByTitle('Settings', { exact: true }).click()
    await only('Settings', page, detached)
    await expect(page.getByPlaceholder('Search settings')).toBeFocused()

    // Escape releases the owner. The detached button can then claim a new
    // generation, and a primary open request focuses it instead of mounting a copy.
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0)
    await detached.getByTitle('Settings', { exact: true }).click()
    await only('Settings', detached, page)
    await page.getByTitle('Settings', { exact: true }).click()
    await only('Settings', detached, page)
    await expect(detached.getByPlaceholder('Search settings')).toBeFocused()

    // Switching kinds is an exclusive, close-before-mount handoff. Exercise
    // the command-palette shortcut in the primary and the session-browser
    // button/shortcut from the detached window.
    await page.keyboard.press('Control+Shift+P')
    await only('Command Palette', page, detached)
    await expect(page.getByPlaceholder('Search commands…')).toBeFocused()
    await detached.getByTitle(/Session browser/).click()
    await only('Session Browser', detached, page)
    await expect(detached.getByPlaceholder('Search sessions...')).toBeFocused()

    // The current product's Search surface is Session Browser's search field;
    // query ownership follows the same singleton and does not duplicate it.
    await detached.getByPlaceholder('Search sessions...').fill('fixture')
    await page.keyboard.press('Control+Shift+O')
    await only('Session Browser', detached, page)
    await expect(detached.getByPlaceholder('Search sessions...')).toHaveValue('fixture')

    // Native close of the detached owner releases the global record. The
    // primary can immediately claim the next generation without a zombie UI.
    await detached.evaluate(() => window.ipc.invoke('window:close')).catch(() => {})
    await expect.poll(() => app.windows().length).toBe(1)
    await page.getByTitle(/Session browser/).click()
    await only('Session Browser', page, page)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Session Browser', exact: true })).toHaveCount(0)
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
          terminalGpuAcceleration: 'off',
        }))
      })
      await page.reload()
      await page.waitForLoadState('domcontentloaded')
      await page.getByTitle(/Command palette/).click()
      await page.keyboard.type('New Shell Pane')
      await page.keyboard.press('Enter')
      await expect(page.getByRole('status')).toContainText('Terminal host recovery failed', { timeout: 10_000 })
      await expect(page.getByRole('button', { name: 'Restart MultiAgent' })).toBeVisible()
    } finally {
      await closeApp(app)
      await rename(hiddenWorkerPath, workerPath)
    }
  })

  test('recreates a shell PTY after one terminal-host failure', async () => {
    test.setTimeout(60_000)
    await closeApp(app)
    await launchTestApp('Alpha', {
      MULTIAGENT_E2E_KILL_PTY_WORKER_ONCE: '1',
      MULTIAGENT_E2E_KILL_PTY_WORKER_AFTER_MS: '4000',
    })

    const { ptyId: oldPtyId } = await spawnShell(page, userDataDir)
    const oldReady = await page.evaluate((id) => window.ipc.invoke('pty:get-ready', id), oldPtyId)
    expect(oldReady).not.toBeNull()

    const layoutPath = join(userDataDir, 'layout.json')
    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(layoutPath, 'utf8')) as { tabs: SavedTab[] }
      const id = saved.tabs[0]?.rootNode?.ptyId
      return typeof id === 'string' && id.length > 0 && id !== oldPtyId
    }, { timeout: 20_000 }).toBeTruthy()

    const saved = JSON.parse(await readFile(layoutPath, 'utf8')) as { tabs: SavedTab[] }
    const replacementPtyId = saved.tabs[0]?.rootNode?.ptyId
    expect(replacementPtyId).toBeTruthy()
    if (!replacementPtyId) throw new Error('replacement PTY id was not persisted')
    expect(replacementPtyId).not.toBe(oldPtyId)
    await expect.poll(() => page.evaluate((id) => window.ipc.invoke('pty:get-ready', id), replacementPtyId)).not.toBeNull()
    await expect(page.getByRole('button', { name: 'Restart MultiAgent' })).toHaveCount(0)
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

  test('moves a tab and its PTY to a new window from the sidebar', async () => {
    const { ptyId } = await spawnShell(page, userDataDir)
    const detached = await tearOffTab(app, page, 'Alpha')
    await detached.waitForLoadState('domcontentloaded')

    await expect(page.locator('.tab-strip')).toHaveCount(0)
    await expect(detached.locator('.tab-strip')).toHaveCount(0)
    await expect(page.getByTitle('Alpha', { exact: true })).toHaveCount(0)
    await expect(detached.getByTitle('Alpha', { exact: true })).toBeVisible()

    const output = detached.evaluate((id) => new Promise<string>((resolve, reject) => {
      let text = ''
      const timer = window.setTimeout(() => {
        unsubscribe()
        reject(new Error('Timed out waiting for detached PTY output'))
      }, 15_000)
      const unsubscribe = window.ipc.on('pty:data', (receivedId: unknown, chunk: unknown) => {
        if (receivedId !== id || typeof chunk !== 'string') return
        text += chunk
        if (!text.includes('__sidebar_tearoff__')) return
        window.clearTimeout(timer)
        unsubscribe()
        resolve(text)
      })
      window.ipc.send('pty:write', id, 'echo __sidebar_tearoff__\r')
    }), ptyId)
    await expect(output).resolves.toContain('__sidebar_tearoff__')
  })

  test('detaches a sidebar tab at drag-out and preserves its PTY output', async () => {
    const { ptyId } = await spawnShell(page, userDataDir)
    const detachedTab = JSON.parse(await readFile(join(userDataDir, 'layout.json'), 'utf8')) as { tabs: Array<Record<string, unknown>> }
    const alpha = detachedTab.tabs.find((tab) => tab.customLabel === 'Alpha')!
    await dragSidebarTabOutside(page, 'Alpha', 1800, 420)
    await expect.poll(() => app.windows().length).toBe(2)
    const detached = app.windows().find((candidate) => candidate !== page)!
    await detached.waitForLoadState('domcontentloaded')

    await expect(page.getByTitle('Alpha', { exact: true })).toHaveCount(0)
    await expect(detached.getByTitle('Alpha', { exact: true })).toHaveCount(1)
    await expect(detached.locator('.tab-strip')).toHaveCount(0)

    const output = detached.evaluate((id) => new Promise<string>((resolve, reject) => {
      let text = ''
      const timer = window.setTimeout(() => { unsubscribe(); reject(new Error('Timed out waiting for drag-out PTY output')) }, 15_000)
      const unsubscribe = window.ipc.on('pty:data', (receivedId: unknown, chunk: unknown) => {
        if (receivedId !== id || typeof chunk !== 'string') return
        text += chunk
        if (!text.includes('__sidebar_drag_out__')) return
        window.clearTimeout(timer)
        unsubscribe()
        resolve(text)
      })
      window.ipc.send('pty:write', id, 'echo __sidebar_drag_out__\r')
    }), ptyId)
    await expect(output).resolves.toContain('__sidebar_drag_out__')
    expect(alpha.id).toBeTruthy()
  })

  test('transfers a detached sidebar tab back to the primary window without duplicates', async () => {
    const { tab, ptyId } = await spawnShell(page, userDataDir)
    const sourceTab = JSON.parse(await readFile(join(userDataDir, 'layout.json'), 'utf8')) as { tabs: Array<Record<string, unknown>> }
    const alpha = sourceTab.tabs.find((candidate) => candidate.id === tab.id || candidate.customLabel === 'Alpha')!
    const detached = await tearOffTab(app, page, 'Alpha')
    await detached.waitForLoadState('domcontentloaded')
    const sourceWindowId = await detached.evaluate(() => window.ipc.invoke('window:get-id')) as number

    // A destination no-op must time out and roll back without removing the
    // source or appending a duplicate target row.
    await dropSidebarTab(page, 'Beta', { ...alpha, id: 'tab-beta', customLabel: 'Alpha copy' }, [], sourceWindowId)
    await expect(page.getByTitle('Beta', { exact: true })).toHaveCount(1)
    await expect(detached.getByTitle('Alpha', { exact: true })).toHaveCount(1)

    await dropSidebarTab(page, 'Beta', alpha, [ptyId], sourceWindowId)
    await expect(page.getByTitle('Alpha', { exact: true })).toHaveCount(1)
    await expect(page.getByTitle('Beta', { exact: true })).toHaveCount(1)
    await expect.poll(() => detached.isClosed()
      ? 0
      : detached.getByTitle('Alpha', { exact: true }).count().catch(() => 0)
    ).toBe(0)

    const output = page.evaluate((id) => new Promise<string>((resolve, reject) => {
      let text = ''
      const timer = window.setTimeout(() => { unsubscribe(); reject(new Error('Timed out waiting for returned PTY output')) }, 15_000)
      const unsubscribe = window.ipc.on('pty:data', (receivedId: unknown, chunk: unknown) => {
        if (receivedId !== id || typeof chunk !== 'string') return
        text += chunk
        if (!text.includes('__sidebar_return__')) return
        window.clearTimeout(timer)
        unsubscribe()
        resolve(text)
      })
      window.ipc.send('pty:write', id, 'echo __sidebar_return__\r')
    }), ptyId)
    await expect(output).resolves.toContain('__sidebar_return__')
  })

  test('transfers a tab between detached sidebars and keeps ownership rows unique', async () => {
    const source = JSON.parse(await readFile(join(userDataDir, 'layout.json'), 'utf8')) as { tabs: Array<Record<string, unknown>> }
    const alpha = source.tabs.find((tab) => tab.customLabel === 'Alpha')!
    const alphaWindow = await tearOffTab(app, page, 'Alpha')
    await alphaWindow.waitForLoadState('domcontentloaded')
    const betaWindow = await tearOffTab(app, page, 'Beta')
    await betaWindow.waitForLoadState('domcontentloaded')
    const sourceWindowId = await alphaWindow.evaluate(() => window.ipc.invoke('window:get-id')) as number

    await dropSidebarTab(betaWindow, 'Beta', alpha, [], sourceWindowId)
    await expect(betaWindow.getByTitle('Alpha', { exact: true })).toHaveCount(1)
    await expect.poll(() => alphaWindow.isClosed()
      ? 0
      : alphaWindow.getByTitle('Alpha', { exact: true }).count().catch(() => 0)
    ).toBe(0)
    await expect(page.getByTitle('Alpha', { exact: true })).toHaveCount(0)
    await expect(betaWindow.locator('.tab-strip')).toHaveCount(0)
  })

  test('keeps pane drag-and-drop separate from sidebar tab dragging', async () => {
    await spawnShell(page, userDataDir)
    const saved = JSON.parse(await readFile(join(userDataDir, 'layout.json'), 'utf8')) as {
      tabs: Array<{ customLabel?: string; rootNode?: { id?: string; ptyId?: string } }>
    }
    const alpha = saved.tabs.find((tab) => tab.customLabel === 'Alpha')!
    const paneId = alpha.rootNode?.id
    expect(paneId).toBeTruthy()
    await page.locator(`[data-pane-id="${paneId}"]`).first().dragTo(page.getByTitle('Beta', { exact: true }).locator('..'))
    await expect.poll(async () => {
      const layout = JSON.parse(await readFile(join(userDataDir, 'layout.json'), 'utf8')) as {
        tabs: Array<{ customLabel?: string; rootNode?: { ptyId?: string } }>
      }
      return layout.tabs.find((tab) => tab.customLabel === 'Beta')?.rootNode?.ptyId ?? ''
    }).not.toBe('')
  })

  test('returns a detached tab to the primary sidebar', async () => {
    const detached = await tearOffTab(app, page, 'Alpha')
    await detached.waitForLoadState('domcontentloaded')
    await expect(page.getByTitle('Alpha', { exact: true })).toHaveCount(0)

    await detached.getByTitle('Alpha', { exact: true }).click({ button: 'right' })
    await detached.getByText('Bring to Main Window', { exact: true }).click().catch(() => {})

    await expect(page.getByTitle('Alpha', { exact: true })).toBeVisible()
    await expect.poll(() => detached.isClosed()
      ? 0
      : detached.getByTitle('Alpha', { exact: true }).count().catch(() => 0)
    ).toBe(0)
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

  test('opens a complete wrapped URL only on a left click', async () => {
    const url = 'https://example.com/api/v2/resources/a1b2c3d4e5f6/items?filter=status%3Aactive&sort=created_at&order=desc&page=1&per_page=50&fields=id,name,description,tags,metadata'
    await page.evaluate(() => {
      localStorage.setItem('multiagent:settings', JSON.stringify({
        terminalGpuAcceleration: 'off',
      }))
    })
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByText('Alpha', { exact: true }).first()).toBeVisible()
    const { ptyId } = await spawnShell(page, userDataDir)
    await page.evaluate(({ id, value }) => {
      window.ipc.send('pty:write', id, `Write-Output '${value}'\r`)
    }, { id: ptyId, value: url })
    await expect(page.locator('.xterm').first()).toContainText('https://example.com')

    const point = await page.locator('.xterm').first().evaluate((root, target) => {
      const needle = target.slice(0, 12)
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        const text = node.textContent ?? ''
        const index = text.indexOf(needle)
        if (index < 0) continue
        const range = document.createRange()
        range.setStart(node, index + Math.min(6, needle.length - 1))
        range.setEnd(node, index + Math.min(7, needle.length))
        const rect = range.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      }
      return null
    }, url) as { x: number; y: number } | null
    expect(point).toBeTruthy()

    await page.evaluate(() => window.e2ePtyTrace?.reset())
    await page.mouse.move(point!.x, point!.y)
    await page.waitForTimeout(100)
    await page.mouse.click(point!.x, point!.y, { button: 'right' })
    await expect(page.getByRole('button', { name: /Paste/ })).toBeVisible()
    const rightClickTrace = await page.evaluate(() => window.e2ePtyTrace?.snapshot())
    expect(rightClickTrace?.invokes.some((entry) => entry.channel === 'shell:open-external')).toBe(false)

    await page.keyboard.press('Escape')
    await page.evaluate(() => window.e2ePtyTrace?.reset())
    await page.mouse.move(point!.x, point!.y)
    await page.waitForTimeout(100)
    await page.mouse.click(point!.x, point!.y, { button: 'left' })
    await expect.poll(async () => {
      const trace = await page.evaluate(() => window.e2ePtyTrace?.snapshot())
      return trace?.invokes.filter((entry) => entry.channel === 'shell:open-external').length ?? 0
    }).toBe(1)
    const leftClickTrace = await page.evaluate(() => window.e2ePtyTrace?.snapshot())
    expect(leftClickTrace?.invokes.find((entry) => entry.channel === 'shell:open-external')?.args[0]).toBe(url)
  })

  test('suspends and automatically resumes an idle Claude session in a returned tab', async () => {
    test.setTimeout(120_000)
    await page.getByTitle('Settings').click()
    await page.getByText('Terminal', { exact: true }).click()
    const policyRow = page.getByText('Automatically suspend idle agent sessions', { exact: true }).locator('..').locator('..')
    await policyRow.getByRole('checkbox').check()
    const timeout = policyRow.getByRole('textbox', { name: /timeout/i })
    await timeout.fill('1')
    await timeout.blur()
    await expect(timeout).toHaveValue('1')
    await page.keyboard.press('Escape')
    await expect(page.getByText('Automatically suspend idle agent sessions', { exact: true })).toHaveCount(0)

    await page.getByTitle(/Command palette/).click()
    const commandSearch = page.getByPlaceholder('Search commands…')
    await commandSearch.fill('New Claude Session')
    await page.keyboard.press('Enter')

    const layoutPath = join(userDataDir, 'layout.json')
    let originalPtyId = ''
    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(layoutPath, 'utf8')) as { tabs: Array<{ customLabel?: string; rootNode?: { paneType?: string; ptyId?: string } }> }
      const alpha = saved.tabs.find((tab) => tab.customLabel === 'Alpha')
      if (alpha?.rootNode?.paneType !== 'agent') return ''
      originalPtyId = alpha.rootNode.ptyId ?? ''
      return originalPtyId
    }).not.toBe('')

    await page.getByRole('button', { name: 'Beta', exact: true }).click()
    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(layoutPath, 'utf8')) as { tabs: Array<{ customLabel?: string; rootNode?: { ptyId?: string; agentSuspension?: { reason?: string } } }> }
      const alpha = saved.tabs.find((tab) => tab.customLabel === 'Alpha')
      return alpha?.rootNode?.agentSuspension?.reason ?? (alpha?.rootNode?.ptyId ? 'live' : '')
    }, { timeout: 75_000 }).toBe('idle-policy')

    await page.getByRole('button', { name: 'Alpha', exact: true }).click()
    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(layoutPath, 'utf8')) as { tabs: Array<{ customLabel?: string; rootNode?: { ptyId?: string; agentSuspension?: unknown } }> }
      const alpha = saved.tabs.find((tab) => tab.customLabel === 'Alpha')
      return { ptyId: alpha?.rootNode?.ptyId ?? '', suspended: !!alpha?.rootNode?.agentSuspension }
    }, { timeout: 30_000 }).toMatchObject({ suspended: false })
    const resumed = JSON.parse(await readFile(layoutPath, 'utf8')) as { tabs: Array<{ customLabel?: string; rootNode?: { ptyId?: string } }> }
    const resumedPtyId = resumed.tabs.find((tab) => tab.customLabel === 'Alpha')?.rootNode?.ptyId
    expect(resumedPtyId).toBeTruthy()
    expect(resumedPtyId).not.toBe(originalPtyId)
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
    await launchTestApp('')

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

    // Keep this as a repeated-layout check without making every E2E run spend
    // minutes spawning and tearing down a fresh PTY for each iteration.
    for (let i = 0; i < 5; i += 1) {
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
        const renderedPanes = page.locator('[data-pane-id]').filter({ has: page.locator('.xterm') })
        const newPane = renderedPanes.evaluateAll(
          (nodes) => nodes
            .map((node) => node.getAttribute('data-pane-id'))
            .find((id) => id !== 'restored-shell' && id !== 'restored-agent') ?? ''
        )
        const newPaneId = await newPane
        const newPaneLocator = page
          .locator(`[data-pane-id="${newPaneId}"]`)
          .filter({ has: page.locator('.xterm') })
          .last()
        await expect
          .poll(
            async () => {
              const currentTrackedBox = await trackedPane.boundingBox()
              const currentNewBox = await newPaneLocator.boundingBox()
              if (!currentTrackedBox || !currentNewBox) return Number.NEGATIVE_INFINITY
              return currentNewBox.y - (currentTrackedBox.y + currentTrackedBox.height * 0.8)
            },
            { timeout: 5_000 }
          )
          .toBeGreaterThan(0)
        const trackedBox = await trackedPane.boundingBox()
        const newBox = await newPaneLocator.boundingBox()
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
