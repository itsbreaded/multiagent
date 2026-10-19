import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { screenshotUi } from './helpers/screenshotUi'
import { installTestTheme } from './helpers/themeTokens'
import { assertDesktopIsolation } from './helpers/assertDesktopIsolation'

const repoRoot = resolve(__dirname, '..')
const electronPath = require('electron') as string
const jiraSecureStorageKey = randomBytes(32).toString('hex')

type JiraMentionsTextMenuCapture = {
  target: 'editable' | 'selection'
  x: number
  y: number
  items: Array<{ role?: string; type?: string; enabled: boolean }>
}

type JiraMentionsE2EDiagnostics = {
  syntheticClipboardText: string
  jiraMentionsTextMenus: JiraMentionsTextMenuCapture[]
}

function jiraTestLaunchEnv(userDataDir: string, homeDir: string): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    MULTIAGENT_ALLOW_MULTI_INSTANCE: '1',
    MULTIAGENT_E2E_USER_DATA_DIR: userDataDir,
    MULTIAGENT_E2E_JIRA_SECURE_STORAGE_KEY: jiraSecureStorageKey,
    HOME: homeDir,
    USERPROFILE: homeDir,
  }
}

const mentionBody = {
  type: 'doc', version: 1,
  content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'Can you take a look? ' },
    { type: 'mention', attrs: { id: 'self-account', text: '@Self' } },
  ] }],
}
const issueUpdated = new Date(Date.now() - 60_000).toISOString()
const mentionAt = new Date(Date.parse(issueUpdated) - 30_000).toISOString()
const earlierContextAt = new Date(Date.parse(mentionAt) - 30_000).toISOString()
const laterContextAt = issueUpdated

function jiraIssue(updated: string, deliveredReplies: Array<Record<string, unknown>> = [], includeLateMention = false) {
  return {
    id: '100', key: 'APP-1', fields: {
      summary: 'Synthetic issue', updated,
      project: { id: '10', key: 'APP', name: 'Application', projectTypeKey: 'software' },
      comment: {
        startAt: 0, maxResults: 20, total: 5 + deliveredReplies.length + (includeLateMention ? 1 : 0),
        comments: [
          {
            id: 'context-earlier', author: { accountId: 'context-account', displayName: 'Pat' },
            body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Context before the request' }] }] },
            created: earlierContextAt, updated: earlierContextAt,
          },
          {
            id: 'incoming-alice', author: { accountId: 'alice-account', displayName: 'Alex' },
            body: mentionBody, created: mentionAt, updated: mentionAt,
          },
          {
            id: 'context-later', author: { accountId: 'context-account', displayName: 'Pat' },
            body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Context after the request' }] }] },
            created: laterContextAt, updated: laterContextAt,
          },
          {
            id: 'incoming-bob', author: { accountId: 'bob-account', displayName: 'Alex' },
            body: { ...mentionBody, content: [{ type: 'paragraph', content: [
              { type: 'text', text: 'Could you check this? ' },
              { type: 'mention', attrs: { id: 'self-account', text: '@Self' } },
            ] }] },
            created: mentionAt, updated: mentionAt,
            visibility: { identifier: 'group-123', type: 'group', value: 'jira-developers' },
          },
          {
            id: 'incoming-carol', author: { accountId: 'carol-account', displayName: 'Casey' },
            body: { ...mentionBody, content: [{ type: 'paragraph', content: [
              { type: 'text', text: 'Could you also check this? ' },
              { type: 'mention', attrs: { id: 'self-account', text: '@Self' } },
            ] }] },
            created: mentionAt, updated: mentionAt, visibility: null,
          },
          ...(includeLateMention ? [{
            id: 'incoming-dave', author: { accountId: 'dave-account', displayName: 'Drew' },
            body: { ...mentionBody, content: [{ type: 'paragraph', content: [
              { type: 'text', text: 'One more request? ' },
              { type: 'mention', attrs: { id: 'self-account', text: '@Self' } },
            ] }] },
            created: updated, updated, visibility: null,
          }] : []),
        ].concat(deliveredReplies as never[]),
      },
    },
  }
}

async function readRequestBody(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function sendJson(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function closeApp(app: ElectronApplication): Promise<void> {
  let proc: ReturnType<ElectronApplication['process']>
  try { proc = app.process() } catch { return }
  const exited = new Promise<void>((resolveExit) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolveExit()
    proc.once('exit', () => resolveExit())
  })
  let killTimer: ReturnType<typeof setTimeout> | null = null
  await Promise.race([
    app.close().catch(() => {}).then(() => exited),
    new Promise<void>((resolveDelay) => {
      killTimer = setTimeout(resolveDelay, 8000)
      killTimer.unref?.()
    }),
  ])
  if (killTimer) clearTimeout(killTimer)
  if (proc.exitCode === null && proc.signalCode === null && proc.pid) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    }
    else process.kill(-proc.pid, 'SIGKILL')
  }
  if (proc.exitCode === null && proc.signalCode === null) {
    await Promise.race([exited, new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 2_000))])
  }
  if (proc.exitCode === null && proc.signalCode === null) {
    throw new Error(`E2E Electron process ${proc.pid} did not exit after teardown`)
  }
}

async function tearOffTab(app: ElectronApplication, page: Page, tabName: string): Promise<Page> {
  const existingWindows = new Set(app.windows())
  await page.getByTitle(tabName, { exact: true }).click({ button: 'right' })
  await page.getByRole('button', { name: 'Move Tab to New Window', exact: true }).click()
  await expect.poll(() => app.windows().some((candidate) => !existingWindows.has(candidate))).toBe(true)
  const detached = app.windows().find((candidate) => !existingWindows.has(candidate))
  if (!detached) throw new Error('Detached project window did not open')
  return detached
}

test('finds a synthetic unanswered mention and posts one explicit structured reply', async () => {
  test.setTimeout(90_000)
  const receivedReplies: Array<{ body: unknown; visibility?: unknown }> = []
  const deliveredReplies: Array<Record<string, unknown>> = []
  let includeLateMention = false
  let searchRequestCount = 0
  const searchJqls: Array<{ jql: string; accountId: string }> = []
  const issueDetailFieldQueries: string[][] = []
  let holdNextSearchResponse = false
  let resolveSearchResponseHeld: (() => void) | null = null
  const searchResponseHeld = new Promise<void>((resolveHeld) => { resolveSearchResponseHeld = resolveHeld })
  const searchResponseControl: { release?: () => void } = {}
  let currentIssueUpdated = issueUpdated
  let identityAccountId = 'self-account'
  let jiraOffline = false
  let issuePermissionDenied = false
  let offlineGetRequests = 0
  let holdReplyResponse = false
  let loseNextReplyResponse = false
  const replyResponseControl: { release?: () => void } = {}
  let holdNextRefreshSnapshot = false
  let heldRefreshMarker: { updated: string; total: number } | null = null
  let resolveRefreshSnapshotStarted: (() => void) | null = null
  const refreshSnapshotStarted = new Promise<void>((resolveStarted) => { resolveRefreshSnapshotStarted = resolveStarted })
  const refreshSnapshotControl: { release?: () => void } = {}
  let resolveRefreshSnapshotSent: (() => void) | null = null
  const refreshSnapshotSent = new Promise<void>((resolveSent) => { resolveRefreshSnapshotSent = resolveSent })
  let jiraServerPort = 0
  const server: Server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (jiraOffline && request.method === 'GET') {
        offlineGetRequests++
        sendJson(response, 503, { errorMessages: ['Synthetic Jira is offline'] })
        return
      }
      if (issuePermissionDenied && request.method === 'GET' && url.pathname === '/rest/api/3/issue/100') {
        sendJson(response, 403, { errorMessages: ['Synthetic issue access was revoked'] })
        return
      }
      if (request.method === 'GET' && url.pathname === '/rest/api/3/myself') {
        sendJson(response, 200, { accountId: identityAccountId, displayName: 'Self', timeZone: 'UTC' })
      } else if (request.method === 'GET' && url.pathname === '/rest/api/3/field') {
        sendJson(response, 200, [
          { id: 'customfield_10001', name: 'Dev Tester', schema: { type: 'array', items: 'user', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:multiuserpicker' } },
          { id: 'customfield_10002', name: 'Main Dev', schema: { type: 'user', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:userpicker' } },
          { id: 'customfield_10003', name: 'Story Points', schema: { type: 'number', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' } },
        ])
      } else if (request.method === 'POST' && url.pathname === '/rest/api/3/search/jql') {
        searchRequestCount++
        const searchBody = await readRequestBody(request)
        searchJqls.push({ jql: String(searchBody.jql ?? ''), accountId: identityAccountId })
        if (holdNextSearchResponse) {
          holdNextSearchResponse = false
          resolveSearchResponseHeld?.()
          await new Promise<void>((resolveGate) => { searchResponseControl.release = resolveGate })
        }
        sendJson(response, 200, { issues: [jiraIssue(currentIssueUpdated, deliveredReplies, includeLateMention)], isLast: true })
      } else if (request.method === 'GET' && url.pathname === '/rest/api/3/issue/100') {
        if (url.searchParams.get('fields') === 'updated,comment') {
          const marker = heldRefreshMarker
          heldRefreshMarker = null
          sendJson(response, 200, { fields: {
            updated: marker?.updated ?? currentIssueUpdated,
            comment: { total: marker?.total ?? 5 + deliveredReplies.length + (includeLateMention ? 1 : 0) },
          } })
        } else {
          issueDetailFieldQueries.push((url.searchParams.get('fields') ?? '').split(','))
          const issueDetails = { ...jiraIssue(currentIssueUpdated, deliveredReplies, includeLateMention), fields: {
            ...jiraIssue(currentIssueUpdated, deliveredReplies, includeLateMention).fields,
            status: { id: '1', name: 'In Progress', statusCategory: { name: 'In Progress' } },
            issuetype: { name: 'Task' }, priority: { name: 'High' },
            assignee: { accountId: 'alice-account', displayName: 'Alex' },
            reporter: { accountId: 'requester-account', displayName: 'Requester' },
            creator: { accountId: 'creator-account', displayName: 'Creator' },
            customfield_10001: [
              { accountId: 'dev-tester-account', displayName: 'Morgan' },
              { accountId: 'dev-tester-second-account', displayName: 'Casey' },
            ],
            customfield_10002: { accountId: 'main-dev-account', displayName: 'Alex' },
            created: issueUpdated, duedate: null, resolution: null,
            description: { type: 'doc', version: 1, content: [
              { type: 'paragraph', content: [
                { type: 'text', text: 'Synthetic description with ' },
                { type: 'text', text: 'hostile link text', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
              ] },
              ...Array.from({ length: 32 }, (_, index) => ({
                type: 'paragraph', content: [{ type: 'text', text: `Long synthetic detail paragraph ${index + 1} keeps the description taller than its available detail viewport.` }],
              })),
              { type: 'table', content: [
                { type: 'tableRow', content: [
                  { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Message' }] }] },
                  { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Count' }] }] },
                ] },
                { type: 'tableRow', content: [
                  { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Microsoft][ODBC Driver 11 for SQL Server]Query timeout expired' }] }] },
                  { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '5' }] }] },
                ] },
              ] },
            ] },
            attachment: [
              { id: 'attachment-1', filename: 'context.txt', content: `http://127.0.0.1:${jiraServerPort}/rest/api/3/attachment/content/attachment-1`, mimeType: 'text/plain', size: 18,
                author: { accountId: 'requester-account', displayName: 'Requester' }, created: issueUpdated },
              { id: 'attachment-2', filename: 'query-plan.txt', content: `http://127.0.0.1:${jiraServerPort}/rest/api/3/attachment/content/attachment-2`, mimeType: 'text/plain', size: 1_024,
                author: { accountId: 'context-account', displayName: 'Pat' }, created: issueUpdated },
              { id: 'attachment-3', filename: 'run-log.txt', content: `http://127.0.0.1:${jiraServerPort}/rest/api/3/attachment/content/attachment-3`, mimeType: 'text/plain', size: 2_048,
                author: { accountId: 'alice-account', displayName: 'Alex' }, created: earlierContextAt },
            ],
            parent: null, subtasks: [], issuelinks: [],
          } }
          if (holdNextRefreshSnapshot) {
            holdNextRefreshSnapshot = false
            heldRefreshMarker = { updated: currentIssueUpdated, total: 5 + deliveredReplies.length + (includeLateMention ? 1 : 0) }
            const gate = new Promise<void>((resolveGate) => { refreshSnapshotControl.release = resolveGate })
            resolveRefreshSnapshotStarted?.()
            await gate
            sendJson(response, 200, issueDetails)
            resolveRefreshSnapshotSent?.()
          } else sendJson(response, 200, issueDetails)
        }
      } else if (request.method === 'POST' && url.pathname === '/rest/api/3/issue/100/comment') {
        const body = await readRequestBody(request)
        receivedReplies.push(body as { body: unknown; visibility?: unknown })
        if (loseNextReplyResponse) {
          loseNextReplyResponse = false
          currentIssueUpdated = new Date().toISOString()
          const deliveredAt = currentIssueUpdated
          deliveredReplies.push({
            id: `uncertain-reply-${deliveredReplies.length + 1}`,
            author: { accountId: 'self-account', displayName: 'Self' },
            body: body.body,
            created: deliveredAt,
            updated: deliveredAt,
            visibility: body.visibility ?? null,
          })
          response.destroy()
          return
        }
        if (holdReplyResponse) {
          const gate = new Promise<void>((resolveGate) => { replyResponseControl.release = resolveGate })
          await gate
          holdReplyResponse = false
        }
        const confirmedAt = new Date(Date.now() + 1_000).toISOString()
        const confirmedReply = {
          id: `reply-${receivedReplies.length}`,
          author: { accountId: 'self-account', displayName: 'Self' },
          body: body.body,
          created: confirmedAt,
          updated: confirmedAt,
          visibility: body.visibility ?? null,
        }
        currentIssueUpdated = confirmedAt
        deliveredReplies.push(confirmedReply)
        sendJson(response, 201, confirmedReply)
      } else {
        sendJson(response, 404, { errorMessages: ['Synthetic endpoint not found'] })
      }
    } catch {
      sendJson(response, 500, { errorMessages: ['Synthetic fixture failed'] })
    }
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Synthetic Jira server did not bind a TCP port')
  jiraServerPort = address.port
  const userDataDir = await mkdtemp(join(tmpdir(), 'multiagent-jira-mentions-e2e-'))
  const homeDir = join(userDataDir, 'home')
  const evidenceDir = join(repoRoot, 'docs', 'prototypes', 'jira-mentions', 'evidence')
  const uiEvidenceDir = join(repoRoot, 'specs', 'evidence', '082-renderer-ui-style-alignment')
  await mkdir(evidenceDir, { recursive: true })
  await mkdir(uiEvidenceDir, { recursive: true })
  let app: ElectronApplication | null = null

  try {
    await mkdir(homeDir, { recursive: true })
    await writeFile(join(userDataDir, 'layout.json'), JSON.stringify({
      tabs: [{ id: 'tab-alpha', customLabel: 'Alpha' }, { id: 'tab-beta', customLabel: 'Beta' }], sidebarWidth: 220, sidebarOpen: true,
      activeTabId: 'tab-alpha', sidebarSectionOpen: {}, sidebarPanelSizes: {},
    }), 'utf8')
    app = await electron.launch({
      executablePath: electronPath,
      args: ['.'],
      cwd: repoRoot,
      env: jiraTestLaunchEnv(userDataDir, homeDir),
    })
    const page: Page = await app.firstWindow()
    await assertDesktopIsolation(app)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByText('Alpha', { exact: true }).first()).toBeVisible()

    // Exercise a populated project workspace before switching into the feature view.
    await page.getByTitle(/Command palette/).click()
    await screenshotUi(page, join(uiEvidenceDir, 'command-palette-main-windows-1280x800.png'))
    await page.getByPlaceholder('Search commands…').fill('New Shell Pane')
    await page.keyboard.press('Enter')
    const layoutPath = join(userDataDir, 'layout.json')
    let alphaPaneId = ''
    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(layoutPath, 'utf8')) as {
        tabs: Array<{ id: string; rootNode?: { id?: string; ptyId?: string } }>
      }
      const alpha = saved.tabs.find((tab) => tab.id === 'tab-alpha')
      alphaPaneId = alpha?.rootNode?.id ?? ''
      return alpha?.rootNode?.ptyId ?? ''
    }).not.toBe('')
    const projectTerminal = page.locator(`[data-pane-id="${alphaPaneId}"] .xterm`)
    await expect(projectTerminal).toHaveCount(1, { timeout: 30_000 })
    await screenshotUi(page, join(uiEvidenceDir, 'app-chrome-sidebar-pane-main-windows-1280x800.png'))

    await page.getByTitle(/Command palette/).click()
    await page.getByPlaceholder('Search commands…').fill('Split Pane Vertical')
    await page.keyboard.press('Enter')
    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(layoutPath, 'utf8')) as {
        tabs: Array<{ id: string; rootNode?: { type?: string } }>
      }
      return saved.tabs.find((tab) => tab.id === 'tab-alpha')?.rootNode?.type
    }).toBe('split')
    const paneSashes = page.locator('[class*="sash-module_sash"]')
    await expect(paneSashes.first()).toBeVisible()

    await page.keyboard.press('Control+Shift+O')
    await expect(page.getByRole('dialog', { name: 'Session Browser' })).toBeVisible()
    await screenshotUi(page, join(uiEvidenceDir, 'session-browser-main-windows-1280x800.png'))
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Session Browser' })).toBeHidden()

    await page.getByTitle(/Command palette/).click()
    await page.getByPlaceholder('Search commands…').fill('Change Project Directory')
    await page.keyboard.press('Enter')
    const directoryPickerTitle = page.getByText('Change project directory', { exact: true })
    await expect(directoryPickerTitle).toBeVisible()
    const directoryPickerInput = page.getByPlaceholder(/e\.g\. C:\\Users\\you/)
    await expect(directoryPickerInput).toBeFocused()
    await expect(directoryPickerInput).toHaveCSS('color-scheme', 'dark')
    await expect(directoryPickerInput).toHaveCSS('outline-color', 'rgb(74, 222, 128)')
    await screenshotUi(page, join(uiEvidenceDir, 'directory-picker-main-windows-1280x800.png'))
    await page.keyboard.press('Escape')
    await expect(directoryPickerTitle).toBeHidden()

    await page.getByTitle('Settings').click()
    await page.getByText('Providers', { exact: true }).first().click()
    const firstProviderCheckbox = page.locator('input.ui-control-checkbox').first()
    await expect(firstProviderCheckbox).toBeVisible()
    await expect(firstProviderCheckbox).toHaveCSS('accent-color', 'rgb(74, 222, 128)')
    await screenshotUi(page, join(uiEvidenceDir, 'provider-settings-controls-main-windows-1280x800.png'))
    await page.getByText('Jira', { exact: true }).first().click()
    await page.getByRole('textbox', { name: 'Jira base URL' }).fill(`http://127.0.0.1:${address.port}`)
    await page.getByRole('textbox', { name: 'Atlassian account email' }).fill('synthetic@example.test')
    await page.getByLabel('Jira API token').fill('synthetic-token')
    await page.getByRole('checkbox', { name: 'Track unanswered Jira mentions' }).check()
    await page.getByRole('checkbox', { name: 'Background refresh' }).check()
    const pollingInterval = page.getByRole('spinbutton', { name: 'Refresh interval in minutes' })
    await expect(pollingInterval).toHaveCSS('color-scheme', 'dark')
    await pollingInterval.fill('3')
    await expect(pollingInterval).toHaveAttribute('aria-invalid', 'true')
    await expect(pollingInterval).toHaveCSS('border-color', 'rgb(248, 113, 113)')
    await pollingInterval.fill('15')
    await expect(pollingInterval).toHaveAttribute('aria-invalid', 'false')
    await pollingInterval.focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(pollingInterval).toBeFocused()
    await expect(pollingInterval).toHaveCSS('outline-color', 'rgb(74, 222, 128)')
    await expect(page.getByRole('checkbox', { name: 'Background refresh' })).toHaveCSS('accent-color', 'rgb(74, 222, 128)')
    const jiraUrl = page.getByRole('textbox', { name: 'Jira base URL' })
    await jiraUrl.focus()
    await page.keyboard.press('Tab')
    const jiraEmail = page.getByRole('textbox', { name: 'Atlassian account email' })
    await expect(jiraEmail).toBeFocused()
    await expect(jiraEmail).toHaveCSS('outline-style', 'solid')
    await expect(jiraEmail).toHaveCSS('outline-color', 'rgb(74, 222, 128)')
    await screenshotUi(page, join(uiEvidenceDir, 'jira-settings-controls-main-windows-1280x800.png'))
    await page.keyboard.press('Escape')

    await expect.poll(async () => page.evaluate(async () => {
      const settings = await window.ipc.invoke('jira:get-settings')
      const projection = await window.ipc.invoke('jira-mentions:get-state')
      return { mentionsEnabled: settings.mentionsEnabled, hasToken: settings.hasToken, serviceEnabled: projection.enabled }
    })).toEqual({ mentionsEnabled: true, hasToken: true, serviceEnabled: true })

    const chromeLauncher = page.getByTitle(/Open Jira mentions/)
    await expect(chromeLauncher).toBeVisible({ timeout: 30_000 })
    await chromeLauncher.click()
    // The feature view leaves the already hydrated project terminal mounted.
    await expect(projectTerminal).toHaveCount(1)
    await expect(paneSashes.first()).toBeHidden()
    await expect.poll(async () => page.evaluate(async () => (await window.ipc.invoke('jira-mentions:get-state')).status), { timeout: 30_000 }).toBe('ready')
    await expect(page.getByRole('button', { name: /Jira mentions, 3 unanswered/ })).toBeVisible()
    await expect(page.getByText('Can you take a look?', { exact: false })).toBeVisible()
    await expect(page.getByText('Could you check this?', { exact: false })).toBeVisible()
    await expect(page.getByText('Could you also check this?', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: /Alex.*Can you take a look/ }).click()
    await expect(page.getByRole('heading', { name: 'Synthetic issue' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: /Reply to selected mention/ })).toBeVisible()
    const mentionsSearch = page.getByRole('textbox', { name: 'Search Jira mentions' })
    const mentionsFilter = page.getByRole('combobox', { name: 'Jira mentions filter' })
    await expect(mentionsSearch).toHaveCSS('color-scheme', 'dark')
    await mentionsSearch.focus()
    await page.keyboard.press('Tab')
    await expect(mentionsFilter).toBeFocused()
    await expect(mentionsFilter).toHaveCSS('outline-color', 'rgb(74, 222, 128)')
    await expect(mentionsFilter).toHaveCSS('color-scheme', 'dark')
    const newerComments = page.getByRole('region', { name: 'Newer comments' })
    const earlierComments = page.getByRole('region', { name: 'Earlier comments' })
    const commentHistory = page.getByRole('region', { name: 'Comment history' })
    const replyComposer = page.getByRole('region', { name: 'Reply composer' })
    const replyInput = replyComposer.getByRole('textbox', { name: /Reply to selected mention/ })
    await expect(replyInput).toHaveCSS('color-scheme', 'dark')
    await app.evaluate((_electron, clipboardText) => {
      const diagnostics = (globalThis as typeof globalThis & {
        __multiagentE2EDiagnostics?: JiraMentionsE2EDiagnostics
      }).__multiagentE2EDiagnostics
      if (!diagnostics) throw new Error('E2E diagnostics were not initialized')
      diagnostics.syntheticClipboardText = clipboardText
      diagnostics.jiraMentionsTextMenus.length = 0
    }, 'Synthetic clipboard text')
    await replyInput.fill('Draft text')
    await replyInput.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(0, 5))
    const editableContextMenuPrevented = await replyInput.evaluate((element) => {
      const event = new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, view: window, clientX: 31, clientY: 47,
      })
      element.dispatchEvent(event)
      return event.defaultPrevented
    })
    expect(editableContextMenuPrevented).toBe(true)
    const readTextMenus = () => app!.evaluate(() => (
      (globalThis as typeof globalThis & { __multiagentE2EDiagnostics?: JiraMentionsE2EDiagnostics })
        .__multiagentE2EDiagnostics?.jiraMentionsTextMenus ?? []
    ))
    await expect.poll(async () => (await readTextMenus()).length).toBe(1)
    const editableTextMenu = (await readTextMenus())[0]
    expect(editableTextMenu).toMatchObject({ target: 'editable', x: 31, y: 47 })
    expect(editableTextMenu.items.map((item) => item.role?.toLowerCase() ?? item.type)).toEqual([
      'cut', 'copy', 'paste', 'separator', 'selectall',
    ])
    expect(editableTextMenu.items.filter((item) => item.role).every((item) => item.enabled)).toBe(true)
    await expect.poll(async () => replyInput.evaluate((element) => ({
      start: (element as HTMLTextAreaElement).selectionStart,
      end: (element as HTMLTextAreaElement).selectionEnd,
    }))).toEqual({ start: 0, end: 5 })
    expect(await replyInput.inputValue()).toBe('Draft text')
    await replyInput.press('End')
    await replyInput.pressSequentially('!')
    await expect(replyInput).toHaveValue('Draft text!')

    const readOnlyComment = page.getByText('Context before the request', { exact: true })
    await readOnlyComment.evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
    const selectedContextMenuPrevented = await readOnlyComment.evaluate((element) => {
      const event = new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, view: window, clientX: 55, clientY: 72,
      })
      element.dispatchEvent(event)
      return event.defaultPrevented
    })
    expect(selectedContextMenuPrevented).toBe(true)
    await expect.poll(async () => (await readTextMenus()).length).toBe(2)
    const readOnlyTextMenu = (await readTextMenus())[1]
    expect(readOnlyTextMenu).toMatchObject({ target: 'selection', x: 55, y: 72 })
    expect(readOnlyTextMenu.items.map((item) => item.role ?? item.type)).toEqual(['copy'])
    expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('Context before the request')
    await replyInput.fill('')
    await app.evaluate((_electron) => {
      const diagnostics = (globalThis as typeof globalThis & {
        __multiagentE2EDiagnostics?: JiraMentionsE2EDiagnostics
      }).__multiagentE2EDiagnostics
      if (diagnostics) diagnostics.syntheticClipboardText = ''
    })
    await expect(replyComposer.getByText('Reply')).toBeVisible()
    await expect(replyComposer.locator('.jira-mentions-reply-issue')).toHaveCount(0)
    await expect(replyComposer.getByText('Reply in the issue comment thread', { exact: true })).toHaveCount(0)
    await expect(replyComposer.locator('.jira-mentions-reply-feedback')).toHaveCount(0)
    expect(await replyComposer.locator('.jira-mentions-reply-footer').evaluate((element) => getComputedStyle(element).justifyContent)).toBe('flex-end')
    await expect(newerComments).toBeVisible()
    await expect(earlierComments).toBeVisible()
    await expect(page.getByText('Context after the request')).toBeVisible()
    await expect(page.getByText('Context before the request')).toBeVisible()
    const devTesterProperty = page.locator('[data-property="person"][aria-label^="Dev Tester "]')
    await expect(devTesterProperty).toHaveCount(1)
    await expect(devTesterProperty).toContainText('Morgan')
    await expect(devTesterProperty).toContainText('Casey')
    await expect(page.getByLabel('Main Dev Alex')).toBeVisible()
    expect(issueDetailFieldQueries.at(-1)).toContain('customfield_10001')
    expect(issueDetailFieldQueries.at(-1)).toContain('customfield_10002')
    expect(issueDetailFieldQueries.at(-1)).not.toContain('customfield_10003')
    const inboxSelection = page.locator('.jira-mentions-mention-row[data-selected="true"]')
    await expect(inboxSelection).toBeVisible()
    await expect(inboxSelection.locator('.jira-mentions-mention-tag')).toHaveCount(0)
    await expect(inboxSelection.locator('.jira-mentions-mention-row-head strong')).toHaveText('Alex')
    expect(await inboxSelection.evaluate((element) => getComputedStyle(element).borderLeftWidth)).toBe('2px')
    const selectionBackground = await inboxSelection.evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(selectionBackground).not.toBe('rgba(0, 0, 0, 0)')
    const selectionGreen = await inboxSelection.evaluate((element) => {
      const context = document.createElement('canvas').getContext('2d')!
      context.fillStyle = getComputedStyle(element).backgroundColor
      context.fillRect(0, 0, 1, 1)
      return context.getImageData(0, 0, 1, 1).data[1]
    })
    expect(selectionGreen).toBeLessThan(58)
    expect(await page.locator('.jira-mentions-issue-header').evaluate((element) => getComputedStyle(element).borderBottomWidth)).toBe('1px')
    expect(await page.locator('.jira-mentions-details-rail').evaluate((element) => getComputedStyle(element).borderLeftWidth)).toBe('1px')
    expect(await replyComposer.evaluate((element) => getComputedStyle(element).borderWidth)).toBe('1px')
    const replyGreen = await replyComposer.evaluate((element) => {
      const context = document.createElement('canvas').getContext('2d')!
      context.fillStyle = getComputedStyle(element).backgroundColor
      context.fillRect(0, 0, 1, 1)
      return context.getImageData(0, 0, 1, 1).data[1]
    })
    expect(replyGreen).toBeLessThan(45)
    const replySurface = await replyComposer.evaluate((element) => getComputedStyle(element).backgroundColor)
    const selectedCommentSurface = page.getByRole('region', { name: 'Selected mention' })
    const mentionSurface = await selectedCommentSurface.evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(mentionSurface).toBe(replySurface)
    const mentionSurfaceChannels = await selectedCommentSurface.evaluate((element) => {
      const context = document.createElement('canvas').getContext('2d')!
      context.fillStyle = getComputedStyle(element).backgroundColor
      context.fillRect(0, 0, 1, 1)
      return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3)
    })
    expect(mentionSurfaceChannels[1]).toBeLessThan(45)
    expect(mentionSurfaceChannels[1]! - mentionSurfaceChannels[0]!).toBeLessThan(10)
    await expect(page.getByRole('region', { name: 'Selected mention' }).locator('.jira-mentions-source-tag')).toHaveText('Mention')
    const expectFontAbove = async (selector: string, threshold: number) => {
      const element = page.locator(selector).first()
      await expect(element).toBeVisible()
      const fontSize = Number.parseFloat(await element.evaluate((node) => getComputedStyle(node).fontSize))
      expect(fontSize, `${selector} computed font size`).toBeGreaterThan(threshold)
    }
    await expectFontAbove('.jira-mentions-details-kicker', 11.3)
    await expectFontAbove('.jira-mentions-property-row dt', 11.3)
    await expectFontAbove('.jira-mentions-property-row dd [data-property]', 12.3)
    await expectFontAbove('.jira-mentions-avatar', 10.3)
    await expectFontAbove('.jira-mentions-description-section summary', 12.3)
    await expectFontAbove('.jira-mentions-description-copy', 12.3)
    await expectFontAbove('.jira-mentions-comments-heading h2', 13.3)
    await expectFontAbove('.jira-mentions-comment-group-heading', 12.3)
    await expectFontAbove('.jira-mentions-comment-head strong', 12.3)
    await expectFontAbove('.jira-mentions-comment-head time', 11.3)
    await expectFontAbove('.jira-mentions-comment-body', 12.3)
    await expectFontAbove('.jira-mentions-source-tag', 10.3)
    await expectFontAbove('.jira-mentions-source-actions button', 10.3)
    await expectFontAbove('.jira-mentions-reply-heading label', 13.3)
    await expectFontAbove('.jira-mentions-reply-input-wrap textarea', 12.3)
    await expectFontAbove('.jira-mentions-reply-footer', 10.3)
    expect(await page.locator('.jira-mentions-inbox-title-row strong').evaluate((element) => getComputedStyle(element).fontSize)).toBe('13px')
    const snoozeAction = page.getByRole('button', { name: 'Snooze' })
    const dismissAction = page.getByRole('button', { name: 'Dismiss' })
    const actionColor = async (button: typeof snoozeAction) => button.evaluate((element) => {
      const context = document.createElement('canvas').getContext('2d')!
      context.fillStyle = getComputedStyle(element).color
      context.fillRect(0, 0, 1, 1)
      return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3)
    })
    const snoozeColor = await actionColor(snoozeAction)
    const dismissColor = await actionColor(dismissAction)
    expect(snoozeColor[0]).toBeGreaterThan(180)
    expect(snoozeColor[1]).toBeGreaterThan(120)
    expect(snoozeColor[2]).toBeLessThan(100)
    expect(dismissColor[0]).toBeGreaterThan(160)
    expect(dismissColor[1]).toBeLessThan(130)
    expect(dismissColor[2]).toBeLessThan(130)
    expect(snoozeColor).not.toEqual(dismissColor)
    expect(await commentHistory.locator('.jira-mentions-comment-context').evaluateAll((elements) => elements.every((element) => (element as HTMLElement).style.overflowY === 'visible'))).toBe(true)
    expect(await page.evaluate(() => {
      const reply = document.querySelector('[aria-label="Reply composer"]')
      const history = document.querySelector('[aria-label="Comment history"]')
      return Boolean(reply && history && (reply.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING))
    })).toBe(true)
    await expect(replyComposer).toBeVisible()
    expect((await page.locator('.jira-mentions-inbox').boundingBox())?.width).toBe(280)
    const desktopDescriptionWidth = (await page.locator('.jira-mentions-description-copy').boundingBox())?.width
    const desktopReplyWidth = (await replyComposer.boundingBox())?.width
    expect(desktopDescriptionWidth).toBeGreaterThan(0)
    expect(desktopDescriptionWidth).toBeCloseTo(desktopReplyWidth ?? -100, 0)
    await screenshotUi(page, join(uiEvidenceDir, 'mentions-controls-desktop-1280x800.png'))

    const alternateRootColors = await page.evaluate(() => {
      const app = document.querySelector('#root > div') as HTMLElement | null
      const newProjectButton = document.querySelector('button[title="New Project Folder"]') as HTMLElement | null
      const sidebar = newProjectButton?.parentElement?.parentElement
      const mentions = document.querySelector('.jira-mentions-root') as HTMLElement | null
      const terminal = document.querySelector('.xterm') as HTMLElement | null
      if (!app || !sidebar || !mentions || !terminal) throw new Error('Expected themed UI surfaces were not mounted')
      return {
        app: getComputedStyle(app).backgroundColor,
        sidebar: getComputedStyle(sidebar).backgroundColor,
        mentions: getComputedStyle(mentions).backgroundColor,
        terminal: getComputedStyle(terminal).backgroundColor,
      }
    })
    await installTestTheme(page, { color: { appBg: '#112233', panel: '#223344', accent: '#ff00aa' } })
    await expect.poll(() => page.evaluate(() => {
      const app = document.querySelector('#root > div') as HTMLElement | null
      const newProjectButton = document.querySelector('button[title="New Project Folder"]') as HTMLElement | null
      const sidebar = newProjectButton?.parentElement?.parentElement
      const mentions = document.querySelector('.jira-mentions-root') as HTMLElement | null
      const terminal = document.querySelector('.xterm') as HTMLElement | null
      return {
        app: app && getComputedStyle(app).backgroundColor,
        sidebar: sidebar && getComputedStyle(sidebar).backgroundColor,
        mentions: mentions && getComputedStyle(mentions).backgroundColor,
        terminal: terminal && getComputedStyle(terminal).backgroundColor,
      }
    })).toEqual({ app: 'rgb(17, 34, 51)', sidebar: 'rgb(34, 51, 68)', mentions: 'rgb(17, 34, 51)', terminal: 'rgb(17, 34, 51)' })
    expect(alternateRootColors).toEqual({ app: 'rgb(14, 16, 17)', sidebar: 'rgb(26, 27, 30)', mentions: 'rgb(14, 16, 17)', terminal: 'rgb(14, 16, 17)' })
    await installTestTheme(page)
    await screenshotUi(page, join(evidenceDir, 'jira-mentions-layout-desktop-1280x800.png'))
    const desktopFeatureBox = await page.locator('.jira-mentions-root').boundingBox()
    expect(desktopFeatureBox).not.toBeNull()
    await screenshotUi(page, join(evidenceDir, 'jira-mentions-feature-desktop-1060x757.png'), desktopFeatureBox!)
    await page.getByRole('region', { name: 'Selected mention' }).scrollIntoViewIfNeeded()
    await screenshotUi(page, join(evidenceDir, 'jira-mentions-comments-desktop-1280x800.png'))
    await page.locator('.jira-mentions-detail').evaluate((element) => element.scrollTo(0, 0))
    await screenshotUi(page, join(evidenceDir, 'jira-mentions-populated.png'))
    const attachmentSummary = page.getByLabel('Attachments').locator('summary')
    await attachmentSummary.click()
    expect(await page.locator('.jira-mentions-attachment-metadata').first().evaluate((element) => getComputedStyle(element).fontSize)).toBe('10px')
    expect(await page.locator('.jira-mentions-attachment-date').first().evaluate((element) => getComputedStyle(element).fontSize)).toBe('10px')
    await attachmentSummary.scrollIntoViewIfNeeded()
    await screenshotUi(page, join(evidenceDir, 'jira-mentions-attachments-desktop-1280x800.png'))
    await attachmentSummary.click()

    await page.setViewportSize({ width: 700, height: 900 })
    expect(await page.locator('.jira-mentions-root').evaluate((element) => getComputedStyle(element).flexDirection)).toBe('column')
    expect(await page.locator('.jira-mentions-details-rail').evaluate((element) => getComputedStyle(element).borderLeftWidth)).toBe('0px')
    expect(await page.locator('.jira-mentions-properties').evaluate((element) => getComputedStyle(element).display)).toBe('contents')
    const narrowReadingOverflow = await page.locator([
      '.jira-mentions-property-row dd',
      '.jira-mentions-description-copy',
      '.jira-mentions-comment-body',
      '.jira-mentions-reply-input-wrap textarea',
    ].join(',')).evaluateAll((elements) => elements.some((element) => {
      const node = element as HTMLElement
      return node.scrollWidth > node.clientWidth + 1
    }))
    expect(narrowReadingOverflow).toBe(false)
    const narrowDescriptionWidth = (await page.locator('.jira-mentions-description-copy').boundingBox())?.width
    const narrowReplyWidth = (await replyComposer.boundingBox())?.width
    expect(narrowDescriptionWidth).toBeGreaterThan(0)
    expect(narrowDescriptionWidth).toBeCloseTo(narrowReplyWidth ?? -100, 0)
    await screenshotUi(page, join(evidenceDir, 'jira-mentions-layout-narrow-700x900.png'))
    await screenshotUi(page, join(uiEvidenceDir, 'mentions-controls-narrow-700x900.png'))
    const narrowFeatureBox = await page.locator('.jira-mentions-root').boundingBox()
    expect(narrowFeatureBox).not.toBeNull()
    await screenshotUi(page, join(evidenceDir, 'jira-mentions-feature-narrow-480x857.png'), narrowFeatureBox!)
    await attachmentSummary.scrollIntoViewIfNeeded()
    await attachmentSummary.click()
    const narrowAttachmentCards = page.getByRole('group', { name: 'Attachment previews' }).locator('.jira-mentions-attachment-card')
    const narrowAttachmentLayout = await narrowAttachmentCards.evaluateAll((elements) => {
      const scroller = elements[0]?.parentElement as HTMLElement | null
      if (!scroller) return { tops: [], clientWidth: 0, scrollWidth: 0, lastTileReachable: false }
      scroller.scrollLeft = scroller.scrollWidth
      const scrollerBounds = scroller.getBoundingClientRect()
      const lastTileBounds = elements[elements.length - 1]!.getBoundingClientRect()
      return {
        tops: elements.map((element) => element.getBoundingClientRect().top),
        clientWidth: scroller.clientWidth,
        scrollWidth: scroller.scrollWidth,
        lastTileReachable: lastTileBounds.left >= scrollerBounds.left - 1 && lastTileBounds.right <= scrollerBounds.right + 1,
      }
    })
    expect(new Set(narrowAttachmentLayout.tops).size).toBe(1)
    expect(narrowAttachmentLayout.scrollWidth).toBeGreaterThan(narrowAttachmentLayout.clientWidth)
    expect(narrowAttachmentLayout.lastTileReachable).toBe(true)
    await narrowAttachmentCards.last().scrollIntoViewIfNeeded()
    await screenshotUi(page, join(evidenceDir, 'jira-mentions-attachments-narrow-700x900.png'))
    await attachmentSummary.click()
    await page.setViewportSize({ width: 480, height: 857 })
    await page.locator('.jira-mentions-detail').evaluate((element) => element.scrollTo(0, 0))
    const longContentOriginals = await page.evaluate(() => {
      const property = document.querySelector('.jira-mentions-property-row dd [data-property="person"]') as HTMLElement | null
      const comment = document.querySelector('[aria-label="Selected mention"] .jira-mentions-comment-body p') as HTMLElement | null
      if (!property || !comment) throw new Error('Expected a custom person property and selected comment body')
      const originals = { property: property.textContent ?? '', comment: comment.textContent ?? '' }
      property.textContent = 'LongUserPropertyWithoutSpaces'.repeat(12)
      comment.textContent = 'LongCommentTokenWithoutSpaces'.repeat(20)
      return {
        originals,
        propertyWidth: property.parentElement!.clientWidth,
        propertyScrollWidth: property.parentElement!.scrollWidth,
        commentWidth: comment.parentElement!.clientWidth,
        commentScrollWidth: comment.parentElement!.scrollWidth,
        rootWidth: document.querySelector('.jira-mentions-root')!.clientWidth,
        rootScrollWidth: document.querySelector('.jira-mentions-root')!.scrollWidth,
        actionBounds: Array.from(document.querySelectorAll('[aria-label="Selected mention"] .jira-mentions-source-actions button')).map((button) => {
          const rect = button.getBoundingClientRect()
          return { left: rect.left, right: rect.right }
        }),
      }
    })
    expect(longContentOriginals.propertyScrollWidth).toBeLessThanOrEqual(longContentOriginals.propertyWidth + 1)
    expect(longContentOriginals.commentScrollWidth).toBeLessThanOrEqual(longContentOriginals.commentWidth + 1)
    expect(longContentOriginals.rootScrollWidth).toBeLessThanOrEqual(longContentOriginals.rootWidth + 1)
    expect(longContentOriginals.actionBounds.length).toBe(2)
    expect(longContentOriginals.actionBounds.every((bounds) => bounds.left >= 0 && bounds.right <= 480)).toBe(true)
    await screenshotUi(page, join(evidenceDir, 'jira-mentions-long-content-narrow-480x857.png'))
    await page.evaluate((originals) => {
      document.querySelector('.jira-mentions-property-row dd [data-property="person"]')!.textContent = originals.property
      document.querySelector('[aria-label="Selected mention"] .jira-mentions-comment-body p')!.textContent = originals.comment
    }, longContentOriginals.originals)
    await page.setViewportSize({ width: 1280, height: 800 })

    const commentResizeTargets = [
      { label: 'Resize newer comments', handle: page.getByRole('separator', { name: 'Resize newer comments' }), content: newerComments.locator('.jira-mentions-comment-context') },
      { label: 'Resize earlier comments', handle: page.getByRole('separator', { name: 'Resize earlier comments' }), content: earlierComments.locator('.jira-mentions-comment-context') },
    ]
    const naturalCommentHeights = await Promise.all(commentResizeTargets.map(({ content }) => content.evaluate((element) => element.getBoundingClientRect().height)))
    for (const [index, target] of commentResizeTargets.entries()) {
      await target.handle.scrollIntoViewIfNeeded()
      const handleBox = await target.handle.boundingBox()
      expect(handleBox).not.toBeNull()
      await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2)
      await page.mouse.down()
      await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2 + 32, { steps: 3 })
      await page.mouse.up()
      await expect.poll(() => target.content.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(naturalCommentHeights[index]!)
      for (const [otherIndex, other] of commentResizeTargets.entries()) {
        if (otherIndex === index) continue
        expect(await other.content.evaluate((element) => element.getBoundingClientRect().height)).toBeCloseTo(naturalCommentHeights[otherIndex]!, 0)
      }
      await target.handle.focus()
      await page.keyboard.press('Home')
      await expect.poll(() => target.content.evaluate((element) => (element as HTMLElement).style.height)).toBe('auto')
    }
    await page.locator('.jira-mentions-detail').evaluate((element) => element.scrollTo(0, 0))

    issuePermissionDenied = true
    currentIssueUpdated = new Date().toISOString()
    const revoked = await page.evaluate(() => window.ipc.invoke('jira-mentions:refresh', 'manual'))
    expect(revoked).toMatchObject({ status: 'error', errorCode: 'permission', activeCount: 0 })
    await expect(page.getByRole('status')).toContainText('Jira denied access to some issues.')
    await screenshotUi(page, join(evidenceDir, 'jira-mentions-access-error.png'))
    expect(await page.evaluate(() => window.ipc.invoke('jira-mentions:get-issue-detail', '100'))).toBeNull()
    issuePermissionDenied = false
    currentIssueUpdated = new Date().toISOString()
    await page.evaluate(() => window.ipc.invoke('jira-mentions:clear-cache'))
    await expect.poll(async () => page.evaluate(async () => {
      const state = await window.ipc.invoke('jira-mentions:get-state')
      return { status: state.status, activeCount: state.activeCount }
    }), { timeout: 30_000 }).toEqual({ status: 'ready', activeCount: 3 })

    await page.getByRole('button', { name: /Alex.*Could you check this/ }).click()
    const uncertainEditor = page.getByRole('textbox', { name: /Reply to selected mention/ })
    await uncertainEditor.fill('I will check @')
    const bobCandidates = page.getByRole('option', { name: /Alex.*comment author/i })
    await expect(bobCandidates).toHaveCount(2)
    await expect(bobCandidates.nth(0)).toContainText('Could you check this?')
    await expect(bobCandidates.nth(1)).toContainText('Can you take a look?')
    await page.keyboard.press('Enter')
    await page.keyboard.type(' today.')
    await expect(uncertainEditor).toHaveValue('I will check @Alex today.')
    loseNextReplyResponse = true
    await page.getByRole('button', { name: 'Reply' }).click()
    await expect(page.locator('span[role="status"]')).toHaveText('Delivery is uncertain. Refresh Jira mentions before trying again.')
    await expect(uncertainEditor).toHaveValue('I will check @Alex today.')
    const disabledReplyButton = page.getByRole('button', { name: 'Reply' })
    await expect(disabledReplyButton).toBeDisabled()
    await expect(disabledReplyButton).toHaveCSS('opacity', '0.55')
    expect(receivedReplies).toHaveLength(1)
    expect(receivedReplies[0].body).toMatchObject({
      content: [{ content: [
        { text: 'I will check ' },
        { attrs: { id: 'bob-account', text: '@Alex' }, type: 'mention' },
        { text: ' today.' },
      ] }],
    })
    expect(receivedReplies[0].visibility).toEqual({
      type: 'group', value: 'jira-developers', identifier: 'group-123',
    })
    await page.waitForTimeout(1_000)
    expect(receivedReplies).toHaveLength(1)

    await page.getByRole('button', { name: 'Refresh Jira mentions' }).click()
    await expect.poll(async () => page.evaluate(async () => {
      const state = await window.ipc.invoke('jira-mentions:get-state')
      return { status: state.status, activeCount: state.activeCount, errorCode: state.errorCode }
    })).toMatchObject({ status: 'ready', activeCount: 2 })
    await expect(page.locator('span[role="status"]')).toHaveText('This request was answered after you opened it. Refresh the inbox.')
    await expect(page.getByRole('button', { name: 'Reply' })).toBeDisabled()
    await expect(page.getByRole('button', { name: /Jira mentions, 2 unanswered/ })).toBeVisible()
    await expect(uncertainEditor).toHaveValue('I will check @Alex today.')
    expect(receivedReplies).toHaveLength(1)

    await page.getByRole('button', { name: /Alex.*Can you take a look/ }).click()
    await expect(page.getByRole('heading', { name: 'Synthetic issue' })).toBeVisible()
    await expect(page.getByLabel('Status In Progress')).toHaveText('In Progress')
    await expect(page.getByLabel('Type Task')).toHaveText('Task')
    await expect(page.getByLabel('Priority High')).toHaveText('High')
    await expect(page.getByLabel('Assignee Alex')).toBeVisible()
    await expect(page.getByLabel('Reporter Requester')).toBeVisible()
    await expect(page.getByLabel('Status In Progress')).toHaveAttribute('data-category', 'in-progress')
    expect(await page.getByLabel('Status In Progress').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(27, 43, 64)')
    expect(await page.getByLabel('Type Task').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(37, 40, 43)')
    expect(await page.getByLabel('Priority High').evaluate((element) => getComputedStyle(element).color)).toBe('rgb(229, 200, 140)')
    const description = page.getByRole('region', { name: 'Description' })
    const descriptionContent = description.locator('.dark-scrollbar')
    expect(await description.evaluate((element) => (element as HTMLElement).style.borderRadius)).toBe('')
    expect(await description.evaluate((element) => ({
      left: getComputedStyle(element).borderLeftWidth,
      right: getComputedStyle(element).borderRightWidth,
    }))).toEqual({ left: '0px', right: '0px' })
    expect(await descriptionContent.evaluate((element) => (element as HTMLElement).style.height)).toBe('auto')
    const descriptionLimit = await descriptionContent.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      scrollHeight: element.scrollHeight,
      maxHeight: Math.min(360, (element.closest('main')!.clientHeight
        - Number.parseFloat(getComputedStyle(element.closest('main')!).paddingTop)
        - Number.parseFloat(getComputedStyle(element.closest('main')!).paddingBottom)) * 0.35),
    }))
    expect(descriptionLimit.scrollHeight).toBeGreaterThan(descriptionLimit.maxHeight)
    expect(descriptionLimit.height).toBeLessThanOrEqual(descriptionLimit.maxHeight + 1)
    await expect(page.getByRole('textbox', { name: /Reply to selected mention/ })).toBeInViewport()
    await screenshotUi(page, join(evidenceDir, 'jira-mentions-long-description.png'))

    const resizeHandle = page.getByRole('separator', { name: 'Resize description' })
    const resizeBox = await resizeHandle.boundingBox()
    expect(resizeBox).not.toBeNull()
    const descriptionWidth = await descriptionContent.evaluate((element) => element.getBoundingClientRect().width)
    const startingHeight = await descriptionContent.evaluate((element) => element.getBoundingClientRect().height)
    await page.mouse.move(resizeBox!.x + resizeBox!.width / 2, resizeBox!.y + resizeBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(resizeBox!.x + resizeBox!.width / 2, resizeBox!.y + resizeBox!.height / 2 - 25, { steps: 5 })
    await page.mouse.up()
    const resizedHeight = await descriptionContent.evaluate((element) => element.getBoundingClientRect().height)
    expect(resizedHeight).toBeLessThan(startingHeight - 10)
    expect(await descriptionContent.evaluate((element) => element.getBoundingClientRect().width)).toBe(descriptionWidth)

    const resizedBox = await resizeHandle.boundingBox()
    expect(resizedBox).not.toBeNull()
    await page.mouse.move(resizedBox!.x + resizedBox!.width / 2, resizedBox!.y + resizedBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(resizedBox!.x + resizedBox!.width / 2, resizedBox!.y + resizedBox!.height / 2 + 50, { steps: 5 })
    await page.mouse.up()
    expect(await descriptionContent.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(descriptionLimit.maxHeight + 1)
    expect(await descriptionContent.evaluate((element) => (element as HTMLElement).style.maxHeight)).toBe('none')
    expect(await descriptionContent.evaluate((element) => element.getBoundingClientRect().width)).toBe(descriptionWidth)

    const selectedMention = page.getByRole('region', { name: 'Selected mention' })
    await selectedMention.scrollIntoViewIfNeeded()
    await expect(selectedMention.getByText('Can you take a look?', { exact: false })).toBeVisible()
    expect(await selectedMention.evaluate((element) => getComputedStyle(element).overflow)).toBe('visible')
    const selectedBody = selectedMention.locator('.jira-mentions-comment-context-body')
    await expect(page.getByRole('separator', { name: 'Resize selected mention' })).toHaveCount(0)
    expect(await selectedBody.evaluate((element) => (element as HTMLElement).style.height)).toBe('')
    expect(await selectedBody.evaluate((element) => getComputedStyle(element).overflowY)).toBe('visible')
    await expect(selectedBody).not.toHaveClass(/dark-scrollbar/)
    await expect(selectedMention.getByRole('button', { name: 'Snooze' })).toBeVisible()

    const newerBody = newerComments.locator('.jira-mentions-comment-context')
    const newerResize = page.getByRole('separator', { name: 'Resize newer comments' })
    await newerResize.scrollIntoViewIfNeeded()
    const newerHeight = await newerBody.evaluate((element) => element.getBoundingClientRect().height)
    const newerWidth = await newerBody.evaluate((element) => element.getBoundingClientRect().width)
    const newerHandleBox = await newerResize.boundingBox()
    expect(newerHandleBox).not.toBeNull()
    await page.mouse.move(newerHandleBox!.x + newerHandleBox!.width / 2, newerHandleBox!.y + newerHandleBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(newerHandleBox!.x + newerHandleBox!.width / 2, newerHandleBox!.y + newerHandleBox!.height / 2 - 30, { steps: 4 })
    await page.mouse.up()
    expect(await newerBody.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(newerHeight - 10)
    expect(await newerBody.evaluate((element) => element.getBoundingClientRect().width)).toBe(newerWidth)
    expect(await newerBody.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto')

    const earlierBody = earlierComments.locator('.jira-mentions-comment-context')
    const earlierResize = page.getByRole('separator', { name: 'Resize earlier comments' })
    await earlierResize.scrollIntoViewIfNeeded()
    const earlierHeight = await earlierBody.evaluate((element) => element.getBoundingClientRect().height)
    const earlierHandleBox = await earlierResize.boundingBox()
    expect(earlierHandleBox).not.toBeNull()
    await page.mouse.move(earlierHandleBox!.x + earlierHandleBox!.width / 2, earlierHandleBox!.y + earlierHandleBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(earlierHandleBox!.x + earlierHandleBox!.width / 2, earlierHandleBox!.y + earlierHandleBox!.height / 2 + 25, { steps: 4 })
    await page.mouse.up()
    expect(await earlierBody.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(earlierHeight)
    await expect(selectedMention.getByRole('button', { name: 'Dismiss' })).toBeVisible()

    const descriptionDisclosure = description.locator('details')
    const descriptionSummary = description.locator('summary')
    await descriptionSummary.focus()
    await page.keyboard.press('Enter')
    await expect(descriptionDisclosure).not.toHaveAttribute('open')
    await page.keyboard.press('Enter')
    await expect(descriptionDisclosure).toHaveAttribute('open', '')

    await expect(page.getByText('Synthetic description with hostile link text')).toBeVisible()
    await expect(page.getByRole('link', { name: 'hostile link text' })).toHaveCount(0)
    const issueTable = page.getByRole('table')
    await expect(issueTable.getByRole('columnheader', { name: 'Message' })).toBeVisible()
    await expect(issueTable.getByRole('cell', { name: /ODBC Driver 11/ })).toBeVisible()
    const headerColumnWidth = await issueTable.locator('th').first().evaluate((cell) => cell.getBoundingClientRect().width)
    const bodyColumnWidth = await issueTable.locator('td').first().evaluate((cell) => cell.getBoundingClientRect().width)
    expect(Math.abs(headerColumnWidth - bodyColumnWidth)).toBeLessThan(1)
    await page.getByLabel('Attachments').locator('summary').click()
    const attachmentPreviews = page.getByRole('group', { name: 'Attachment previews' })
    const attachmentCards = attachmentPreviews.locator('.jira-mentions-attachment-card')
    await expect(attachmentCards).toHaveCount(3)
    const attachmentDateLayout = await attachmentCards.locator('.jira-mentions-attachment-date').evaluateAll((elements) => elements.map((element) => {
      const date = element as HTMLElement
      const card = date.closest('.jira-mentions-attachment-card') as HTMLElement
      return {
        text: date.textContent,
        whiteSpace: getComputedStyle(date).whiteSpace,
        dateBottom: date.getBoundingClientRect().bottom,
        cardBottom: card.getBoundingClientRect().bottom,
      }
    }))
    expect(attachmentDateLayout).toHaveLength(3)
    expect(attachmentDateLayout.every((date) => date.text?.trim() && date.whiteSpace === 'normal' && date.dateBottom <= date.cardBottom)).toBe(true)
    const attachmentLayout = await attachmentCards.evaluateAll((elements) => {
      const scroller = elements[0]?.parentElement as HTMLElement | null
      if (!scroller) return { tops: [], clientWidth: 0, scrollWidth: 0, lastTileReachable: false }
      scroller.scrollLeft = scroller.scrollWidth
      const scrollerBounds = scroller.getBoundingClientRect()
      const lastTileBounds = elements[elements.length - 1]!.getBoundingClientRect()
      return {
        tops: elements.map((element) => element.getBoundingClientRect().top),
        clientWidth: scroller.clientWidth,
        scrollWidth: scroller.scrollWidth,
        lastTileReachable: lastTileBounds.left >= scrollerBounds.left - 1 && lastTileBounds.right <= scrollerBounds.right + 1,
      }
    })
    expect(new Set(attachmentLayout.tops).size).toBe(1)
    expect(attachmentLayout.scrollWidth).toBeGreaterThan(attachmentLayout.clientWidth)
    expect(attachmentLayout.lastTileReachable).toBe(true)
    await expect(page.getByRole('button', { name: 'Open attachment context.txt in Jira' })).toBeVisible()
    await page.getByRole('button', { name: 'Open APP-1 in Jira' }).click()
    await page.getByRole('button', { name: 'Open issue APP-1 in Jira' }).click()
    await page.getByRole('button', { name: 'Open attachment context.txt in Jira' }).click()
    await expect.poll(() => app!.evaluate(() => (globalThis as typeof globalThis & {
      __multiagentE2EDiagnostics?: { externalOpenAttempts: string[] }
    }).__multiagentE2EDiagnostics?.externalOpenAttempts ?? []))
      .toEqual([
        `http://127.0.0.1:${address.port}/browse/APP-1`,
        `http://127.0.0.1:${address.port}/browse/APP-1`,
        `http://127.0.0.1:${address.port}/rest/api/3/attachment/content/attachment-1`,
      ])
    const editor = page.getByRole('textbox', { name: /Reply to selected mention/ })
    const compactEditorHeight = await editor.evaluate((element) => element.getBoundingClientRect().height)
    await editor.fill(Array.from({ length: 8 }, (_, index) => `Line ${index + 1}`).join('\n'))
    await expect.poll(() => editor.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(compactEditorHeight)
    await editor.fill('I will check @')
    const alexCandidates = page.getByRole('option', { name: /Alex.*comment author/i })
    await expect(alexCandidates).toHaveCount(2)
    await expect(alexCandidates.nth(0)).toContainText('Can you take a look?')
    await expect(alexCandidates.nth(1)).toContainText('Could you check this?')
    await alexCandidates.nth(0).click()
    await page.keyboard.type(' today.')
    holdReplyResponse = true
    await page.getByRole('button', { name: 'Reply' }).click()

    await expect.poll(() => receivedReplies.length).toBe(2)
    expect(receivedReplies[1].visibility).toBeUndefined()
    expect(receivedReplies[1].body).toEqual({
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'I will check ' },
        { type: 'mention', attrs: { id: 'alice-account', text: '@Alex' } },
        { type: 'text', text: ' today.' },
      ] }],
    })
    const duplicateResult = await page.evaluate(() => window.ipc.invoke('jira-mentions:post-reply', {
      issueId: '100', sourceCommentId: 'incoming-alice', tokens: [
        { kind: 'text', id: 'duplicate-text', text: 'I will check ' },
        { kind: 'mention', id: 'duplicate-mention', accountId: 'alice-account', displayName: 'Alex' },
      ],
    }))
    expect(duplicateResult).toEqual({ ok: false, outcome: 'rejected', errorCode: 'send_in_progress' })
    expect(receivedReplies).toHaveLength(2)
    holdNextRefreshSnapshot = true
    await page.getByRole('button', { name: 'Refresh Jira mentions' }).click()
    await refreshSnapshotStarted
    replyResponseControl.release?.()
    await expect(page.getByRole('button', { name: /Jira mentions, 1 unanswered/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Casey.*Could you also check this/ })).toBeVisible()
    const checkpointBeforeOldRefresh = await page.evaluate(async () => {
      const state = await window.ipc.invoke('jira-mentions:get-state')
      return { coverageThrough: state.coverageThrough, lastSuccessAt: state.lastSuccessAt }
    })
    refreshSnapshotControl.release?.()
    await refreshSnapshotSent
    await expect.poll(async () => page.evaluate(async () => (await window.ipc.invoke('jira-mentions:get-state')).status))
      .not.toBe('loading')
    await expect(page.getByRole('button', { name: /Jira mentions, 1 unanswered/ })).toBeVisible()
    await expect.poll(async () => page.evaluate(async () => {
      const state = await window.ipc.invoke('jira-mentions:get-state')
      return { coverageThrough: state.coverageThrough, lastSuccessAt: state.lastSuccessAt }
    })).toEqual(checkpointBeforeOldRefresh)
    await expect.poll(async () => page.evaluate(async () => {
      const state = await window.ipc.invoke('jira-mentions:get-state')
      return { status: state.status, activeCount: state.activeCount, errorCode: state.errorCode }
    })).toMatchObject({ status: 'partial', activeCount: 1, errorCode: 'superseded' })
    await expect(page.getByRole('button', { name: /Jira mentions, 1 unanswered/ })).toBeVisible()
    expect(receivedReplies).toHaveLength(2)

    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(layoutPath, 'utf8')) as { activeDestination?: unknown; sidebarOrder?: string[]; jiraFeatureVisible?: boolean }
      return saved.activeDestination
    }).toEqual({ kind: 'feature', featureId: 'jira-mentions' })
    const savedLayout = JSON.parse(await readFile(layoutPath, 'utf8')) as { sidebarOrder: string[]; jiraFeatureVisible: boolean }
    expect(savedLayout.sidebarOrder).toContain('feature:jira-mentions')
    expect(savedLayout.jiraFeatureVisible).toBe(true)
    const jiraSidebarButton = page.locator('button[title="Jira mentions"][draggable="true"]')
    await jiraSidebarButton.dragTo(page.getByTitle('Alpha', { exact: true }), {
      targetPosition: { x: 8, y: 2 },
    })
    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(layoutPath, 'utf8')) as { sidebarOrder: string[] }
      return saved.sidebarOrder[0] === 'feature:jira-mentions'
    }).toBe(true)
    await jiraSidebarButton.dragTo(page.getByTitle('Beta', { exact: true }), {
      targetPosition: { x: 8, y: 2 },
    })
    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(layoutPath, 'utf8')) as { sidebarOrder: string[] }
      const alphaIndex = saved.sidebarOrder.indexOf('project:tab-alpha')
      const jiraIndex = saved.sidebarOrder.indexOf('feature:jira-mentions')
      const betaIndex = saved.sidebarOrder.indexOf('project:tab-beta')
      return alphaIndex < jiraIndex && jiraIndex < betaIndex
    }).toBe(true)
    const sidebarOrderBeforeRestart = JSON.parse(await readFile(layoutPath, 'utf8')) as { sidebarOrder: string[] }
    expect(sidebarOrderBeforeRestart.sidebarOrder).toEqual(['project:tab-alpha', 'feature:jira-mentions', 'project:tab-beta'])
    const savedLayoutText = await readFile(layoutPath, 'utf8')
    expect(savedLayoutText).not.toContain('synthetic-token')
    expect(savedLayoutText).not.toContain('Can you take a look?')
    const databaseFiles = await Promise.all(['session-index.db', 'session-index.db-wal'].map(async (name) => {
      try { return await readFile(join(userDataDir, name)) } catch { return Buffer.alloc(0) }
    }))
    expect(Buffer.concat(databaseFiles).includes(Buffer.from('synthetic-token'))).toBe(false)

    await page.getByRole('button', { name: 'Alpha' }).click()
    await expect(projectTerminal).toBeVisible()
    await expect(paneSashes.first()).toBeVisible()
    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(layoutPath, 'utf8')) as { activeDestination?: unknown }
      return saved.activeDestination
    }).toEqual({ kind: 'project', tabId: 'tab-alpha' })
    await page.getByRole('button', { name: /Jira mentions, 1 unanswered/ }).click()
    await expect(paneSashes.first()).toBeHidden()
    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(layoutPath, 'utf8')) as { activeDestination?: unknown }
      return saved.activeDestination
    }).toEqual({ kind: 'feature', featureId: 'jira-mentions' })

    await page.setViewportSize({ width: 1280, height: 800 })
    await page.getByRole('button', { name: /Casey.*Could you also check this/ }).click()
    const snoozeButton = page.getByRole('button', { name: 'Snooze', exact: true })
    await snoozeButton.click()
    const snoozeMenu = page.getByRole('dialog', { name: 'Snooze duration' })
    await expect(snoozeMenu).toBeVisible()
    const snoozeDuration = snoozeMenu.getByRole('spinbutton', { name: 'Snooze duration' })
    await expect(snoozeDuration).toHaveValue('1')
    await expect(snoozeDuration).toHaveCSS('color-scheme', 'dark')
    const snoozeUnit = snoozeMenu.getByRole('combobox', { name: 'Snooze unit' })
    await expect(snoozeUnit).toHaveValue('hours')
    await expect(snoozeUnit).toHaveCSS('color-scheme', 'dark')
    await snoozeDuration.focus()
    await page.keyboard.press('Tab')
    await expect(snoozeUnit).toBeFocused()
    await expect(snoozeUnit).toHaveCSS('outline-color', 'rgb(74, 222, 128)')
    await page.keyboard.press('Shift+Tab')
    await expect(snoozeDuration).toBeFocused()
    await expect(snoozeDuration).toHaveCSS('outline-color', 'rgb(74, 222, 128)')
    await expect(snoozeMenu.getByText(/2 hours|1 day|Next Monday/)).toHaveCount(0)
    const snoozeBounds = await snoozeButton.boundingBox()
    const menuBounds = await snoozeMenu.boundingBox()
    expect(snoozeBounds && menuBounds && menuBounds.y).toBeGreaterThan(snoozeBounds?.y ?? 0)
    await snoozeUnit.focus()
    await snoozeDuration.hover()
    await screenshotUi(page, join(uiEvidenceDir, 'mentions-number-controls-main-windows-1280x800.png'))
    await page.getByRole('heading', { name: 'Synthetic issue' }).click()
    await expect(snoozeMenu).toBeHidden()
    await snoozeButton.click()
    await snoozeMenu.getByRole('spinbutton', { name: 'Snooze duration' }).fill('2')
    await snoozeMenu.getByRole('combobox', { name: 'Snooze unit' }).selectOption('hours')
    await snoozeMenu.getByRole('button', { name: 'Apply snooze' }).click()
    await expect.poll(async () => page.evaluate(async () => (await window.ipc.invoke('jira-mentions:get-state')).activeCount)).toBe(0)

    const cachedStateBeforeRestart = await page.evaluate(async () => {
      const state = await window.ipc.invoke('jira-mentions:get-state')
      return { activeCount: state.activeCount, lastSuccessAt: state.lastSuccessAt, coverageThrough: state.coverageThrough }
    })
    await closeApp(app)
    app = null
    jiraOffline = true
    app = await electron.launch({
      executablePath: electronPath,
      args: ['.'],
      cwd: repoRoot,
      env: jiraTestLaunchEnv(userDataDir, homeDir),
    })
    const restartedPage = await app.firstWindow()
    await assertDesktopIsolation(app)
    await restartedPage.waitForLoadState('domcontentloaded')
    await expect.poll(async () => restartedPage.evaluate(async () => {
      const state = await window.ipc.invoke('jira-mentions:get-state')
      return {
        status: state.status,
        identityVerified: state.identityVerified,
        cached: state.cached,
        activeCount: state.activeCount,
        lastSuccessAt: state.lastSuccessAt,
        coverageThrough: state.coverageThrough,
      }
    }), { timeout: 30_000 }).toEqual({
      status: 'error',
      identityVerified: true,
      cached: true,
      ...cachedStateBeforeRestart,
    })
    expect(offlineGetRequests).toBeGreaterThan(0)
    await expect(restartedPage.getByRole('button', { name: 'Alpha' })).toBeVisible()
    const layoutAfterRestart = JSON.parse(await readFile(layoutPath, 'utf8')) as { sidebarOrder: string[] }
    expect(layoutAfterRestart.sidebarOrder).toEqual(sidebarOrderBeforeRestart.sidebarOrder)
    await restartedPage.getByLabel('Jira mentions filter').selectOption('snoozed')
    await expect(restartedPage.getByRole('button', { name: /Casey.*Could you also check this/ })).toBeVisible()
    await restartedPage.getByRole('button', { name: /Casey.*Could you also check this/ }).click()
    await expect(restartedPage.getByRole('heading', { name: 'Synthetic issue' })).toBeVisible()
    const cachedEditor = restartedPage.getByRole('textbox', { name: /Reply to selected mention/ })
    await expect(cachedEditor).toBeVisible()
    await expect(restartedPage.getByText('I will check @Alex today.', { exact: false }).first()).toBeVisible()
    await expect(restartedPage.getByText('Context after the request')).toBeVisible()
    await cachedEditor.fill('@Alex')
    const alexSuggestions = restartedPage.getByRole('option', { name: /Alex/i })
    await expect(alexSuggestions).toHaveCount(3)
    await expect(alexSuggestions.filter({ hasText: 'ticket field' })).toHaveCount(1)
    await restartedPage.getByRole('button', { name: 'Unsnooze' }).click()
    await expect.poll(async () => restartedPage.evaluate(async () => (await window.ipc.invoke('jira-mentions:get-state')).activeCount)).toBe(1)
    await restartedPage.getByLabel('Jira mentions filter').selectOption('active')
    await expect(restartedPage.getByRole('button', { name: /Jira mentions, 1 unanswered/ })).toBeVisible()

    // Both windows share the main-owned refresh coordinator and receive the same count.
    const detachedPage = await tearOffTab(app, restartedPage, 'Beta')
    await detachedPage.waitForLoadState('domcontentloaded')
    await expect.poll(async () => detachedPage.evaluate(() => window.ipc.invoke('jira-mentions:get-state')))
      .toMatchObject({ status: 'error', activeCount: 1 })
    jiraOffline = false
    const searchesBefore = searchRequestCount
    includeLateMention = true
    currentIssueUpdated = new Date().toISOString()
    holdNextSearchResponse = true
    await restartedPage.evaluate(() => window.ipc.invoke('jira-mentions:clear-cache'))
    await expect.poll(() => searchRequestCount).toBe(searchesBefore + 1)
    await searchResponseHeld
    const primaryRefresh = restartedPage.evaluate(() => window.ipc.invoke('jira-mentions:refresh', 'manual'))
    const detachedRefresh = detachedPage.evaluate(() => window.ipc.invoke('jira-mentions:refresh', 'manual'))
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100))
    expect(searchRequestCount).toBe(searchesBefore + 1)
    searchResponseControl.release?.()
    const [primaryProjection, detachedProjection] = await Promise.all([primaryRefresh, detachedRefresh])
    expect(primaryProjection).toMatchObject({ status: 'ready', activeCount: 2 })
    expect(detachedProjection).toMatchObject({ status: 'ready', activeCount: 2 })
    await expect(restartedPage.getByTitle(/Open Jira mentions|Close Jira mentions/).first().getByText('2', { exact: true })).toBeVisible()
    await expect(detachedPage.getByTitle(/Open Jira mentions|Close Jira mentions/).first().getByText('2', { exact: true })).toBeVisible()
    expect(searchRequestCount).toBe(searchesBefore + 1)

    await detachedPage.getByTitle(/Open Jira mentions/).click()
    await detachedPage.getByRole('button', { name: /Drew.*One more request/ }).click()
    const detachedEditor = detachedPage.getByRole('textbox', { name: /Reply to selected mention/ })
    await detachedEditor.fill('I will handle @')
    await detachedPage.getByRole('option', { name: /Drew.*comment author/i }).click()
    await detachedPage.getByRole('button', { name: 'Reply' }).click()
    await expect.poll(() => receivedReplies.length).toBe(3)
    expect(receivedReplies[2].body).toEqual({
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'I will handle ' },
        { type: 'mention', attrs: { id: 'dave-account', text: '@Drew' } },
      ] }],
    })
    await expect.poll(async () => restartedPage.evaluate(async () => (await window.ipc.invoke('jira-mentions:get-state')).activeCount)).toBe(1)

    identityAccountId = 'other-account'
    await restartedPage.getByTitle('Settings').click()
    await restartedPage.getByText('Jira', { exact: true }).first().click()
    await restartedPage.getByRole('textbox', { name: 'Atlassian account email' }).fill('other@example.test')
    await restartedPage.getByRole('textbox', { name: 'Jira API token' }).fill('other-synthetic-token')
    await restartedPage.keyboard.press('Escape')
    await expect.poll(async () => restartedPage.evaluate(() => window.ipc.invoke('jira:get-settings')))
      .toMatchObject({ email: 'other@example.test', hasToken: true })
    await expect.poll(async () => restartedPage.evaluate(async () => {
      const state = await window.ipc.invoke('jira-mentions:get-state')
      return { status: state.status, identityVerified: state.identityVerified, activeCount: state.activeCount, items: state.items.length }
    }), { timeout: 30_000 }).toEqual({ status: 'ready', identityVerified: true, activeCount: 0, items: 0 })
    await expect(restartedPage.getByText('One more request?', { exact: false })).toHaveCount(0)

    await closeApp(app)
    app = null
    app = await electron.launch({
      executablePath: electronPath,
      args: ['.'],
      cwd: repoRoot,
      env: jiraTestLaunchEnv(userDataDir, homeDir),
    })
    const identityChangedPage = await app.firstWindow()
    await assertDesktopIsolation(app)
    await identityChangedPage.waitForLoadState('domcontentloaded')
    await expect.poll(async () => identityChangedPage.evaluate(async () => {
      const state = await window.ipc.invoke('jira-mentions:get-state')
      return { status: state.status, identityVerified: state.identityVerified, activeCount: state.activeCount, items: state.items.length }
    }), { timeout: 30_000 }).toEqual({ status: 'ready', identityVerified: true, activeCount: 0, items: 0 })
    await expect(identityChangedPage.getByText('One more request?', { exact: false })).toHaveCount(0)
    expect(searchJqls.length).toBeGreaterThan(0)
    for (const { jql, accountId } of searchJqls) {
      expect(jql).toMatch(/^updated >= .+ AND comment ~ ".+" ORDER BY updated ASC, key ASC$/)
      expect(jql).toContain(`comment ~ "${accountId}"`)
    }
    await identityChangedPage.setViewportSize({ width: 1280, height: 800 })
    await identityChangedPage.goto(pathToFileURL(join(repoRoot, 'docs', 'prototypes', 'jira-mentions', 'design-exploration', '04-context-rail.html')).href)
    await expect(identityChangedPage.locator('.feature-page')).toBeVisible()
    await identityChangedPage.addStyleTag({ content: '.preview-bar{display:none!important}.feature-page{min-height:100vh}.inbox{height:100vh;top:0}' })
    await identityChangedPage.evaluate(() => window.scrollTo(0, 0))
    expect((await identityChangedPage.locator('.ticket-area').boundingBox())?.y).toBeLessThan(2)
    const mockupReply = identityChangedPage.locator('.reply-section')
    await expect(mockupReply).toBeVisible()
    await expect(mockupReply.locator('.reply-issue')).toHaveCount(0)
    await expect(mockupReply.getByText('Reply in the issue comment thread')).toHaveCount(0)
    expect(await mockupReply.innerText()).not.toContain('WEB-2081')
    await screenshotUi(identityChangedPage, join(evidenceDir, 'mockup-04-context-rail-1280x800.png'))
    await identityChangedPage.locator('.source-comment').scrollIntoViewIfNeeded()
    await screenshotUi(identityChangedPage, join(evidenceDir, 'mockup-04-context-rail-comments-1280x800.png'))
    await identityChangedPage.setViewportSize({ width: 1060, height: 757 })
    await identityChangedPage.reload()
    await expect(identityChangedPage.locator('.feature-page')).toBeVisible()
    await identityChangedPage.addStyleTag({ content: '.preview-bar{display:none!important}.feature-page{min-height:100vh}.inbox{height:100vh;top:0}' })
    await identityChangedPage.evaluate(() => window.scrollTo(0, 0))
    await expect(identityChangedPage.locator('.reply-section')).toBeVisible()
    await expect(identityChangedPage.locator('.reply-section .reply-issue')).toHaveCount(0)
    await expect(identityChangedPage.locator('.reply-section').getByText('Reply in the issue comment thread')).toHaveCount(0)
    expect(await identityChangedPage.locator('.reply-section').innerText()).not.toContain('WEB-2081')
    await screenshotUi(identityChangedPage, join(evidenceDir, 'mockup-04-feature-desktop-1060x757.png'))
    await identityChangedPage.setViewportSize({ width: 480, height: 857 })
    await identityChangedPage.reload()
    await expect(identityChangedPage.locator('.feature-page')).toBeVisible()
    await identityChangedPage.addStyleTag({ content: '.preview-bar{display:none!important}.feature-page{min-height:100vh}.inbox{height:auto;top:auto;position:static}' })
    await identityChangedPage.evaluate(() => window.scrollTo(0, 0))
    await expect(identityChangedPage.locator('.reply-section')).toBeAttached()
    await expect(identityChangedPage.locator('.reply-section .reply-issue')).toHaveCount(0)
    await expect(identityChangedPage.locator('.reply-section').getByText('Reply in the issue comment thread')).toHaveCount(0)
    expect(await identityChangedPage.locator('.reply-section').innerText()).not.toContain('WEB-2081')
    await screenshotUi(identityChangedPage, join(evidenceDir, 'mockup-04-feature-narrow-480x857.png'))
    await identityChangedPage.setViewportSize({ width: 700, height: 900 })
    await identityChangedPage.reload()
    await expect(identityChangedPage.locator('.feature-page')).toBeVisible()
    await identityChangedPage.addStyleTag({ content: '.preview-bar{display:none!important}.feature-page{min-height:100vh}.inbox{height:auto;top:auto;position:static}' })
    await identityChangedPage.evaluate(() => window.scrollTo(0, 0))
    const mockupStackedLayout = await identityChangedPage.evaluate(() => ({
      inboxBottom: document.querySelector('.inbox')!.getBoundingClientRect().bottom,
      ticketTop: document.querySelector('.ticket-area')!.getBoundingClientRect().top,
    }))
    expect(mockupStackedLayout.ticketTop).toBeGreaterThanOrEqual(mockupStackedLayout.inboxBottom - 1)
    expect(mockupStackedLayout.ticketTop).toBeLessThan(900)
    await screenshotUi(identityChangedPage, join(evidenceDir, 'mockup-04-context-rail-700x900.png'))
  } finally {
    if (app) {
      await assertDesktopIsolation(app)
      await closeApp(app)
    }
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
})
