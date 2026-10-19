import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { installMockIpc } from '../../../../../tests/mockIpc'
import type { JiraIssueSnapshot, JiraMentionsProjection } from '../../../../shared/jiraMentions'
import { useJiraMentionsStore } from '../../store/jiraMentions'
import { usePanesStore } from '../../store/panes'
import { ui } from '../../styles/theme'
import { JiraMentions } from './index'

beforeEach(() => {
  usePanesStore.setState({ activeDestination: { kind: 'project', tabId: '' } })
  useJiraMentionsStore.setState({ filter: 'active', search: '' })
})

afterEach(() => {
  cleanup()
  useJiraMentionsStore.setState({ selected: null, detail: null, detailLoading: false, drafts: {}, lastReplyResult: null, filter: 'active', search: '' })
  usePanesStore.setState({ activeDestination: { kind: 'project', tabId: '' } })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const user = { accountId: 'requester-account', displayName: 'Requester', sources: ['comment_author'] }
const issue = {
  issueId: 'issue-1', issueKey: 'APP-1', summary: 'A test issue', projectId: 'project-1', projectKey: 'APP', projectName: 'Application',
  statusId: 'status-1', statusName: 'Open', statusCategory: 'To Do', issueType: 'Task', priority: null,
  assignee: null, reporter: null, creator: null, createdAt: null, updatedAt: null, dueDate: null, resolution: null,
  description: null, attachments: [], parent: null, subtasks: [], issueLinks: [],
}
const incomingComment = {
  commentId: 'comment-1', issueId: 'issue-1', authorAccountId: user.accountId, authorDisplayName: user.displayName,
  createdAt: Date.parse('2026-10-16T10:00:00Z'), updatedAt: Date.parse('2026-10-16T10:00:00Z'),
  body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Can you take a look?' }] }] },
  excerpt: 'Can you take a look?', visibility: null, availability: 'visible' as const,
}
const earlierComment = {
  ...incomingComment,
  commentId: 'comment-earlier',
  createdAt: Date.parse('2026-10-15T09:00:00Z'),
  updatedAt: Date.parse('2026-10-15T09:00:00Z'),
  body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Earlier context' }] }] },
  excerpt: 'Earlier context',
}
const laterComment = {
  ...incomingComment,
  commentId: 'comment-later',
  createdAt: Date.parse('2026-10-16T11:00:00Z'),
  updatedAt: Date.parse('2026-10-16T11:00:00Z'),
  body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Later context' }] }] },
  excerpt: 'Later context',
}
const projection: JiraMentionsProjection = {
  enabled: true, identityVerified: true, status: 'ready', errorCode: null, activeCount: 1,
  lastAttemptAt: Date.now(), lastSuccessAt: Date.now(), historyFrom: null, coverageThrough: Date.now(), cached: true,
  items: [{ issue, comment: incomingComment, action: null, authors: [user], state: {
    issueId: issue.issueId, incomingCommentId: incomingComment.commentId, authorAccountId: user.accountId,
    sourceCreatedAt: incomingComment.createdAt, sourceUpdatedAt: incomingComment.updatedAt, sourceHash: 'hash',
    firstObservedAt: Date.now(), eligibleEditAt: null, eligibility: 'new', state: 'unanswered',
    resolvingCommentId: null, resolvingCreatedAt: null, ruleVersion: 1, computedAt: Date.now(),
  } }],
}
const detail: JiraIssueSnapshot = {
  issue, comments: [incomingComment], users: [user], observedCommentCount: 1, commentsComplete: true, updatedMarker: null,
}
const secondRequester = { accountId: 'second-requester-account', displayName: 'Taylor', sources: ['comment_author'] }
const secondIncomingComment = {
  ...incomingComment,
  commentId: 'comment-2',
  authorAccountId: secondRequester.accountId,
  authorDisplayName: secondRequester.displayName,
  excerpt: 'Second request',
}
const projectionWithSecondComment: JiraMentionsProjection = {
  ...projection,
  activeCount: 2,
  items: [projection.items[0], {
    ...projection.items[0],
    comment: secondIncomingComment,
    authors: [secondRequester],
    state: {
      ...projection.items[0].state,
      incomingCommentId: secondIncomingComment.commentId,
      authorAccountId: secondRequester.accountId,
    },
  }],
}
const detailWithSecondComment: JiraIssueSnapshot = {
  ...detail,
  comments: [incomingComment, secondIncomingComment],
  users: [user, secondRequester],
  observedCommentCount: 2,
}

function prepareStore(): void {
  useJiraMentionsStore.setState({ projection, selected: null, detail: null, detailLoading: false, drafts: {}, lastReplyResult: null })
}

describe('JiraMentions composer', () => {
  it('grows the reply editor with its content without an internal height cap', async () => {
    prepareStore()
    useJiraMentionsStore.setState({
      selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId },
      detail,
    })
    render(<JiraMentions />)

    const editor = screen.getByRole('textbox', { name: /Reply to ticket/ }) as HTMLTextAreaElement
    expect(editor).toHaveAccessibleName('Reply to ticket APP-1')
    let contentHeight = 0
    Object.defineProperty(editor, 'scrollHeight', { configurable: true, get: () => contentHeight })
    expect(editor.style.height).toBe('95px')

    contentHeight = 184
    await userEvent.setup().type(editor, 'A longer reply draft')
    await waitFor(() => expect(editor.style.height).toBe('184px'))

    contentHeight = 360
    await userEvent.setup().type(editor, ' with more context')
    await waitFor(() => {
      expect(editor.style.height).toBe('360px')
      expect(editor.style.maxHeight).toBe('')
      expect(editor.style.overflowY).toBe('hidden')
    })
    contentHeight = 720
    await userEvent.setup().type(editor, ' and a much longer draft')
    await waitFor(() => expect(editor.style.height).toBe('720px'))
    expect(editor.style.resize).toBe('vertical')
  })

  it('checks for stale results when the Jira destination opens', async () => {
    prepareStore()
    const ipc = installMockIpc()
    ipc.invoke.mockResolvedValue(projection)
    usePanesStore.setState({ activeDestination: { kind: 'feature', featureId: 'jira-mentions' } })
    render(<JiraMentions />)

    await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith('jira-mentions:refresh', 'open-if-stale'))
  })

  it('keeps search, filter, and manual refresh in one compact toolbar row', () => {
    prepareStore()
    render(<JiraMentions />)

    const search = screen.getByRole('textbox', { name: 'Search Jira mentions' })
    const filter = screen.getByRole('combobox', { name: 'Jira mentions filter' })
    const refresh = screen.getByRole('button', { name: 'Refresh Jira mentions' })
    expect(search.closest('.jira-mentions-inbox-controls')).toBe(filter.closest('.jira-mentions-inbox-controls'))
    expect(search.closest('.jira-mentions-inbox-controls')).toBe(refresh.closest('.jira-mentions-inbox-controls'))
  })

  it('uses the app text-field focus treatment for search and reply', () => {
    prepareStore()
    useJiraMentionsStore.setState({
      selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId },
      detail,
    })
    render(<JiraMentions />)

    const search = screen.getByRole('textbox', { name: 'Search Jira mentions' })
    const reply = screen.getByRole('textbox', { name: /Reply to ticket/ })
    expect(search).toHaveClass('ui-control')
    expect(reply).toHaveClass('ui-control')
  })

  it('requests editable text actions without sending field contents', () => {
    prepareStore()
    const ipc = installMockIpc()
    render(<JiraMentions />)

    const search = screen.getByRole('textbox', { name: 'Search Jira mentions' }) as HTMLInputElement
    fireEvent.change(search, { target: { value: 'APP-1' } })
    search.setSelectionRange(0, 3)
    const contextEvent = createEvent.contextMenu(search, { clientX: 31, clientY: 47 })
    fireEvent(search, contextEvent)

    expect(contextEvent.defaultPrevented).toBe(true)
    expect(ipc.invoke).toHaveBeenCalledWith('jira-mentions:show-text-context-menu', {
      target: 'editable', x: 31, y: 47, canCut: true, canCopy: true, canSelectAll: true,
    })
  })

  it('offers text actions for the nonempty number control when Chromium hides its selection range', () => {
    prepareStore()
    const ipc = installMockIpc()
    useJiraMentionsStore.setState({
      selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId },
      detail,
    })
    render(<JiraMentions />)
    fireEvent.click(screen.getByRole('button', { name: 'Snooze' }))

    const duration = screen.getByRole('spinbutton', { name: 'Snooze duration' }) as HTMLInputElement
    const contextEvent = createEvent.contextMenu(duration, { clientX: 72, clientY: 88 })
    fireEvent(duration, contextEvent)

    expect(contextEvent.defaultPrevented).toBe(true)
    expect(ipc.invoke).toHaveBeenCalledWith('jira-mentions:show-text-context-menu', {
      target: 'editable', x: 72, y: 88, canCut: true, canCopy: true, canSelectAll: true,
    })
  })

  it('requests Copy only for selected read-only mention text', () => {
    prepareStore()
    const ipc = installMockIpc()
    useJiraMentionsStore.setState({
      selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId },
      detail,
    })
    render(<JiraMentions />)

    const paragraph = document.querySelector('.jira-mentions-comment-body p')
    expect(paragraph).not.toBeNull()
    const range = document.createRange()
    range.selectNodeContents(paragraph!)
    window.getSelection()?.addRange(range)
    const contextEvent = createEvent.contextMenu(paragraph!, { clientX: 55, clientY: 72 })
    fireEvent(paragraph!, contextEvent)

    expect(contextEvent.defaultPrevented).toBe(true)
    expect(ipc.invoke).toHaveBeenCalledWith('jira-mentions:show-text-context-menu', {
      target: 'selection', x: 55, y: 72, canCut: false, canCopy: true, canSelectAll: false,
    })
  })

  it('shows every cached mention state in the All filter', async () => {
    prepareStore()
    const base = projection.items[0]
    const makeItem = (index: number, excerpt: string, state: 'answered' | 'unanswered' | 'unknown', disposition?: 'dismissed' | 'snoozed') => {
      const issueId = `issue-${index}`
      const commentId = `comment-${index}`
      return {
        ...base,
        issue: { ...issue, issueId, issueKey: `APP-${index}` },
        comment: { ...incomingComment, commentId, issueId, excerpt, createdAt: Date.now() + index },
        state: { ...base.state, issueId, incomingCommentId: commentId, state },
        action: disposition ? {
          issueId, incomingCommentId: commentId, disposition,
          snoozeUntil: disposition === 'snoozed' ? Date.now() + 60_000 : null, updatedAt: Date.now(),
        } : null,
      }
    }
    useJiraMentionsStore.setState({ projection: {
      ...projection,
      status: 'ready',
      items: [
        base,
        makeItem(2, 'Answered result', 'answered'),
        makeItem(3, 'Snoozed result', 'unanswered', 'snoozed'),
        makeItem(4, 'Dismissed result', 'unanswered', 'dismissed'),
        makeItem(5, 'Unverified result', 'unknown'),
      ],
    } })
    const userEventInstance = userEvent.setup()
    render(<JiraMentions />)

    await userEventInstance.selectOptions(screen.getByRole('combobox', { name: 'Jira mentions filter' }), 'all')

    for (const label of ['Can you take a look?', 'Answered result', 'Snoozed result', 'Dismissed result', 'Unverified result']) {
      expect(screen.getByText(label)).toBeVisible()
    }
  })

  it('keeps the global active count unchanged through search and every filter', async () => {
    prepareStore()
    const base = projection.items[0]
    const makeItem = (index: number, state: 'answered' | 'unanswered' | 'unknown', disposition?: 'dismissed' | 'snoozed') => {
      const issueId = `issue-${index}`
      const commentId = `comment-${index}`
      return {
        ...base,
        issue: { ...issue, issueId, issueKey: `APP-${index}`, summary: `Needle issue ${index}` },
        comment: { ...incomingComment, commentId, issueId, excerpt: `Needle request ${index}` },
        state: { ...base.state, issueId, incomingCommentId: commentId, state },
        action: disposition ? {
          issueId, incomingCommentId: commentId, disposition,
          snoozeUntil: disposition === 'snoozed' ? Date.now() + 60_000 : null, updatedAt: Date.now(),
        } : null,
      }
    }
    const allItems = [
      makeItem(1, 'unanswered'),
      makeItem(2, 'answered'),
      makeItem(3, 'unanswered', 'snoozed'),
      makeItem(4, 'unanswered', 'dismissed'),
      makeItem(5, 'unknown'),
    ]
    useJiraMentionsStore.setState({ projection: { ...projection, activeCount: 3, status: 'ready', items: allItems } })
    const userEventInstance = userEvent.setup()
    render(<JiraMentions />)

    const globalCount = screen.getByLabelText('3 active mentions')
    const search = screen.getByRole('textbox', { name: 'Search Jira mentions' })
    const filter = screen.getByRole('combobox', { name: 'Jira mentions filter' })
    await userEventInstance.type(search, 'needle')

    for (const [value, shown] of [['active', 2], ['snoozed', 1], ['dismissed', 1], ['answered', 1], ['all', 5]] as const) {
      await userEventInstance.selectOptions(filter, value)
      expect(globalCount).toHaveTextContent('3')
      expect(screen.getByText(`${shown} shown`)).toBeInTheDocument()
      expect(document.querySelectorAll('.jira-mentions-group-heading span')).toHaveLength(shown)
      expect(document.querySelectorAll('.jira-mentions-mention-row')).toHaveLength(shown)
    }

    await userEventInstance.clear(search)
    await userEventInstance.type(search, 'no-such-match')
    for (const value of ['active', 'snoozed', 'dismissed', 'answered', 'all']) {
      await userEventInstance.selectOptions(filter, value)
      expect(globalCount).toHaveTextContent('3')
      expect(document.querySelectorAll('.jira-mentions-group-heading')).toHaveLength(0)
      expect(document.querySelectorAll('.jira-mentions-mention-row')).toHaveLength(0)
    }
  })

  it('shows a checked empty state instead of an unanswered count when the scan completes with no items', () => {
    prepareStore()
    useJiraMentionsStore.setState({ projection: {
      ...projection,
      status: 'ready',
      activeCount: 0,
      lastSuccessAt: Date.parse('2026-10-16T12:00:00Z'),
      items: [],
    } })
    render(<JiraMentions />)

    expect(screen.getByText('No unanswered mentions.', { exact: true })).toBeInTheDocument()
    expect(screen.getByText(/^Checked/)).toBeInTheDocument()
  })

  it.each([
    ['loading', null, 'Checking Jira'],
    ['partial', null, 'This check was incomplete. The last complete inbox is still shown.'],
    ['error', 'invalid_config', 'Add a Jira site, email, and token in Settings to start tracking.'],
    ['error', 'auth', 'Jira rejected the saved credentials. Update them in Settings.'],
    ['error', 'permission', 'Jira denied access to some issues. The inbox keeps the last complete results.'],
    ['error', 'rate_limited', 'Jira asked MultiAgent to wait before checking again.'],
    ['error', 'network', 'Jira could not be reached. Showing the last complete results.'],
  ] as const)('keeps the cached item visible and explains %s state', (status, errorCode, message) => {
    prepareStore()
    useJiraMentionsStore.setState({ projection: { ...projection, status, errorCode } })
    render(<JiraMentions />)

    expect(screen.getByRole('status')).toHaveTextContent(message)
    expect(screen.getByText('Can you take a look?', { exact: false })).toBeInTheDocument()
  })

  it('keeps the unselected detail pane free of obvious-action instructions', () => {
    prepareStore()
    render(<JiraMentions />)

    expect(screen.queryByText('Select a comment to view its Jira context.')).not.toBeInTheDocument()
  })

  it('resets attachment expansion when the selected mention changes', async () => {
    prepareStore()
    const attachment = { id: 'attachment-reset', name: 'notes.txt', contentUrl: 'https://jira.example.test/attachment/notes.txt', mimeType: 'text/plain', size: 64, author: user, createdAt: incomingComment.createdAt }
    const detailWithAttachment = { ...detail, issue: { ...issue, attachments: [attachment] } }
    useJiraMentionsStore.setState({ projection: projectionWithSecondComment, selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId }, detail: detailWithAttachment })
    const ipc = installMockIpc()
    ipc.invoke.mockImplementation(async (channel: string) => channel === 'jira-mentions:get-issue-detail' ? detailWithAttachment : projectionWithSecondComment)
    const userEventInstance = userEvent.setup()
    render(<JiraMentions />)

    const attachments = screen.getByLabelText('Attachments')
    await userEventInstance.click(attachments.querySelector('summary')!)
    expect(attachments).toHaveAttribute('open')
    const card = document.querySelector('.jira-mentions-attachment-card')!
    expect(card.querySelector('.jira-mentions-attachment-metadata')).toHaveTextContent('text/plain · 64 B')
    expect(card.querySelector('.jira-mentions-attachment-date')).toHaveTextContent(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(incomingComment.createdAt),
    )
    await userEventInstance.click(screen.getByRole('button', { name: /Second request/ }))
    await waitFor(() => expect(useJiraMentionsStore.getState().selected?.incomingCommentId).toBe(secondIncomingComment.commentId))
    expect(screen.getByLabelText('Attachments')).not.toHaveAttribute('open')
    expect(ipc.invoke).toHaveBeenCalledWith('jira-mentions:get-issue-detail', issue.issueId)
  })

  it('orders comment ties by ID and ignores edits when placing the timeline', () => {
    prepareStore()
    const bodyWith = (text: string) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
    const tiedBefore = { ...incomingComment, commentId: 'comment-0-before', createdAt: incomingComment.createdAt, updatedAt: incomingComment.createdAt + 9_000_000, excerpt: 'Tie before selected', body: bodyWith('Tie before selected') }
    const tiedAfter = { ...incomingComment, commentId: 'comment-2-after', createdAt: incomingComment.createdAt, updatedAt: incomingComment.createdAt - 9_000_000, excerpt: 'Tie after selected', body: bodyWith('Tie after selected') }
    const editedOlder = { ...earlierComment, commentId: 'comment-edited-older', updatedAt: incomingComment.createdAt + 9_000_000, excerpt: 'Old comment edited today', body: bodyWith('Old comment edited today') }
    const genuinelyNewer = { ...laterComment, createdAt: incomingComment.createdAt + 1_000, updatedAt: incomingComment.createdAt - 9_000_000, excerpt: 'Created later, edited earlier', body: bodyWith('Created later, edited earlier') }
    const timelineDetail = { ...detail, comments: [editedOlder, tiedBefore, incomingComment, tiedAfter, genuinelyNewer] }
    useJiraMentionsStore.setState({ selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId }, detail: timelineDetail })
    render(<JiraMentions />)

    const history = screen.getByRole('region', { name: 'Comment history' })
    const text = history.textContent ?? ''
    const positions = [
      text.indexOf('Created later, edited earlier'),
      text.indexOf('Tie after selected'),
      text.indexOf('Can you take a look?'),
      text.indexOf('Tie before selected'),
      text.indexOf('Old comment edited today'),
    ]
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(within(history).getAllByText('Can you take a look?', { exact: true })).toHaveLength(1)
  })

  it('allows replies to unknown audiences and opens the selected issue through the main-owned Jira link', async () => {
    prepareStore()
    const restrictedDetail: JiraIssueSnapshot = {
      ...detail,
      comments: [{ ...incomingComment, visibility: { type: 'unsupported', value: 'Internal' } }],
    }
    const ipc = installMockIpc()
    ipc.invoke.mockImplementation(async (channel: string) => channel === 'jira-mentions:get-issue-detail' ? restrictedDetail : projection)
    const userEventInstance = userEvent.setup()
    render(<JiraMentions />)

    await userEventInstance.click(screen.getByRole('button', { name: /Requester/ }))
    expect(await screen.findByRole('heading', { name: 'A test issue' })).toBeInTheDocument()
    const reply = screen.getByRole('textbox', { name: /Reply to ticket/ })
    expect(reply).toBeEnabled()
    expect(reply).toHaveAttribute('placeholder', 'Write a reply')
    await userEventInstance.type(reply, 'Please review this.')
    await userEventInstance.click(screen.getByRole('button', { name: 'Reply' }))
    await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith('jira-mentions:post-reply', expect.objectContaining({
      issueId: issue.issueId, sourceCommentId: incomingComment.commentId,
    })))

    expect(screen.getByRole('button', { name: 'Open APP-1 in Jira' }).style.color).toBe(ui.color.accent)
    expect(screen.getByRole('button', { name: 'Open issue APP-1 in Jira' }).style.color).toBe(ui.color.accent)
    await userEventInstance.click(screen.getByRole('button', { name: 'Open APP-1 in Jira' }))
    expect(ipc.invoke).toHaveBeenCalledWith('jira:open-issue', 'APP-1')
    await userEventInstance.click(screen.getByRole('button', { name: 'Open issue APP-1 in Jira' }))
    expect(ipc.invoke.mock.calls.filter(([channel]) => channel === 'jira:open-issue')).toHaveLength(2)
    expect(ipc.invoke).not.toHaveBeenCalledWith('jira:open-issue', expect.stringMatching(/^https?:/))
    expect(screen.queryByRole('button', { name: 'A test issue' })).not.toBeInTheDocument()
  })

  it('keeps natural comment flow with context-only resize controls and reply above history', () => {
    prepareStore()
    useJiraMentionsStore.setState({
      selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId },
      detail: { ...detail, comments: [earlierComment, incomingComment, laterComment] },
    })
    render(<JiraMentions />)

    const reply = screen.getByRole('region', { name: 'Reply composer' })
    const history = screen.getByRole('region', { name: 'Comment history' })
    expect(within(reply).getByRole('textbox', { name: /Reply to ticket/ })).toBeVisible()
    expect(reply).not.toHaveTextContent(issue.issueKey)
    expect(reply.querySelector('.jira-mentions-reply-issue')).toBeNull()
    expect(within(reply).queryByText('Reply in the issue comment thread')).not.toBeInTheDocument()
    expect(within(reply).queryByRole('status')).not.toBeInTheDocument()
    expect(within(reply).getByRole('button', { name: 'Reply' })).toBeVisible()
    expect(screen.getByText('Earlier context')).toBeVisible()
    expect(screen.getByText('Later context')).toBeVisible()
    expect(reply.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const newerContext = history.querySelector('[aria-label="Newer comments"] .jira-mentions-comment-context') as HTMLElement
    const earlierContext = history.querySelector('[aria-label="Earlier comments"] .jira-mentions-comment-context') as HTMLElement
    expect(newerContext.style.height).toBe('auto')
    expect(newerContext.style.overflowY).toBe('visible')
    expect(earlierContext.style.height).toBe('auto')
    expect(earlierContext.style.overflowY).toBe('visible')
    const newerResize = screen.getByRole('separator', { name: 'Resize newer comments' })
    const earlierResize = screen.getByRole('separator', { name: 'Resize earlier comments' })
    const selectedMention = screen.getByRole('region', { name: 'Selected mention' }) as HTMLElement
    const selectedBody = selectedMention.querySelector('.jira-mentions-comment-context-body') as HTMLElement
    expect(selectedMention.style.height).toBe('')
    expect(selectedMention.style.overflow).toBe('')
    expect(selectedBody.style.height).toBe('')
    expect(selectedBody.style.overflowY).toBe('')
    expect(selectedBody).not.toHaveClass('dark-scrollbar')
    expect(screen.queryByRole('separator', { name: 'Resize selected mention' })).not.toBeInTheDocument()
    fireEvent.keyDown(newerResize, { key: 'ArrowDown' })
    expect(newerContext.style.height).toBe('48px')
    expect(earlierContext.style.height).toBe('auto')
    fireEvent.keyDown(earlierResize, { key: 'ArrowDown' })
    expect(earlierContext.style.height).toBe('48px')
    expect(screen.getAllByRole('separator').map((separator) => separator.getAttribute('aria-label'))).toEqual([
      'Resize newer comments', 'Resize earlier comments',
    ])
    const selectedInboxRow = document.querySelector('.jira-mentions-mention-row[data-selected="true"]') as HTMLElement
    expect(selectedInboxRow.querySelector('.jira-mentions-mention-tag')).toBeNull()
    expect(selectedInboxRow.querySelector('.jira-mentions-mention-row-head strong')?.textContent).toBe('Requester')

    const snooze = screen.getByRole('button', { name: 'Snooze' })
    const dismiss = screen.getByRole('button', { name: 'Dismiss' })
    expect(snooze).toHaveClass('jira-mentions-action-snooze')
    expect(dismiss).toHaveClass('jira-mentions-action-dismiss')
    const mentionsRoot = document.querySelector('.jira-mentions-root') as HTMLElement
    expect(mentionsRoot.style.getPropertyValue('--jira-mentions-waiting')).toBe(ui.color.statusWaiting)
    expect(mentionsRoot.style.getPropertyValue('--jira-mentions-danger')).toBe(ui.color.danger)
  })

  it('returns the detail pane to the composer when switching to another mention', () => {
    prepareStore()
    useJiraMentionsStore.setState({ selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId }, detail })
    render(<JiraMentions />)
    const detailPane = screen.getByRole('main')
    detailPane.scrollTop = 420

    act(() => useJiraMentionsStore.setState({
      projection: projectionWithSecondComment,
      selected: { issueId: issue.issueId, incomingCommentId: secondIncomingComment.commentId },
      detail: { ...detail, comments: [incomingComment, secondIncomingComment] },
    }))

    expect(detailPane.scrollTop).toBe(0)
  })

  it('inserts the selected ticket user at the cursor and posts the account ID in order', async () => {
    prepareStore()
    const ipc = installMockIpc()
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'jira-mentions:get-issue-detail') return detail
      if (channel === 'jira-mentions:post-reply') return { ok: true, commentId: 'reply-1' }
      if (channel === 'jira-mentions:get-state') return projection
      return projection
    })
    const userEventInstance = userEvent.setup()
    render(<JiraMentions />)

    await userEventInstance.click(screen.getByRole('button', { name: /Requester/ }))
    const editor = await screen.findByRole('textbox', { name: /Reply to ticket/ }) as HTMLTextAreaElement
    await userEventInstance.type(editor, 'I will check @ tomorrow.')
    const insertionPoint = 'I will check @'.length
    editor.focus()
    editor.setSelectionRange(insertionPoint, insertionPoint)
    expect(editor.selectionStart).toBe(insertionPoint)
    await userEventInstance.type(editor, 'R', { skipClick: true })
    await userEventInstance.keyboard('{ArrowDown}{Enter}')
    expect(editor).toHaveValue('I will check @Requester tomorrow.')
    await userEventInstance.click(screen.getByRole('button', { name: 'Reply' }))

    await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith('jira-mentions:post-reply', expect.objectContaining({
      issueId: issue.issueId,
      sourceCommentId: incomingComment.commentId,
      tokens: [
        { kind: 'text', id: 'text-0', text: 'I will check ' },
        { kind: 'mention', id: expect.any(String), accountId: user.accountId, displayName: user.displayName },
        { kind: 'text', id: expect.any(String), text: ' tomorrow.' },
      ],
    })))
    await waitFor(() => expect(editor).toHaveValue(''))
    expect(await screen.findByRole('status')).toHaveTextContent('Reply posted.')
  })

  it('posts multiple selected recipients as structured mentions and leaves a typed name as text', async () => {
    prepareStore()
    const ipc = installMockIpc()
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'jira-mentions:get-issue-detail') return detailWithSecondComment
      if (channel === 'jira-mentions:post-reply') return { ok: true, commentId: 'reply-2' }
      return projectionWithSecondComment
    })
    const userEventInstance = userEvent.setup()
    render(<JiraMentions />)

    await userEventInstance.click(screen.getByRole('button', { name: /Can you take a look/ }))
    const editor = await screen.findByRole('textbox', { name: /Reply to ticket/ })
    await userEventInstance.type(editor, 'Ping @Req')
    await userEventInstance.keyboard('{ArrowDown}{Enter}')
    await userEventInstance.type(editor, ' and @Tay')
    await userEventInstance.keyboard('{ArrowDown}{Enter}')
    await userEventInstance.type(editor, ' and @Requester')
    await userEventInstance.keyboard('{Escape}')
    await userEventInstance.click(screen.getByRole('button', { name: 'Reply' }))

    await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith('jira-mentions:post-reply', expect.objectContaining({
      issueId: issue.issueId,
      sourceCommentId: incomingComment.commentId,
      tokens: [
        { kind: 'text', id: 'text-0', text: 'Ping ' },
        { kind: 'mention', id: expect.any(String), accountId: user.accountId, displayName: user.displayName },
        { kind: 'text', id: expect.any(String), text: ' and ' },
        { kind: 'mention', id: expect.any(String), accountId: secondRequester.accountId, displayName: secondRequester.displayName },
        { kind: 'text', id: expect.any(String), text: ' and @Requester' },
      ],
    })))
  })

  it('restores an inline account-ID mention after navigating to another request', async () => {
    prepareStore()
    useJiraMentionsStore.setState({ projection: projectionWithSecondComment })
    const ipc = installMockIpc()
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'jira-mentions:get-issue-detail') return detailWithSecondComment
      if (channel === 'jira-mentions:post-reply') return { ok: true, commentId: 'reply-1' }
      if (channel === 'jira-mentions:get-state') return projectionWithSecondComment
      return projectionWithSecondComment
    })
    const userEventInstance = userEvent.setup()
    render(<JiraMentions />)

    await userEventInstance.click(screen.getByRole('button', { name: /Can you take a look/ }))
    let editor = await screen.findByRole('textbox', { name: /Reply to ticket/ })
    await userEventInstance.type(editor, 'Ping @Req')
    await userEventInstance.keyboard('{ArrowDown}{Enter}')
    expect(editor).toHaveValue('Ping @Requester')

    await userEventInstance.click(screen.getByRole('button', { name: /Second request/ }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: /Reply to ticket/ })).toHaveValue(''))
    await userEventInstance.click(screen.getByRole('button', { name: /Can you take a look/ }))
    editor = await screen.findByRole('textbox', { name: /Reply to ticket/ })
    await waitFor(() => expect(editor).toHaveValue('Ping @Requester'))

    await userEventInstance.click(screen.getByRole('button', { name: 'Reply' }))
    await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith('jira-mentions:post-reply', expect.objectContaining({
      issueId: issue.issueId,
      sourceCommentId: incomingComment.commentId,
      tokens: [
        { kind: 'text', id: 'text-0', text: 'Ping ' },
        { kind: 'mention', id: expect.any(String), accountId: user.accountId, displayName: user.displayName },
      ],
    })))
  })

  it('keeps reply drafts separate when switching between comments on the same issue', async () => {
    prepareStore()
    useJiraMentionsStore.setState({ projection: projectionWithSecondComment })
    const ipc = installMockIpc()
    ipc.invoke.mockResolvedValue(detailWithSecondComment)
    const userEventInstance = userEvent.setup()
    render(<JiraMentions />)

    await userEventInstance.click(screen.getByRole('button', { name: /Can you take a look/ }))
    let editor = await screen.findByRole('textbox', { name: /Reply to ticket/ })
    await userEventInstance.type(editor, 'Draft for first request')

    await userEventInstance.click(screen.getByRole('button', { name: /Second request/ }))
    editor = await screen.findByRole('textbox', { name: /Reply to ticket/ })
    await waitFor(() => expect(editor).toHaveValue(''))
    await userEventInstance.type(editor, 'Draft for second request')

    await userEventInstance.click(screen.getByRole('button', { name: /Can you take a look/ }))
    editor = await screen.findByRole('textbox', { name: /Reply to ticket/ })
    await waitFor(() => expect(editor).toHaveValue('Draft for first request'))
    await userEventInstance.click(screen.getByRole('button', { name: /Second request/ }))
    editor = await screen.findByRole('textbox', { name: /Reply to ticket/ })
    await waitFor(() => expect(editor).toHaveValue('Draft for second request'))
  })

  it('retains the reply draft when Jira rejects a post', async () => {
    prepareStore()
    const ipc = installMockIpc()
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'jira-mentions:get-issue-detail') return detail
      if (channel === 'jira-mentions:post-reply') return { ok: false, outcome: 'rejected', errorCode: 'validation' }
      return projection
    })
    const userEventInstance = userEvent.setup()
    render(<JiraMentions />)

    await userEventInstance.click(screen.getByRole('button', { name: /Requester/ }))
    const editor = await screen.findByRole('textbox', { name: /Reply to ticket/ })
    await userEventInstance.type(editor, 'Please review this change.')
    await userEventInstance.click(screen.getByRole('button', { name: 'Reply' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Jira rejected the reply content or format. Edit the reply and try again.')
    expect(editor).toHaveValue('Please review this change.')
  })

  it.each([
    ['auth', 'Update the Jira credentials in Settings, then try again.'],
    ['permission', 'Jira denied permission to add a comment to this ticket.'],
    ['invalid_recipient', 'Jira could not find one or more selected people. Remove those mentions and try again.'],
    ['rate_limited', 'Jira is limiting replies. Wait before trying again.'],
    ['delivery_rechecked', 'Jira did not show the reply after you refreshed. You can send it again.'],
    ['already_answered', 'This request was answered while you had it open. You can still reply.'],
    ['send_in_progress', 'A reply to this request is already being sent. Wait for it to finish before trying again.'],
    ['network', 'Could not reach Jira. Check the connection and try again.'],
  ] as const)('keeps the draft and gives actionable feedback after a %s reply failure', async (errorCode, message) => {
    prepareStore()
    useJiraMentionsStore.setState({
      selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId },
      detail,
      lastReplyResult: { ok: false, outcome: 'rejected', errorCode },
    })
    const userEventInstance = userEvent.setup()
    render(<JiraMentions />)

    const editor = screen.getByRole('textbox', { name: /Reply to ticket/ })
    await userEventInstance.type(editor, 'Please review this change.')

    expect(screen.getByRole('status')).toHaveTextContent(message)
    expect(editor).toHaveValue('Please review this change.')
  })

  it('moves an issue group by its newest remaining active comment after dismissing the newest request', async () => {
    const secondIssue = { ...issue, issueId: 'issue-2', issueKey: 'APP-2', summary: 'Second issue' }
    const newest = { ...incomingComment, commentId: 'newest-a', createdAt: 500, updatedAt: 500, excerpt: 'Newest request' }
    const oldest = { ...incomingComment, commentId: 'oldest-a', createdAt: 100, updatedAt: 100, excerpt: 'Older request' }
    const middle = { ...incomingComment, issueId: secondIssue.issueId, commentId: 'middle-b', createdAt: 300, updatedAt: 300, excerpt: 'Middle request' }
    const itemFor = (itemIssue: typeof issue, comment: typeof incomingComment): JiraMentionsProjection['items'][number] => ({
      issue: itemIssue,
      comment,
      action: null,
      authors: [user],
      state: {
        issueId: itemIssue.issueId, incomingCommentId: comment.commentId, authorAccountId: user.accountId,
        sourceCreatedAt: comment.createdAt, sourceUpdatedAt: comment.updatedAt, sourceHash: 'hash',
        firstObservedAt: 1, eligibleEditAt: null, eligibility: 'new', state: 'unanswered',
        resolvingCommentId: null, resolvingCreatedAt: null, ruleVersion: 1, computedAt: 1,
      },
    })
    const initial: JiraMentionsProjection = {
      ...projection,
      activeCount: 3,
      items: [itemFor(issue, newest), itemFor(issue, oldest), itemFor(secondIssue, middle)],
    }
    const dismissed: JiraMentionsProjection = {
      ...initial,
      activeCount: 2,
      items: initial.items.map((item) => item.comment.commentId === newest.commentId
        ? { ...item, action: { issueId: issue.issueId, incomingCommentId: newest.commentId, disposition: 'dismissed', snoozeUntil: null, updatedAt: 600 } }
        : item),
    }
    useJiraMentionsStore.setState({ projection: initial, selected: null, detail: null, detailLoading: false, drafts: {}, lastReplyResult: null })
    const ipc = installMockIpc()
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'jira-mentions:get-issue-detail') return detail
      if (channel === 'jira-mentions:set-action') return dismissed
      return initial
    })
    const userEventInstance = userEvent.setup()
    render(<JiraMentions />)

    expect(document.querySelector('.jira-mentions-group-heading p')).toHaveTextContent('A test issue')
    expect(screen.getAllByText('A test issue', { exact: true })).toHaveLength(3)
    expect(screen.getByText('APP-1').compareDocumentPosition(screen.getByText('APP-2')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await userEventInstance.click(screen.getByRole('button', { name: /Newest request/ }))
    await screen.findByRole('heading', { name: 'A test issue' })
    await userEventInstance.click(screen.getByRole('button', { name: 'Dismiss' }))

    await waitFor(() => {
      const secondIssueKey = screen.getByRole('button', { name: 'Open APP-2 in Jira' })
      const firstIssueKey = screen.getByRole('button', { name: 'Open APP-1 in Jira' })
      expect(secondIssueKey.compareDocumentPosition(firstIssueKey) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
  })

  it('removes a selected mention token completely before posting text-only reply', async () => {
    prepareStore()
    const ipc = installMockIpc()
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'jira-mentions:get-issue-detail') return detail
      if (channel === 'jira-mentions:post-reply') return { ok: true, commentId: 'reply-1' }
      if (channel === 'jira-mentions:get-state') return projection
      return projection
    })
    const userEventInstance = userEvent.setup()
    render(<JiraMentions />)

    await userEventInstance.click(screen.getByRole('button', { name: /Requester/ }))
    const editor = await screen.findByRole('textbox', { name: /Reply to ticket/ })
    await userEventInstance.type(editor, 'Ask @')
    await userEventInstance.keyboard('{ArrowDown}{Enter}')
    expect(editor).toHaveValue('Ask @Requester')
    await userEventInstance.keyboard('{Backspace}')
    expect(editor).toHaveValue('Ask ')
    await userEventInstance.click(screen.getByRole('button', { name: 'Reply' }))

    await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith('jira-mentions:post-reply', expect.objectContaining({
      issueId: issue.issueId,
      sourceCommentId: incomingComment.commentId,
      tokens: [{ kind: 'text', id: 'text-0', text: 'Ask ' }],
    })))
  })

  it('shows available issue metadata and attachment details', async () => {
    prepareStore()
    const earlierNewerComment = {
      ...earlierComment,
      commentId: 'comment-earlier-newer',
      createdAt: Date.parse('2026-10-16T09:00:00Z'),
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'More recent earlier context' }] }] },
    }
    const laterNewerComment = {
      ...laterComment,
      commentId: 'comment-later-newer',
      createdAt: Date.parse('2026-10-16T12:00:00Z'),
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'More recent later context' }] }] },
    }
    const richDetail: JiraIssueSnapshot = {
      ...detail,
      users: [
        ...detail.users,
        { accountId: 'dev-tester-id', displayName: 'Dev Tester One', sources: ['field-name:dev tester'] },
        { accountId: 'dev-tester-second-id', displayName: 'Dev Tester Two', sources: ['field-name:dev tester'] },
        { accountId: 'main-dev-id', displayName: 'Main Developer', sources: ['field-name:main dev'] },
      ],
      comments: [earlierComment, earlierNewerComment, incomingComment, laterComment, laterNewerComment],
      issue: {
        ...issue,
        statusName: 'In Progress', statusCategory: 'In Progress', priority: 'High', issueType: 'Bug',
        assignee: { accountId: 'assignee-id', displayName: 'Morgan', sources: ['assignee'] },
        reporter: { accountId: 'reporter-id', displayName: 'Taylor', sources: ['reporter'] },
         createdAt: Date.parse('2026-10-14T08:30:00Z'),
         updatedAt: Date.parse('2026-10-16T12:00:00Z'),
         dueDate: '2026-10-31',
         parent: { issueKey: 'APP-2', summary: 'Parent issue' },
        description: { type: 'doc', version: 1, content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Issue description' }] },
          { type: 'table', content: [
            { type: 'tableRow', content: [
              { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Message' }] }] },
              { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Count' }] }] },
            ] },
            { type: 'tableRow', content: [
              { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Query timeout expired' }] }] },
              { type: 'tableCell', attrs: { colspan: 1 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '5' }] }] },
            ] },
          ] },
        ] },
        attachments: [{ id: 'attachment-1', name: 'design.txt', contentUrl: 'https://jira.example.test/secure/attachment/attachment-1/design.txt', mimeType: 'text/plain', size: 12 * 1024, author: user, createdAt: Date.parse('2026-10-15T12:00:00Z') }],
      },
    }
    const ipc = installMockIpc()
    ipc.invoke.mockImplementation(async (channel: string) => channel === 'jira-mentions:get-issue-detail' ? richDetail : projection)
    const userEventInstance = userEvent.setup()
    render(<JiraMentions />)

    await userEventInstance.click(screen.getByRole('button', { name: /Requester/ }))
    const issueRail = await screen.findByLabelText('Issue details')
    expect(issueRail).toHaveTextContent('High')
    expect(issueRail).toHaveTextContent('In Progress')
    expect(issueRail).toHaveTextContent('Bug')
    expect(issueRail).toHaveTextContent('Morgan')
    expect(issueRail).toHaveTextContent('Dev Tester One')
    expect(issueRail).toHaveTextContent('Dev Tester Two')
    expect(issueRail).toHaveTextContent('Main Developer')
    const devTesterProperty = screen.getByLabelText('Dev Tester Dev Tester One, Dev Tester Two')
    expect(devTesterProperty).toBeInTheDocument()
    expect(devTesterProperty.querySelectorAll('.jira-mentions-avatar')).toHaveLength(2)
    expect(screen.getByLabelText('Main Dev Main Developer')).toBeInTheDocument()
    const statusChip = issueRail.querySelector('[data-property="status"]') as HTMLElement
    const typeChip = issueRail.querySelector('[data-property="type"]') as HTMLElement
    const priorityValue = issueRail.querySelector('[data-property="priority"]') as HTMLElement
    const assigneeValue = issueRail.querySelector('[data-property="assignee"]') as HTMLElement
    expect(statusChip).toHaveAttribute('data-category', 'in-progress')
    expect(statusChip).toHaveTextContent(/^In Progress$/)
    expect(statusChip.style.background).toBe(ui.color.jiraStatusProgressBackground)
    expect(statusChip.style.color).toBe(ui.color.jiraStatusProgress)
    expect(typeChip).toHaveTextContent(/^Bug$/)
    expect(typeChip.style.background).toBe(ui.color.jiraIssueTypeBackground)
    expect(typeChip.style.color).toBe(ui.color.jiraIssueType)
    expect(typeChip.style.borderColor).toBe(ui.color.jiraIssueTypeBorder)
    expect(priorityValue).toHaveTextContent(/^High$/)
    expect(priorityValue.style.color).toBe(ui.color.jiraPriority)
    expect(priorityValue.style.borderLeftColor).toBe(ui.color.border)
    expect(assigneeValue.style.background).toBe('')
    expect(issueRail).toHaveTextContent('Taylor')
    expect(issueRail).toHaveTextContent('ParentAPP-2')
    expect(issueRail).toHaveTextContent('Due2026-10-31')
    expect(issueRail).toHaveTextContent('Created')
    expect(issueRail).toHaveTextContent('Updated')
    expect(Array.from(issueRail.querySelectorAll('dt')).map((label) => label.textContent)).toEqual([
      'Status', 'Type', 'Priority', 'Assignee', 'Reporter', 'Dev Tester', 'Main Dev', 'Parent', 'Due', 'Created', 'Updated',
    ])
    expect(screen.getAllByText('Created').filter((element) => issueRail.contains(element))).toHaveLength(1)
    const attachments = screen.getByLabelText('Attachments')
    expect(attachments.querySelector('summary')).toHaveTextContent('Attachments 1')
    expect(attachments).not.toHaveAttribute('open')
    await userEventInstance.click(attachments.querySelector('summary')!)
    expect(attachments).toHaveAttribute('open')
    const attachmentLink = screen.getByRole('button', { name: 'Open attachment design.txt in Jira' })
    expect(attachmentLink).toBeInTheDocument()
    await userEventInstance.click(attachmentLink)
    expect(ipc.invoke).toHaveBeenCalledWith('jira-mentions:open-attachment', 'issue-1', 'attachment-1')
    expect(screen.getByText(/12\.0 KB/)).toBeInTheDocument()
    expect(screen.getByText('Issue description')).toBeInTheDocument()
    const table = screen.getByRole('table')
    expect(table.querySelectorAll('tr')).toHaveLength(2)
    expect(table.querySelectorAll('th')).toHaveLength(2)
    expect(table.querySelectorAll('td')).toHaveLength(2)
    expect(screen.getByRole('columnheader', { name: 'Message' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Query timeout expired' })).toBeInTheDocument()
    const attachmentDetails = screen.getByRole('button', { name: 'Open attachment design.txt in Jira' }).parentElement
    expect(attachmentDetails?.textContent).toContain('Requester')
    expect(attachmentDetails?.textContent).toContain('2026')
    expect(screen.getByText('Earlier context')).toBeVisible()
    expect(screen.getByText('Later context')).toBeVisible()
    const conversation = screen.getByRole('region', { name: 'Comment history' })
    const conversationText = conversation.textContent ?? ''
    expect(conversationText.indexOf('More recent later context')).toBeLessThan(conversationText.indexOf('Later context'))
    expect(conversationText.indexOf('Later context')).toBeLessThan(conversationText.indexOf('Can you take a look?'))
    expect(conversationText.indexOf('Can you take a look?')).toBeLessThan(conversationText.indexOf('More recent earlier context'))
    expect(conversationText.indexOf('More recent earlier context')).toBeLessThan(conversationText.indexOf('Earlier context'))
    const replyComposer = screen.getByRole('region', { name: 'Reply composer' })
    expect(replyComposer.compareDocumentPosition(conversation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(attachments.compareDocumentPosition(replyComposer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('omits unavailable optional issue metadata and attachments', () => {
    prepareStore()
    const detailWithoutAttachmentLinks: JiraIssueSnapshot = {
      ...detail,
      issue: {
        ...issue,
        issueType: null,
        priority: null,
        assignee: null,
        reporter: null,
        parent: null,
        dueDate: null,
        createdAt: null,
        updatedAt: null,
        attachments: [{ id: 'attachment-1', name: 'unlinked.txt', contentUrl: null, mimeType: 'text/plain', size: 100, author: null, createdAt: null }],
      },
    }
    useJiraMentionsStore.setState({ selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId }, detail: detailWithoutAttachmentLinks })
    render(<JiraMentions />)

    const issueRail = screen.getByLabelText('Issue details')
    expect(screen.getByLabelText('Status Open')).toBeInTheDocument()
    expect(issueRail).not.toHaveTextContent('Priority')
    expect(issueRail).not.toHaveTextContent('Assignee')
    expect(issueRail).not.toHaveTextContent('Reporter')
    expect(issueRail).not.toHaveTextContent('Parent')
    expect(issueRail).not.toHaveTextContent('Due')
    expect(issueRail).not.toHaveTextContent('Created')
    expect(issueRail).not.toHaveTextContent('Updated')
    expect(Array.from(issueRail.querySelectorAll('dt')).map((label) => label.textContent)).toEqual(['Status'])
    expect(screen.queryByRole('region', { name: 'Attachments' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Attachments')).not.toBeInTheDocument()
  })

  it('uses the completed color for Jira statuses in the Done category', () => {
    prepareStore()
    useJiraMentionsStore.setState({
      selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId },
      detail: { ...detail, issue: { ...issue, statusName: 'Resolved', statusCategory: 'Done' } },
    })
    render(<JiraMentions />)

    const status = screen.getByLabelText('Status Resolved')
    expect(status).toHaveAttribute('data-category', 'done')
    expect((status as HTMLElement).style.background).toBe(ui.color.jiraStatusDoneBackground)
    expect((status as HTMLElement).style.color).toBe(ui.color.jiraStatusDone)
  })

  it('keeps comment actions with the source comment and places the composer before history', () => {
    prepareStore()
    useJiraMentionsStore.setState({ selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId }, detail })
    render(<JiraMentions />)

    const comment = screen.getAllByText('Can you take a look?')[1]
    const editor = screen.getByRole('textbox', { name: /Reply to ticket/ })
    const history = screen.getByRole('region', { name: 'Comment history' })
    const composer = screen.getByRole('region', { name: 'Reply composer' })
    expect(history).toContainElement(comment)
    expect(history).not.toContainElement(editor)
    expect(history.style.border).toBe('')
    expect(history.style.borderRadius).toBe('')
    expect(composer.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const snooze = screen.getByRole('button', { name: 'Snooze' })
    const dismiss = screen.getByRole('button', { name: 'Dismiss' })
    const commentHeader = history.querySelector('.jira-mentions-comment-head')
    expect(snooze.parentElement?.parentElement?.parentElement).toBe(commentHeader)
    expect(dismiss.parentElement?.parentElement).toBe(commentHeader)
    expect(history.querySelector('[data-selected="true"]')).toHaveClass('jira-mentions-comment-row')
    expect(history.querySelector('.jira-mentions-source-tag')).toHaveTextContent('Mention')
    expect(history.querySelector('.jira-mentions-comment-avatar')).toBeInTheDocument()
    expect(commentHeader?.textContent).toContain('Requester')
    expect(commentHeader?.textContent).toContain('2026')
    expect(editor).toHaveAttribute('placeholder', 'Write a reply')
    expect(screen.queryByPlaceholderText(/Type @/)).not.toBeInTheDocument()
  })

  it('opens a compact Snooze duration form beside the action and closes on outside click or Escape', async () => {
    prepareStore()
    useJiraMentionsStore.setState({ selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId }, detail })
    render(<JiraMentions />)
    const user = userEvent.setup()
    const snooze = screen.getByRole('button', { name: 'Snooze' })

    await user.click(snooze)
    const menu = screen.getByRole('dialog', { name: 'Snooze duration' })
    expect(snooze).toHaveAttribute('aria-expanded', 'true')
    expect(within(menu).getByRole('spinbutton', { name: 'Snooze duration' })).toHaveValue(1)
    expect(within(menu).getByRole('combobox', { name: 'Snooze unit' })).toHaveValue('hours')
    expect(within(menu).getByRole('button', { name: 'Apply snooze' })).toBeInTheDocument()
    expect(menu).toHaveClass('jira-mentions-snooze-menu')

    await user.click(screen.getByRole('region', { name: 'Reply composer' }))
    expect(screen.queryByRole('dialog', { name: 'Snooze duration' })).not.toBeInTheDocument()
    expect(snooze).toHaveAttribute('aria-expanded', 'false')

    await user.click(snooze)
    expect(screen.getByRole('dialog', { name: 'Snooze duration' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Snooze duration' })).not.toBeInTheDocument()
  })

  it('submits the typed Snooze duration in the selected unit', async () => {
    const now = Date.parse('2026-03-07T16:00:00Z')
    vi.spyOn(Date, 'now').mockReturnValue(now)
    prepareStore()
    const ipc = installMockIpc()
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'jira-mentions:get-issue-detail') return detail
      if (channel === 'jira-mentions:set-action') return projection
      return projection
    })
    const userEventInstance = userEvent.setup()
    render(<JiraMentions />)

    await userEventInstance.click(screen.getByRole('button', { name: /Requester/ }))
    await screen.findByRole('textbox', { name: /Reply to ticket/ })
    await userEventInstance.click(screen.getByRole('button', { name: 'Snooze' }))
    const menu = screen.getByRole('dialog', { name: 'Snooze duration' })
    await userEventInstance.clear(within(menu).getByRole('spinbutton', { name: 'Snooze duration' }))
    await userEventInstance.type(within(menu).getByRole('spinbutton', { name: 'Snooze duration' }), '90')
    await userEventInstance.selectOptions(within(menu).getByRole('combobox', { name: 'Snooze unit' }), 'minutes')
    await userEventInstance.click(within(menu).getByRole('button', { name: 'Apply snooze' }))
    const snoozeUntil = now + 90 * 60_000
    await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith('jira-mentions:set-action', expect.objectContaining({
      issueId: issue.issueId, incomingCommentId: incomingComment.commentId, action: 'snoozed', snoozeUntil,
    })))
  })

  it('renders hostile structured text as text and never creates a clickable Jira link', async () => {
    prepareStore()
    const hostileDetail: JiraIssueSnapshot = {
      ...detail,
      issue: {
        ...issue,
        description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [
          { type: 'link', attrs: { href: 'javascript:alert(1)' }, content: [{ type: 'text', text: 'unsafe link' }] },
          { type: 'text', text: '<img src=x onerror=alert(1)>' },
        ] }] },
      },
    }
    const ipc = installMockIpc()
    ipc.invoke.mockImplementation(async (channel: string) => channel === 'jira-mentions:get-issue-detail' ? hostileDetail : projection)
    const { container } = render(<JiraMentions />)
    const userEventInstance = userEvent.setup()
    await userEventInstance.click(screen.getByRole('button', { name: /Requester/ }))
    await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith('jira-mentions:get-issue-detail', issue.issueId))
    await waitFor(() => expect(useJiraMentionsStore.getState().detail).toEqual(hostileDetail))

    const renderedDescription = container.querySelector('.jira-mentions-description-copy p')?.textContent ?? ''
    expect(renderedDescription).toContain('unsafe link')
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('img[onerror]')).toBeNull()
    expect(renderedDescription).toContain('<img src=x onerror=alert(1)>')
  })

  it('resizes a long description from its bottom edge at left, center, and right positions', async () => {
    prepareStore()
    useJiraMentionsStore.setState({
      selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId },
      detail: { ...detail, issue: { ...issue, description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Long description' }] }] } } },
    })
    render(<JiraMentions />)

    const separator = screen.getByRole('separator', { name: 'Resize description' })
    const descriptionSection = screen.getByLabelText('Description') as HTMLElement
    const detailViewport = screen.getByRole('main') as HTMLElement
    Object.defineProperty(detailViewport, 'clientHeight', { configurable: true, value: 900 })
    const body = separator.previousElementSibling as HTMLElement
    const originalWidth = body.style.width
    expect(descriptionSection.style.borderRadius).toBe('')
    expect(descriptionSection.style.background).toBe('')
    expect(descriptionSection).toHaveClass('jira-mentions-section')
    expect(body.style.height).toBe('auto')
    expect(body.style.maxHeight).toBe('min(360px, 35cqh)')
    expect(body.style.overflow).toBe('auto')
    expect(separator.style.cursor).toBe('ns-resize')
    expect((separator.querySelector('span') as HTMLElement).style.width).toBe('36px')
    let measuredHeight = 100
    vi.spyOn(body, 'getBoundingClientRect').mockImplementation(() => ({ height: measuredHeight } as DOMRect))
    for (const clientX of [0, 160, 320]) {
      const startHeight = measuredHeight
      fireEvent.pointerDown(separator, { clientX, clientY: 100 })
      fireEvent.pointerMove(window, { clientX, clientY: 120 })
      fireEvent.pointerUp(window, { clientX, clientY: 120 })
      measuredHeight = startHeight + 20
      expect(body.style.height).toBe(`${startHeight + 20}px`)
      expect(body.style.width).toBe(originalWidth)
      expect(body.style.maxHeight).toBe('none')
    }
    const detailPadding = window.getComputedStyle(detailViewport)
    const automaticMaxHeight = Math.min(360, Math.floor((detailViewport.clientHeight - (Number.parseFloat(detailPadding.paddingTop) || 18) - (Number.parseFloat(detailPadding.paddingBottom) || 18)) * 0.35))
    fireEvent.pointerDown(separator, { clientY: 100 })
    fireEvent.pointerMove(window, { clientY: 1000 })
    fireEvent.pointerUp(window, { clientY: 1000 })
    const manualHeight = Number.parseFloat(body.style.height)
    expect(manualHeight).toBeGreaterThan(automaticMaxHeight)
    expect(body.style.maxHeight).toBe('none')
    expect(separator).not.toHaveAttribute('aria-valuemax')
    const descriptionSummary = screen.getByLabelText('Description').querySelector('summary')!
    const descriptionDisclosure = descriptionSummary.parentElement!
    expect(descriptionDisclosure).toHaveAttribute('open')
    await fireEvent.click(descriptionSummary)
    expect(descriptionDisclosure).not.toHaveAttribute('open')
    await fireEvent.click(descriptionSummary)
    expect(descriptionDisclosure).toHaveAttribute('open')
    expect((screen.getByRole('separator', { name: 'Resize description' }).previousElementSibling as HTMLElement).style.height).toBe(`${manualHeight}px`)
  })

  it('renders Jira description panels without wrapping them in a generic card', () => {
    prepareStore()
    useJiraMentionsStore.setState({
      selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId },
      detail: { ...detail, issue: { ...issue, description: { type: 'doc', content: [
        { type: 'panel', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Panel description text' }] }] },
      ] } } },
    })
    render(<JiraMentions />)

    const description = screen.getByLabelText('Description')
    expect(description.querySelector('p')).toHaveTextContent('Panel description text')
    expect(description.querySelector('p')?.parentElement).toBe(description.querySelector('.dark-scrollbar'))
    expect(description.querySelector('div[style*="border-radius"]')).toBeNull()
  })

  it('does not guess unmatched or ambiguous ADF image attachments', () => {
    prepareStore()
    const duplicateOne = { id: 'duplicate-one', name: 'duplicate.png', contentUrl: null, mimeType: 'image/png', size: 16, author: user, createdAt: incomingComment.createdAt }
    const duplicateTwo = { ...duplicateOne, id: 'duplicate-two' }
    const mediaComment = {
      ...incomingComment,
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [
        { type: 'media', attrs: { id: 'unmatched-id', type: 'file', alt: 'duplicate.png' } },
        { type: 'media', attrs: { id: 'another-unmatched-id', type: 'file', alt: 'missing.png' } },
      ] }] },
    }
    useJiraMentionsStore.setState({
      selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId },
      detail: { ...detail, issue: { ...issue, attachments: [duplicateOne, duplicateTwo] }, comments: [mediaComment] },
    })
    const ipc = installMockIpc()
    render(<JiraMentions />)

    expect(screen.getAllByText('Attachment preview unavailable')).toHaveLength(2)
    expect(ipc.invoke).not.toHaveBeenCalledWith('jira-mentions:get-attachment-preview', issue.issueId, expect.any(String))
    expect(screen.getByRole('textbox', { name: /Reply to ticket/ })).toBeVisible()
  })

  it('loads image attachments inside comments and opens them in a zoom viewer', async () => {
    prepareStore()
    const attachment = {
      id: 'attachment-image-1', name: 'database-flow.png',
      contentUrl: 'https://jira.example.test/secure/attachment/attachment-image-1/database-flow.png',
      mimeType: 'image/png', size: 16, author: user, createdAt: incomingComment.createdAt,
    }
    const namedAttachment = {
      id: 'attachment-image-2', name: 'latency-chart.png',
      contentUrl: 'https://jira.example.test/secure/attachment/attachment-image-2/latency-chart.png',
      mimeType: 'image/png', size: 16, author: { ...user, accountId: 'other-author' }, createdAt: incomingComment.createdAt - 60 * 60_000,
    }
    const imageComment = {
      ...incomingComment,
      body: { type: 'doc', version: 1, content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'The connection pool is exhausted:' }] },
        { type: 'mediaSingle', attrs: { layout: 'center' }, content: [{ type: 'media', attrs: { id: 'media-service-uuid', type: 'file' } }] },
        { type: 'mediaSingle', attrs: { layout: 'center' }, content: [{ type: 'media', attrs: { id: 'another-media-service-uuid', type: 'file', alt: 'latency-chart.png' } }] },
      ] },
    }
    useJiraMentionsStore.setState({
      selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId },
      detail: { ...detail, issue: { ...issue, attachments: [attachment, namedAttachment] }, comments: [imageComment] },
    })
    const ipc = installMockIpc()
    ipc.invoke.mockImplementation(async (channel: string) => channel === 'jira-mentions:get-attachment-preview'
      ? { ok: true, mimeType: 'image/png', bytes: Uint8Array.from([137, 80, 78, 71]) }
      : projection)

    const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:jira-image-preview') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    class ImmediateIntersectionObserver {
      private callback: IntersectionObserverCallback
      constructor(callback: IntersectionObserverCallback) { this.callback = callback }
      observe(target: Element) { this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
      disconnect() {}
      unobserve() {}
      takeRecords() { return [] }
    }
    vi.stubGlobal('IntersectionObserver', ImmediateIntersectionObserver)
    let unmount = () => {}
    try {
      const rendered = render(<JiraMentions />)
      unmount = rendered.unmount
      const userEventInstance = userEvent.setup()
      const zoomButton = await screen.findByRole('button', { name: 'Zoom image database-flow.png' })
      const namedZoomButton = await screen.findByRole('button', { name: 'Zoom image latency-chart.png' })
      expect(zoomButton.querySelector('img')).toHaveAttribute('alt', 'database-flow.png')
      expect(namedZoomButton.querySelector('img')).toHaveAttribute('alt', 'latency-chart.png')
      await userEventInstance.click(zoomButton)
      expect(screen.getByRole('dialog', { name: 'Image preview: database-flow.png' })).toBeInTheDocument()
      await userEventInstance.keyboard('{Escape}')
      expect(screen.queryByRole('dialog', { name: 'Image preview: database-flow.png' })).not.toBeInTheDocument()
      await userEventInstance.click(zoomButton)
      const dialog = screen.getByRole('dialog', { name: 'Image preview: database-flow.png' })
      await userEventInstance.click(dialog)
      expect(screen.queryByRole('dialog', { name: 'Image preview: database-flow.png' })).not.toBeInTheDocument()
      await userEventInstance.click(zoomButton)
      await userEventInstance.click(screen.getByRole('button', { name: 'Close image preview' }))
      expect(screen.queryByRole('dialog', { name: 'Image preview: database-flow.png' })).not.toBeInTheDocument()
      expect(ipc.invoke).toHaveBeenNthCalledWith(1, 'jira-mentions:get-attachment-preview', issue.issueId, attachment.id)
      expect(ipc.invoke).toHaveBeenNthCalledWith(2, 'jira-mentions:get-attachment-preview', issue.issueId, namedAttachment.id)
    } finally {
      unmount()
      vi.unstubAllGlobals()
      if (createObjectUrlDescriptor) Object.defineProperty(URL, 'createObjectURL', createObjectUrlDescriptor)
      else delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL
      if (revokeObjectUrlDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeObjectUrlDescriptor)
      else delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
    }
  })

  it('previews image attachments from the attachment list in-app instead of opening Jira', async () => {
    prepareStore()
    const attachment = {
      id: 'attachment-list-image', name: 'deployment.png', contentUrl: null,
      mimeType: 'image/png', size: 12, author: user, createdAt: incomingComment.createdAt,
    }
    useJiraMentionsStore.setState({
      selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId },
      detail: { ...detail, issue: { ...issue, attachments: [attachment] } },
    })
    const imageDetail = { ...detail, issue: { ...issue, attachments: [attachment] } }
    const ipc = installMockIpc()
    ipc.invoke.mockImplementation(async (channel: string) => channel === 'jira-mentions:get-attachment-preview'
      ? { ok: true, mimeType: 'image/png', bytes: Uint8Array.from([137, 80, 78, 71]) }
      : channel === 'jira-mentions:get-issue-detail' ? imageDetail : projection)
    const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:jira-attachment-list-preview') })
    try {
      const userEventInstance = userEvent.setup()
      render(<JiraMentions />)
      const attachments = screen.getByLabelText('Attachments')
      expect(ipc.invoke).not.toHaveBeenCalledWith('jira-mentions:get-attachment-preview', issue.issueId, attachment.id)
      await userEventInstance.click(attachments.querySelector('summary')!)
      const previewRow = screen.getByLabelText('Attachment previews')
      expect(previewRow).toHaveClass('dark-scrollbar')
      expect((previewRow as HTMLElement).style.overflowX).toBe('auto')
      const zoomButton = await screen.findByRole('button', { name: 'Zoom image deployment.png' })
      expect(zoomButton.querySelector('img')).toHaveAttribute('alt', 'deployment.png')
      await userEventInstance.click(zoomButton)
      expect(screen.getByRole('dialog', { name: 'Image preview: deployment.png' })).toBeInTheDocument()
      expect(ipc.invoke).toHaveBeenCalledWith('jira-mentions:get-attachment-preview', issue.issueId, attachment.id)
      expect(ipc.invoke).not.toHaveBeenCalledWith('jira-mentions:open-attachment', issue.issueId, attachment.id)
    } finally {
      if (createObjectUrlDescriptor) Object.defineProperty(URL, 'createObjectURL', createObjectUrlDescriptor)
      else delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL
    }
  })

  it('reuses loaded image bytes across expanded comments and attachments, then drops them when the mention changes', async () => {
    prepareStore()
    const attachment = {
      id: 'shared-preview-image', name: 'shared.png', contentUrl: null,
      mimeType: 'image/png', size: 12, author: user, createdAt: earlierComment.createdAt,
    }
    const earlierImageComment = {
      ...earlierComment,
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'media', attrs: { id: attachment.id, type: 'file', alt: attachment.name } }] }] },
    }
    const imageDetail: JiraIssueSnapshot = {
      ...detail,
      issue: { ...issue, attachments: [attachment] },
      comments: [earlierImageComment, incomingComment],
    }
    useJiraMentionsStore.setState({
      selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId },
      detail: imageDetail,
    })
    const ipc = installMockIpc()
    let resolveFirstPreview!: (result: { ok: true; mimeType: string; bytes: Uint8Array }) => void
    const firstPreview = new Promise<{ ok: true; mimeType: string; bytes: Uint8Array }>((resolve) => { resolveFirstPreview = resolve })
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'jira-mentions:get-attachment-preview') {
        const callCount = ipc.invoke.mock.calls.filter(([calledChannel]) => calledChannel === 'jira-mentions:get-attachment-preview').length
        return callCount === 1 ? firstPreview : { ok: true, mimeType: 'image/png', bytes: Uint8Array.from([137, 80, 78, 71]) }
      }
      return channel === 'jira-mentions:get-issue-detail' ? imageDetail : projection
    })
    const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:jira-shared-preview') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    const observers: Array<{ intersect: () => void }> = []
    class ControlledIntersectionObserver {
      private targets: Element[] = []
      constructor(private readonly callback: IntersectionObserverCallback) {
        observers.push({ intersect: () => {
          this.callback(this.targets.map((target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry), this as unknown as IntersectionObserver)
        } })
      }
      observe(target: Element) { this.targets.push(target) }
      disconnect() { this.targets = [] }
      unobserve(target: Element) { this.targets = this.targets.filter((item) => item !== target) }
      takeRecords() { return [] }
    }
    vi.stubGlobal('IntersectionObserver', ControlledIntersectionObserver)
    try {
      const userEventInstance = userEvent.setup()
      render(<JiraMentions />)
      expect(ipc.invoke).not.toHaveBeenCalledWith('jira-mentions:get-attachment-preview', issue.issueId, attachment.id)

      await act(async () => { observers.forEach((observer) => observer.intersect()) })
      expect(ipc.invoke.mock.calls.filter(([channel]) => channel === 'jira-mentions:get-attachment-preview')).toHaveLength(1)
      await userEventInstance.click(screen.getByLabelText('Attachments').querySelector('summary')!)
      await screen.findByText('Loading preview…')
      await act(async () => { observers.forEach((observer) => observer.intersect()) })
      expect(ipc.invoke.mock.calls.filter(([channel]) => channel === 'jira-mentions:get-attachment-preview')).toHaveLength(1)
      await act(async () => { resolveFirstPreview({ ok: true, mimeType: 'image/png', bytes: Uint8Array.from([137, 80, 78, 71]) }) })
      await waitFor(() => expect(screen.getAllByRole('button', { name: 'Zoom image shared.png' })).toHaveLength(2))
      expect(ipc.invoke.mock.calls.filter(([channel]) => channel === 'jira-mentions:get-attachment-preview')).toHaveLength(1)

      useJiraMentionsStore.setState({
        projection: projectionWithSecondComment,
        selected: { issueId: issue.issueId, incomingCommentId: secondIncomingComment.commentId },
        detail: { ...imageDetail, comments: [earlierImageComment, incomingComment, secondIncomingComment] },
      })
      await waitFor(() => expect(ipc.invoke.mock.calls.filter(([channel]) => channel === 'jira-mentions:get-attachment-preview')).toHaveLength(2))
    } finally {
      vi.unstubAllGlobals()
      if (createObjectUrlDescriptor) Object.defineProperty(URL, 'createObjectURL', createObjectUrlDescriptor)
      else delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL
      if (revokeObjectUrlDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeObjectUrlDescriptor)
      else delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
    }
  })

  it('discards an inline image preview that resolves after the selected mention changes', async () => {
    prepareStore()
    const attachment = { id: 'slow-preview', name: 'slow.png', contentUrl: null, mimeType: 'image/png', size: 16, author: user, createdAt: incomingComment.createdAt }
    const imageComment = {
      ...incomingComment,
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'media', attrs: { id: attachment.id, type: 'file', alt: attachment.name } }] }] },
    }
    const imageDetail: JiraIssueSnapshot = { ...detail, issue: { ...issue, attachments: [attachment] }, comments: [imageComment] }
    const otherIssue = { ...issue, issueId: 'issue-other', issueKey: 'APP-2', summary: 'Second issue' }
    const otherComment = { ...secondIncomingComment, issueId: otherIssue.issueId }
    const otherItem = {
      ...projection.items[0], issue: otherIssue, comment: otherComment,
      state: { ...projection.items[0].state, issueId: otherIssue.issueId, incomingCommentId: otherComment.commentId },
    }
    const otherProjection: JiraMentionsProjection = { ...projection, activeCount: 2, items: [projection.items[0], otherItem] }
    const otherDetail: JiraIssueSnapshot = { ...detail, issue: otherIssue, comments: [otherComment] }
    useJiraMentionsStore.setState({ selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId }, detail: imageDetail })
    let resolvePreview!: (result: { ok: true; mimeType: string; bytes: Uint8Array }) => void
    const pendingPreview = new Promise<{ ok: true; mimeType: string; bytes: Uint8Array }>((resolve) => { resolvePreview = resolve })
    const ipc = installMockIpc()
    ipc.invoke.mockImplementation(async (channel: string) => channel === 'jira-mentions:get-attachment-preview'
      ? pendingPreview
      : channel === 'jira-mentions:get-issue-detail' ? otherDetail : otherProjection)
    const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    const createObjectUrl = vi.fn(() => 'blob:stale-preview')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    class ImmediateIntersectionObserver {
      private readonly callback: IntersectionObserverCallback
      constructor(callback: IntersectionObserverCallback) { this.callback = callback }
      observe(target: Element) { this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
      disconnect() {}
      unobserve() {}
      takeRecords() { return [] }
    }
    vi.stubGlobal('IntersectionObserver', ImmediateIntersectionObserver)
    try {
      render(<JiraMentions />)
      await screen.findByText('Loading image preview: slow.png')
      expect(ipc.invoke).toHaveBeenCalledWith('jira-mentions:get-attachment-preview', issue.issueId, attachment.id)

      act(() => useJiraMentionsStore.setState({
        projection: otherProjection,
        selected: { issueId: otherIssue.issueId, incomingCommentId: otherComment.commentId },
        detail: otherDetail,
      }))
      await waitFor(() => expect(screen.queryByText('Loading image preview: slow.png')).not.toBeInTheDocument())
      await act(async () => { resolvePreview({ ok: true, mimeType: 'image/png', bytes: Uint8Array.from([137, 80, 78, 71]) }) })

      expect(createObjectUrl).not.toHaveBeenCalled()
      expect(screen.queryByRole('button', { name: 'Zoom image slow.png' })).not.toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'Second issue' })).toBeInTheDocument()
      expect(screen.getByRole('textbox', { name: /Reply to ticket/ })).toBeVisible()
    } finally {
      vi.unstubAllGlobals()
      if (createObjectUrlDescriptor) Object.defineProperty(URL, 'createObjectURL', createObjectUrlDescriptor)
      else delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL
      if (revokeObjectUrlDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeObjectUrlDescriptor)
      else delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
    }
  })

  it.each([
    ['unavailable', 'Image preview unavailable: fallback.png'],
    ['too_large', 'Image is too large to preview: fallback.png'],
    ['unsupported', 'Image format cannot be previewed: fallback.png'],
    ['rejected', 'Image preview unavailable: fallback.png'],
  ] as const)('shows an actionable %s inline image fallback while keeping reply available', async (outcome, message) => {
    prepareStore()
    const attachment = { id: `fallback-${outcome}`, name: 'fallback.png', contentUrl: null, mimeType: 'image/png', size: 16, author: user, createdAt: incomingComment.createdAt }
    const imageComment = {
      ...incomingComment,
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'media', attrs: { id: attachment.id, type: 'file', alt: attachment.name } }] }] },
    }
    useJiraMentionsStore.setState({
      selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId },
      detail: { ...detail, issue: { ...issue, attachments: [attachment] }, comments: [imageComment] },
    })
    const ipc = installMockIpc()
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'jira-mentions:get-attachment-preview') {
        if (outcome === 'rejected') throw new Error('synthetic preview failure')
        return { ok: false, reason: outcome }
      }
      return projection
    })
    class ImmediateIntersectionObserver {
      private readonly callback: IntersectionObserverCallback
      constructor(callback: IntersectionObserverCallback) { this.callback = callback }
      observe(target: Element) { this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
      disconnect() {}
      unobserve() {}
      takeRecords() { return [] }
    }
    vi.stubGlobal('IntersectionObserver', ImmediateIntersectionObserver)
    try {
      render(<JiraMentions />)
      expect(await screen.findByText(message)).toBeVisible()
      expect(screen.queryByRole('button', { name: 'Zoom image fallback.png' })).not.toBeInTheDocument()
      const editor = screen.getByRole('textbox', { name: /Reply to ticket/ })
      await userEvent.setup().type(editor, 'Reply remains editable')
      expect(editor).toHaveValue('Reply remains editable')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('shows actionable validation feedback without displaying an internal error code', () => {
    prepareStore()
    useJiraMentionsStore.setState({
      selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId },
      detail,
      lastReplyResult: { ok: false, outcome: 'rejected', errorCode: 'validation' },
    })
    render(<JiraMentions />)

    expect(screen.getByRole('status')).toHaveTextContent('Jira rejected the reply content or format. Edit the reply and try again.')
    expect(screen.queryByText(/validation/)).not.toBeInTheDocument()
  })

  it('keeps drafts through view unmounts and clears them at an identity boundary', async () => {
    prepareStore()
    const ipc = installMockIpc()
    ipc.invoke.mockResolvedValue(detail)
    const userEventInstance = userEvent.setup()
    const first = render(<JiraMentions />)
    await userEventInstance.click(screen.getByRole('button', { name: /Requester/ }))
    const editor = await screen.findByRole('textbox', { name: /Reply to ticket/ })
    await userEventInstance.type(editor, 'Draft for later')
    first.unmount()

    render(<JiraMentions />)
    expect(await screen.findByRole('textbox', { name: /Reply to ticket/ })).toHaveValue('Draft for later')
    useJiraMentionsStore.getState().receiveProjection({ ...projection, identityVerified: false, enabled: false, items: [] })
    expect(useJiraMentionsStore.getState().drafts).toEqual({})
  })
})
