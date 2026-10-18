import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(__dirname, '..')
const electronPath = require('electron') as string

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
  await Promise.race([
    app.close().catch(() => {}).then(() => exited),
    new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 8000)),
  ])
  if (proc.exitCode === null && proc.signalCode === null && proc.pid) {
    if (process.platform === 'win32') spawnSync(`taskkill /pid ${proc.pid} /T /F`, { shell: true, stdio: 'ignore' })
    else process.kill(-proc.pid, 'SIGKILL')
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
        sendJson(response, 200, [])
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
          const issueDetails = { ...jiraIssue(currentIssueUpdated, deliveredReplies, includeLateMention), fields: {
            ...jiraIssue(currentIssueUpdated, deliveredReplies, includeLateMention).fields,
            status: { id: '1', name: 'In Progress', statusCategory: { name: 'In Progress' } },
            issuetype: { name: 'Task' }, priority: { name: 'High' },
            assignee: { accountId: 'alice-account', displayName: 'Alex' },
            reporter: { accountId: 'requester-account', displayName: 'Requester' },
            creator: { accountId: 'creator-account', displayName: 'Creator' },
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
            attachment: [{ id: 'attachment-1', filename: 'context.txt', content: `http://127.0.0.1:${jiraServerPort}/rest/api/3/attachment/content/attachment-1`, mimeType: 'text/plain', size: 18,
              author: { accountId: 'requester-account', displayName: 'Requester' }, created: issueUpdated }],
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
  await mkdir(evidenceDir, { recursive: true })
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
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        MULTIAGENT_ALLOW_MULTI_INSTANCE: '1',
        MULTIAGENT_E2E_USER_DATA_DIR: userDataDir,
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
    })
    const page: Page = await app.firstWindow()
    await app.evaluate(({ shell }) => {
      const state = globalThis as typeof globalThis & { __jiraOpenedUrls?: string[] }
      state.__jiraOpenedUrls = []
      Object.defineProperty(shell, 'openExternal', {
        configurable: true,
        value: async (url: string) => { state.__jiraOpenedUrls?.push(url) },
      })
    })
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByText('Alpha', { exact: true }).first()).toBeVisible()

    // Exercise a populated project workspace before switching into the feature view.
    await page.getByTitle(/Command palette/).click()
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

    await page.getByTitle('Settings').click()
    await page.getByText('Jira', { exact: true }).first().click()
    await page.getByRole('textbox', { name: 'Jira base URL' }).fill(`http://127.0.0.1:${address.port}`)
    await page.getByRole('textbox', { name: 'Atlassian account email' }).fill('synthetic@example.test')
    await page.getByLabel('Jira API token').fill('synthetic-token')
    await page.getByRole('checkbox', { name: 'Track unanswered Jira mentions' }).check()
    await page.keyboard.press('Escape')

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
    await expect(page.getByRole('textbox', { name: 'Reply' })).toBeVisible()
    const laterComments = page.getByRole('region', { name: 'Later comments' })
    const earlierComments = page.getByRole('region', { name: 'Earlier comments' })
    const commentHistory = page.getByRole('region', { name: 'Comment history' })
    const replyComposer = page.getByRole('region', { name: 'Reply composer' })
    await expect(laterComments).toBeVisible()
    await expect(earlierComments).toBeVisible()
    await expect(page.getByText('Context after the request')).toBeVisible()
    await expect(page.getByText('Context before the request')).toBeVisible()
    expect(await commentHistory.locator('.dark-scrollbar').count()).toBe(0)
    expect(await page.evaluate(() => {
      const reply = document.querySelector('[aria-label="Reply composer"]')
      const history = document.querySelector('[aria-label="Comment history"]')
      return Boolean(reply && history && (reply.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING))
    })).toBe(true)
    await expect(replyComposer).toBeVisible()
    await page.screenshot({ path: join(evidenceDir, 'jira-mentions-populated.png') })

    issuePermissionDenied = true
    currentIssueUpdated = new Date().toISOString()
    const revoked = await page.evaluate(() => window.ipc.invoke('jira-mentions:refresh', 'manual'))
    expect(revoked).toMatchObject({ status: 'error', errorCode: 'permission', activeCount: 0 })
    await expect(page.getByRole('status')).toContainText('Jira denied access to some issues.')
    await page.screenshot({ path: join(evidenceDir, 'jira-mentions-access-error.png') })
    expect(await page.evaluate(() => window.ipc.invoke('jira-mentions:get-issue-detail', '100'))).toBeNull()
    issuePermissionDenied = false
    currentIssueUpdated = new Date().toISOString()
    await page.evaluate(() => window.ipc.invoke('jira-mentions:clear-cache'))
    await expect.poll(async () => page.evaluate(async () => {
      const state = await window.ipc.invoke('jira-mentions:get-state')
      return { status: state.status, activeCount: state.activeCount }
    }), { timeout: 30_000 }).toEqual({ status: 'ready', activeCount: 3 })

    await page.getByRole('button', { name: /Alex.*Could you check this/ }).click()
    const uncertainEditor = page.getByRole('textbox', { name: 'Reply' })
    await uncertainEditor.fill('I will check @')
    const bobCandidates = page.getByRole('option', { name: /Alex.*comment author/i })
    await expect(bobCandidates).toHaveCount(2)
    await expect(bobCandidates.nth(0)).toContainText('Could you check this?')
    await expect(bobCandidates.nth(1)).toContainText('Can you take a look?')
    await page.keyboard.press('Enter')
    await page.keyboard.type(' today.')
    await expect(uncertainEditor).toHaveValue('I will check @Alex today.')
    loseNextReplyResponse = true
    await page.getByRole('button', { name: 'Post reply' }).click()
    await expect(page.locator('span[role="status"]')).toHaveText('Delivery is uncertain. Refresh Jira mentions before trying again.')
    await expect(uncertainEditor).toHaveValue('I will check @Alex today.')
    await expect(page.getByRole('button', { name: 'Post reply' })).toBeDisabled()
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
    await expect(page.getByRole('button', { name: 'Post reply' })).toBeDisabled()
    await expect(page.getByRole('button', { name: /Jira mentions, 2 unanswered/ })).toBeVisible()
    await expect(uncertainEditor).toHaveValue('I will check @Alex today.')
    expect(receivedReplies).toHaveLength(1)

    await page.getByRole('button', { name: /Alex.*Can you take a look/ }).click()
    await expect(page.getByRole('heading', { name: 'Synthetic issue' })).toBeVisible()
    await expect(page.getByLabel('Status In Progress')).toHaveText('In Progress')
    await expect(page.getByLabel('Type Task')).toHaveText('Task')
    await expect(page.getByLabel('Priority High')).toHaveText('High')
    await expect(page.getByLabel('Issue details')).toContainText('Assignee Alex')
    await expect(page.getByLabel('Status In Progress')).toHaveAttribute('data-category', 'in-progress')
    expect(await page.getByLabel('Status In Progress').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(27, 43, 64)')
    expect(await page.getByLabel('Type Task').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(37, 40, 43)')
    expect(await page.getByLabel('Priority High').evaluate((element) => getComputedStyle(element).color)).toBe('rgb(229, 200, 140)')
    await expect(page.getByLabel('Issue facts')).toContainText('Reporter Requester')
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
    await expect(page.getByRole('textbox', { name: 'Reply' })).toBeInViewport()
    await page.screenshot({ path: join(evidenceDir, 'jira-mentions-long-description.png') })

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
    await expect(page.getByRole('separator', { name: 'Resize selected mention' })).toHaveCount(0)

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
    await expect(page.getByRole('button', { name: 'Open attachment context.txt in Jira' })).toBeVisible()
    await page.getByRole('button', { name: 'Open APP-1 in Jira' }).click()
    await page.getByRole('button', { name: 'Open issue APP-1 in Jira' }).click()
    await page.getByRole('button', { name: 'Open attachment context.txt in Jira' }).click()
    await expect.poll(() => app!.evaluate(() => (globalThis as typeof globalThis & { __jiraOpenedUrls?: string[] }).__jiraOpenedUrls ?? []))
      .toEqual([
        `http://127.0.0.1:${address.port}/browse/APP-1`,
        `http://127.0.0.1:${address.port}/browse/APP-1`,
        `http://127.0.0.1:${address.port}/rest/api/3/attachment/content/attachment-1`,
      ])
    const editor = page.getByRole('textbox', { name: 'Reply' })
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
    await page.getByRole('button', { name: 'Post reply' }).click()

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

    await page.getByRole('button', { name: /Casey.*Could you also check this/ }).click()
    await page.getByRole('button', { name: 'Snooze' }).click()
    await page.getByRole('menuitem', { name: /2 hours/ }).click()
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
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        MULTIAGENT_ALLOW_MULTI_INSTANCE: '1',
        MULTIAGENT_E2E_USER_DATA_DIR: userDataDir,
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
    })
    const restartedPage = await app.firstWindow()
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
    const cachedEditor = restartedPage.getByRole('textbox', { name: 'Reply' })
    await expect(cachedEditor).toBeVisible()
    await expect(restartedPage.getByText('I will check @Alex today.', { exact: false }).first()).toBeVisible()
    await expect(restartedPage.getByText('Context after the request')).toBeVisible()
    await cachedEditor.fill('@Alex')
    await expect(restartedPage.getByRole('option', { name: /Alex/i })).toHaveCount(2)
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
    const detachedEditor = detachedPage.getByRole('textbox', { name: 'Reply' })
    await detachedEditor.fill('I will handle @')
    await detachedPage.getByRole('option', { name: /Drew.*comment author/i }).click()
    await detachedPage.getByRole('button', { name: 'Post reply' }).click()
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
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        MULTIAGENT_ALLOW_MULTI_INSTANCE: '1',
        MULTIAGENT_E2E_USER_DATA_DIR: userDataDir,
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
    })
    const identityChangedPage = await app.firstWindow()
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
  } finally {
    if (app) await closeApp(app)
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
})
