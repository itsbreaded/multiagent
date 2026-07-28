import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import net from 'node:net'

const repoRoot = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const electronPath = require('electron')
const screenshotsDir = join(repoRoot, 'docs', 'screenshots')
const demoAgentLauncher = join(repoRoot, 'scripts', 'readme-demo-agent.cjs')

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
    server.on('error', reject)
  })
}

function fixtureTranscript(sessionId, cwd, message, timestamp) {
  return `${JSON.stringify({
    type: 'user',
    sessionId,
    cwd,
    gitBranch: 'main',
    timestamp,
    message: { role: 'user', content: message },
  })}\n`
}

function scrubScreenshotText() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  for (const node of nodes) {
    node.nodeValue = node.nodeValue
      .replace(/[A-Z]:\\[^\n\r\t ]+/gi, 'demo-workspace')
      .replace(/~\\AppData\\Local\\Temp\\[^\n\r\t ]+/gi, 'demo-workspace')
      .replace(/\\/g, '/')
  }
}

function leaves(node) {
  if (!node) return []
  return node.type === 'split' ? [...leaves(node.first), ...leaves(node.second)] : [node]
}

async function runCommand(page, title) {
  await page.getByTitle('Command palette (Ctrl+Shift+P)').click()
  const input = page.getByPlaceholder('Search commands…')
  await input.fill(title)
  await page.keyboard.press('Enter')
}

async function renameFocusedPane(page, label) {
  await runCommand(page, 'Rename Pane')
  const input = page.getByPlaceholder('Label (optional)')
  await input.fill(label)
  await page.keyboard.press('Enter')
}

async function splitWith(page, paneLabel, choiceLabel, direction) {
  const pane = page.locator('[data-pane-id]').filter({ hasText: paneLabel })
  await pane.getByTitle('Split pane / new session').click()
  const row = page.getByText(choiceLabel, { exact: true }).locator('xpath=../..')
  await row.getByTitle(direction === 'vertical'
    ? 'Split vertical (right-click to choose directory)'
    : 'Split horizontal (right-click to choose directory)').click()
}

async function validateUiMcp(port) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ui_windows', arguments: {} } }),
  })
  if (!response.ok || !(await response.text()).includes('MultiAgent')) {
    throw new Error('multiagent-ui did not report the isolated application window')
  }
}

let app
let root

try {
  root = await mkdtemp(join(tmpdir(), 'multiagent-readme-screenshots-'))
  const userDataDir = join(root, 'profile')
  const homeDir = join(root, 'home')
  const projectDir = join(root, 'demo-workspace')
  const transcriptDir = join(homeDir, '.claude', 'projects', 'demo-workspace')
  const port = await freePort()

  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(projectDir, { recursive: true }),
    mkdir(transcriptDir, { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(transcriptDir, '11111111-1111-4111-8111-111111111111.jsonl'), fixtureTranscript('11111111-1111-4111-8111-111111111111', projectDir, 'Review the checkout flow and identify the next implementation task.', '2026-07-27T12:00:00.000Z')),
    writeFile(join(transcriptDir, '22222222-2222-4222-8222-222222222222.jsonl'), fixtureTranscript('22222222-2222-4222-8222-222222222222', projectDir, 'Run the storefront test plan before the release review.', '2026-07-27T11:30:00.000Z')),
    writeFile(join(transcriptDir, '33333333-3333-4333-8333-333333333333.jsonl'), fixtureTranscript('33333333-3333-4333-8333-333333333333', projectDir, 'Audit checkout accessibility labels and keyboard navigation.', '2026-07-27T11:00:00.000Z')),
    writeFile(join(transcriptDir, '44444444-4444-4444-8444-444444444444.jsonl'), fixtureTranscript('44444444-4444-4444-8444-444444444444', projectDir, 'Draft concise release notes for the storefront update.', '2026-07-27T10:30:00.000Z')),
    writeFile(join(userDataDir, 'layout.json'), JSON.stringify({
      tabs: [{ id: 'demo-tab', customLabel: 'Storefront', defaultCwd: projectDir, focusedPaneId: '' }],
      sidebarWidth: 250,
      sidebarOpen: true,
      activeTabId: 'demo-tab',
      sidebarSectionOpen: {},
      sidebarPanelSizes: {},
    })),
  ])

  app = await electron.launch({
    executablePath: electronPath,
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...process.env,
      MULTIAGENT_ALLOW_MULTI_INSTANCE: '1',
      MULTIAGENT_E2E_USER_DATA_DIR: userDataDir,
      MULTIAGENT_E2E_AGENT_COMMAND: `node "${demoAgentLauncher}"`,
      MULTIAGENT_UI_AUTOMATION_PORT: String(port),
      HOME: homeDir,
      USERPROFILE: homeDir,
      APPDATA: join(homeDir, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(homeDir, 'AppData', 'Local'),
      CODEX_HOME: join(homeDir, '.codex'),
      XDG_DATA_HOME: join(homeDir, '.local', 'share'),
    },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await validateUiMcp(port)
  await page.evaluate(() => window.ipc.invoke('sessions:refresh'))

  await runCommand(page, 'New Claude Session')
  await renameFocusedPane(page, 'Claude Code')
  await splitWith(page, 'Claude Code', 'Codex CLI', 'vertical')
  await renameFocusedPane(page, 'Codex')
  await splitWith(page, 'Claude Code', 'OpenCode', 'horizontal')
  await renameFocusedPane(page, 'OpenCode')
  await splitWith(page, 'Codex', 'Shell', 'horizontal')
  await renameFocusedPane(page, 'Shell')
  await page.locator('[data-pane-id]').count()
  await page.waitForTimeout(3_000)
  const saved = JSON.parse(await readFile(join(userDataDir, 'layout.json'), 'utf8'))
  const paneInputs = leaves(saved.tabs[0]?.rootNode).flatMap((pane) => {
    if (!pane.ptyId) return []
    if (pane.paneType === 'shell') return [{ ptyId: pane.ptyId, text: "function prompt { 'demo> ' }; cls\r" }]
    // Fresh Codex profiles ask once to trust the disposable project directory.
    // Accept only that isolated prompt so the normal welcome UI can render.
    if (pane.agentKind === 'codex') return [{ ptyId: pane.ptyId, text: '\r' }]
    return [{ ptyId: pane.ptyId, text: '\r' }]
  })
  await page.evaluate((inputs) => {
    for (const input of inputs) window.ipc.send('pty:write', input.ptyId, input.text)
  }, paneInputs)
  const codexPane = leaves(saved.tabs[0]?.rootNode).find((pane) => pane.agentKind === 'codex')
  if (codexPane?.ptyId) {
    await page.waitForTimeout(1_000)
    // Codex follows its disposable-directory prompt with a hook trust screen.
    // Select "Trust all and continue" for these generated, isolated hooks.
    await page.evaluate((ptyId) => window.ipc.send('pty:write', ptyId, '\x1b[B\r'), codexPane.ptyId)
  }
  await page.waitForTimeout(12_000)
  await page.evaluate(scrubScreenshotText)
  await page.screenshot({ path: join(screenshotsDir, 'main-screen.png') })

  await page.getByTitle('Session browser (Ctrl+Shift+O)').click()
  await page.waitForTimeout(250)
  await page.evaluate(scrubScreenshotText)
  await page.screenshot({ path: join(screenshotsDir, 'session-browser-summary.png') })

  await page.getByText('Deep', { exact: true }).click()
  await page.getByPlaceholder('Search sessions...').fill('checkout')
  await page.waitForTimeout(500)
  await page.evaluate(scrubScreenshotText)
  await page.screenshot({ path: join(screenshotsDir, 'session-browser-deep.png') })

  await page.keyboard.press('Escape')
  await page.getByTitle('Command palette (Ctrl+Shift+P)').click()
  await page.getByPlaceholder('Search commands…').fill('session')
  await page.waitForTimeout(100)
  await page.evaluate(scrubScreenshotText)
  await page.screenshot({ path: join(screenshotsDir, 'command-palette.png') })

  await page.keyboard.press('Escape')
  await page.getByTitle('Settings').click()
  await page.getByText('Providers', { exact: true }).click()
  await page.waitForTimeout(100)
  await page.evaluate(scrubScreenshotText)
  await page.screenshot({ path: join(screenshotsDir, 'providers-availability.png') })

  await page.getByText('MCP', { exact: true }).click()
  await page.waitForTimeout(100)
  await page.getByRole('button', { name: /Add server/ }).click()
  await page.waitForTimeout(100)
  await page.evaluate(scrubScreenshotText)
  await page.screenshot({ path: join(screenshotsDir, 'mcp-automation.png') })
} finally {
  if (app) await app.close().catch(() => {})
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
}
