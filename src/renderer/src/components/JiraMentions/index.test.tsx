import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  it('grows the reply editor with its content and caps its height for long drafts', async () => {
    prepareStore()
    useJiraMentionsStore.setState({
      selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId },
      detail,
    })
    render(<JiraMentions />)

    const editor = screen.getByRole('textbox', { name: 'Reply' }) as HTMLTextAreaElement
    let contentHeight = 0
    Object.defineProperty(editor, 'scrollHeight', { configurable: true, get: () => contentHeight })
    expect(editor.style.height).toBe('95px')

    contentHeight = 184
    await userEvent.setup().type(editor, 'A longer reply draft')
    await waitFor(() => expect(editor.style.height).toBe('184px'))

    contentHeight = 360
    await userEvent.setup().type(editor, ' with more context')
    await waitFor(() => {
      expect(editor.style.height).toBe('300px')
      expect(editor.style.overflowY).toBe('auto')
    })
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
    expect(search.parentElement).toBe(filter.parentElement)
    expect(search.parentElement).toBe(refresh.parentElement)
  })

  it('uses the app text-field focus treatment for search and reply', () => {
    prepareStore()
    useJiraMentionsStore.setState({
      selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId },
      detail,
    })
    render(<JiraMentions />)

    const search = screen.getByRole('textbox', { name: 'Search Jira mentions' })
    const reply = screen.getByRole('textbox', { name: 'Reply' })
    expect(search).toHaveStyle({ outline: 'none', caretColor: ui.color.accent })
    expect(reply).toHaveStyle({ outline: 'none', caretColor: ui.color.accent })
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

  it('opens the selected issue through the main-owned Jira link and disables replies to unsupported audiences', async () => {
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
    const reply = screen.getByRole('textbox', { name: 'Reply' })
    expect(reply).toBeDisabled()
    expect(reply).toHaveAttribute('placeholder', 'Open this issue in Jira to reply to this audience.')
    expect(screen.getByRole('button', { name: 'Post reply' })).toBeDisabled()

    expect(screen.getByRole('button', { name: 'Open APP-1 in Jira' }).style.color).toBe(ui.color.accent)
    expect(screen.getByRole('button', { name: 'Open issue APP-1 in Jira' }).style.color).toBe(ui.color.accent)
    await userEventInstance.click(screen.getByRole('button', { name: 'Open APP-1 in Jira' }))
    expect(ipc.invoke).toHaveBeenCalledWith('jira:open-issue', 'APP-1')
    await userEventInstance.click(screen.getByRole('button', { name: 'Open issue APP-1 in Jira' }))
    expect(ipc.invoke.mock.calls.filter(([channel]) => channel === 'jira:open-issue')).toHaveLength(2)
    expect(ipc.invoke).not.toHaveBeenCalledWith('jira:open-issue', expect.stringMatching(/^https?:/))
    expect(screen.queryByRole('button', { name: 'A test issue' })).not.toBeInTheDocument()
  })

  it('shows the complete comment history without nested scrolling and keeps reply above it', () => {
    prepareStore()
    useJiraMentionsStore.setState({
      selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId },
      detail: { ...detail, comments: [earlierComment, incomingComment, laterComment] },
    })
    render(<JiraMentions />)

    const reply = screen.getByRole('region', { name: 'Reply composer' })
    const history = screen.getByRole('region', { name: 'Comment history' })
    expect(screen.getByText('Earlier context')).toBeVisible()
    expect(screen.getByText('Later context')).toBeVisible()
    expect(reply.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(history.querySelector('.dark-scrollbar')).toBeNull()
    expect(screen.queryByRole('separator', { name: /Resize (earlier|later|selected mention)/ })).not.toBeInTheDocument()
    const selectedMention = screen.getByRole('region', { name: 'Selected mention' }) as HTMLElement
    expect(selectedMention.style.height).toBe('')
    expect(selectedMention.style.overflow).toBe('')
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
    const editor = await screen.findByRole('textbox', { name: 'Reply' }) as HTMLTextAreaElement
    await userEventInstance.type(editor, 'I will check @ tomorrow.')
    const insertionPoint = 'I will check @'.length
    editor.focus()
    editor.setSelectionRange(insertionPoint, insertionPoint)
    expect(editor.selectionStart).toBe(insertionPoint)
    await userEventInstance.type(editor, 'R', { skipClick: true })
    await userEventInstance.keyboard('{ArrowDown}{Enter}')
    expect(editor).toHaveValue('I will check @Requester tomorrow.')
    await userEventInstance.click(screen.getByRole('button', { name: 'Post reply' }))

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
    let editor = await screen.findByRole('textbox', { name: 'Reply' })
    await userEventInstance.type(editor, 'Ping @Req')
    await userEventInstance.keyboard('{ArrowDown}{Enter}')
    expect(editor).toHaveValue('Ping @Requester')

    await userEventInstance.click(screen.getByRole('button', { name: /Second request/ }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Reply' })).toHaveValue(''))
    await userEventInstance.click(screen.getByRole('button', { name: /Can you take a look/ }))
    editor = await screen.findByRole('textbox', { name: 'Reply' })
    await waitFor(() => expect(editor).toHaveValue('Ping @Requester'))

    await userEventInstance.click(screen.getByRole('button', { name: 'Post reply' }))
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
    let editor = await screen.findByRole('textbox', { name: 'Reply' })
    await userEventInstance.type(editor, 'Draft for first request')

    await userEventInstance.click(screen.getByRole('button', { name: /Second request/ }))
    editor = await screen.findByRole('textbox', { name: 'Reply' })
    await waitFor(() => expect(editor).toHaveValue(''))
    await userEventInstance.type(editor, 'Draft for second request')

    await userEventInstance.click(screen.getByRole('button', { name: /Can you take a look/ }))
    editor = await screen.findByRole('textbox', { name: 'Reply' })
    await waitFor(() => expect(editor).toHaveValue('Draft for first request'))
    await userEventInstance.click(screen.getByRole('button', { name: /Second request/ }))
    editor = await screen.findByRole('textbox', { name: 'Reply' })
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
    const editor = await screen.findByRole('textbox', { name: 'Reply' })
    await userEventInstance.type(editor, 'Please review this change.')
    await userEventInstance.click(screen.getByRole('button', { name: 'Post reply' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Jira rejected the reply. Check its text and selected mentions, then try again.')
    expect(editor).toHaveValue('Please review this change.')
  })

  it.each([
    ['auth', 'Update the Jira credentials in Settings, then try again.'],
    ['permission', 'Jira denied comment access. Open the issue in Jira or ask an administrator for Add comments permission.'],
    ['invalid_recipient', 'Choose reply recipients from this issue’s mention suggestions.'],
    ['rate_limited', 'Jira is limiting replies. Wait before trying again.'],
    ['network', 'The reply could not be sent. Check the connection and refresh before trying again.'],
  ] as const)('keeps the draft and gives actionable feedback after a %s reply failure', async (errorCode, message) => {
    prepareStore()
    useJiraMentionsStore.setState({
      selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId },
      detail,
      lastReplyResult: { ok: false, outcome: 'rejected', errorCode },
    })
    const userEventInstance = userEvent.setup()
    render(<JiraMentions />)

    const editor = screen.getByRole('textbox', { name: 'Reply' })
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

    expect(screen.getByText('A test issue')).toBeInTheDocument()
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
    const editor = await screen.findByRole('textbox', { name: 'Reply' })
    await userEventInstance.type(editor, 'Ask @')
    await userEventInstance.keyboard('{ArrowDown}{Enter}')
    expect(editor).toHaveValue('Ask @Requester')
    await userEventInstance.keyboard('{Backspace}')
    expect(editor).toHaveValue('Ask ')
    await userEventInstance.click(screen.getByRole('button', { name: 'Post reply' }))

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
      comments: [earlierComment, earlierNewerComment, incomingComment, laterComment, laterNewerComment],
      issue: {
        ...issue,
        statusName: 'In Progress', statusCategory: 'In Progress', priority: 'High', issueType: 'Bug',
        assignee: { accountId: 'assignee-id', displayName: 'Morgan', sources: ['assignee'] },
        reporter: { accountId: 'reporter-id', displayName: 'Taylor', sources: ['reporter'] },
        updatedAt: Date.parse('2026-10-16T12:00:00Z'),
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
    const issueBadges = await screen.findByLabelText('Issue details')
    expect(issueBadges).toHaveTextContent('High')
    expect(issueBadges).toHaveTextContent('In Progress')
    expect(issueBadges).toHaveTextContent('Bug')
    expect(issueBadges).toHaveTextContent('Assignee Morgan')
    const statusChip = issueBadges.querySelector('[data-property="status"]') as HTMLElement
    const typeChip = issueBadges.querySelector('[data-property="type"]') as HTMLElement
    const priorityValue = issueBadges.querySelector('[data-property="priority"]') as HTMLElement
    const assigneeValue = issueBadges.querySelector('[data-property="assignee"]') as HTMLElement
    expect(statusChip).toHaveAttribute('data-category', 'in-progress')
    expect(statusChip).toHaveTextContent(/^In Progress$/)
    expect(statusChip.style.background).toBe(ui.color.jiraStatusProgressBackground)
    expect(statusChip.style.color).toBe(ui.color.jiraStatusProgress)
    expect(typeChip).toHaveTextContent(/^Bug$/)
    expect(typeChip.style.background).toBe(ui.color.jiraIssueTypeBackground)
    expect(typeChip.style.color).toBe(ui.color.jiraIssueType)
    expect(typeChip.style.border).toBe(`1px solid ${ui.color.jiraIssueTypeBorder}`)
    expect(priorityValue).toHaveTextContent(/^High$/)
    expect(priorityValue.style.color).toBe(ui.color.jiraPriority)
    expect(priorityValue.style.borderLeft).toBe(`1px solid ${ui.color.border}`)
    expect(assigneeValue.style.background).toBe('')
    const issueFacts = screen.getByLabelText('Issue facts')
    expect(issueFacts).toHaveTextContent('Reporter Taylor')
    expect(issueFacts).toHaveTextContent('Updated')
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
        attachments: [{ id: 'attachment-1', name: 'unlinked.txt', contentUrl: null, mimeType: 'text/plain', size: 100, author: null, createdAt: null }],
      },
    }
    useJiraMentionsStore.setState({ selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId }, detail: detailWithoutAttachmentLinks })
    render(<JiraMentions />)

    const issueBadges = screen.getByLabelText('Issue details')
    expect(screen.getByLabelText('Status Open')).toBeInTheDocument()
    expect(issueBadges).not.toHaveTextContent('Priority')
    expect(issueBadges).not.toHaveTextContent('Assignee')
    expect(screen.queryByLabelText('Issue facts')).not.toBeInTheDocument()
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
    const editor = screen.getByRole('textbox', { name: 'Reply' })
    const history = screen.getByRole('region', { name: 'Comment history' })
    const composer = screen.getByRole('region', { name: 'Reply composer' })
    expect(history).toContainElement(comment)
    expect(history).not.toContainElement(editor)
    expect(history.style.borderRadius).toBe('7px')
    expect(composer.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const snooze = screen.getByRole('button', { name: 'Snooze' })
    const dismiss = screen.getByRole('button', { name: 'Dismiss' })
    const commentHeader = history.firstElementChild
    expect(snooze.parentElement).toBe(commentHeader)
    expect(dismiss.parentElement).toBe(commentHeader)
    expect(commentHeader?.textContent).toContain('Requester')
    expect(commentHeader?.textContent).toContain('2026')
    expect(editor).toHaveAttribute('placeholder', 'Write a reply')
    expect(screen.queryByPlaceholderText(/Type @/)).not.toBeInTheDocument()
  })

  it('shows the snooze wake-up in local time and submits the same instant after a zone change', async () => {
    vi.stubEnv('TZ', 'America/Chicago')
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
    const { rerender } = render(<JiraMentions />)

    await userEventInstance.click(screen.getByRole('button', { name: /Requester/ }))
    await screen.findByRole('textbox', { name: 'Reply' })
    await userEventInstance.click(screen.getByRole('button', { name: 'Snooze' }))
    const option = screen.getByRole('menuitem', { name: /2 hours/ })
    const snoozeUntil = now + 2 * 60 * 60 * 1000
    const chicagoLabel = new Date(snoozeUntil).toLocaleString()
    expect(option.querySelector('span')?.textContent).toBe(chicagoLabel)
    await userEventInstance.click(option)
    await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith('jira-mentions:set-action', expect.objectContaining({
      issueId: issue.issueId, incomingCommentId: incomingComment.commentId, action: 'snoozed', snoozeUntil,
    })))

    vi.stubEnv('TZ', 'America/Los_Angeles')
    rerender(<JiraMentions />)
    await userEventInstance.click(screen.getByRole('button', { name: 'Snooze' }))
    const sameInstantOption = screen.getByRole('menuitem', { name: /2 hours/ })
    const losAngelesLabel = new Date(snoozeUntil).toLocaleString()
    expect(losAngelesLabel).not.toBe(chicagoLabel)
    expect(sameInstantOption.querySelector('span')?.textContent).toBe(losAngelesLabel)
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

    const renderedDescription = container.querySelector('p')?.textContent ?? ''
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
    expect(descriptionSection.style.borderTop).toBe(`1px solid ${ui.color.border}`)
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
    const automaticMaxHeight = Math.min(360, Math.floor((detailViewport.clientHeight - Number.parseFloat(window.getComputedStyle(detailViewport).paddingTop) - Number.parseFloat(window.getComputedStyle(detailViewport).paddingBottom)) * 0.35))
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
    ipc.invoke.mockImplementation(async (channel: string) => channel === 'jira-mentions:get-attachment-preview'
      ? { ok: true, mimeType: 'image/png', bytes: Uint8Array.from([137, 80, 78, 71]) }
      : channel === 'jira-mentions:get-issue-detail' ? imageDetail : projection)
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
      await screen.findByRole('button', { name: 'Zoom image shared.png' })
      expect(ipc.invoke.mock.calls.filter(([channel]) => channel === 'jira-mentions:get-attachment-preview')).toHaveLength(1)

      await userEventInstance.click(screen.getByLabelText('Attachments').querySelector('summary')!)
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

  it('shows actionable validation feedback without displaying an internal error code', () => {
    prepareStore()
    useJiraMentionsStore.setState({
      selected: { issueId: issue.issueId, incomingCommentId: incomingComment.commentId },
      detail,
      lastReplyResult: { ok: false, outcome: 'rejected', errorCode: 'validation' },
    })
    render(<JiraMentions />)

    expect(screen.getByRole('status')).toHaveTextContent('Jira rejected the reply. Check its text and selected mentions, then try again.')
    expect(screen.queryByText(/validation/)).not.toBeInTheDocument()
  })

  it('keeps drafts through view unmounts and clears them at an identity boundary', async () => {
    prepareStore()
    const ipc = installMockIpc()
    ipc.invoke.mockResolvedValue(detail)
    const userEventInstance = userEvent.setup()
    const first = render(<JiraMentions />)
    await userEventInstance.click(screen.getByRole('button', { name: /Requester/ }))
    const editor = await screen.findByRole('textbox', { name: 'Reply' })
    await userEventInstance.type(editor, 'Draft for later')
    first.unmount()

    render(<JiraMentions />)
    expect(await screen.findByRole('textbox', { name: 'Reply' })).toHaveValue('Draft for later')
    useJiraMentionsStore.getState().receiveProjection({ ...projection, identityVerified: false, enabled: false, items: [] })
    expect(useJiraMentionsStore.getState().drafts).toEqual({})
  })
})
