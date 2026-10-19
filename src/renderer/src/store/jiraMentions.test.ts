import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockIpc, installMockIpc } from '../../../../tests/mockIpc'
import type { JiraIssueSnapshot, JiraMentionsProjection, JiraUserReference } from '../../../shared/jiraMentions'
import { useJiraMentionsStore } from './jiraMentions'

const firstItem = {
  issue: { issueId: '100', issueKey: 'APP-1', summary: 'First issue' },
  comment: { commentId: 'comment-1', issueId: '100', excerpt: 'First request' },
  state: { state: 'unanswered' },
  action: null,
  authors: [],
}
const secondItem = {
  issue: { issueId: '200', issueKey: 'APP-2', summary: 'Second issue' },
  comment: { commentId: 'comment-2', issueId: '200', excerpt: 'Second request' },
  state: { state: 'unanswered' },
  action: null,
  authors: [],
}

function projection(status: JiraMentionsProjection['status'], lastAttemptAt: number | null, items = [firstItem]): JiraMentionsProjection {
  return {
    enabled: true,
    identityVerified: true,
    status,
    errorCode: null,
    activeCount: items.length,
    lastAttemptAt,
    lastSuccessAt: 100,
    historyFrom: 0,
    coverageThrough: 100,
    cached: true,
    items,
  } as unknown as JiraMentionsProjection
}

function detail(accountId: string, marker?: string): JiraIssueSnapshot {
  const user: JiraUserReference = {
    accountId,
    displayName: accountId,
    sources: ['field:customfield_10001', ...(marker ? [marker] : [])],
  }
  return {
    issue: { issueId: accountId === 'first' ? '100' : '200', issueKey: accountId === 'first' ? 'APP-1' : 'APP-2' },
    comments: [],
    users: [user],
    observedCommentCount: 0,
    commentsComplete: true,
    updatedMarker: null,
  } as unknown as JiraIssueSnapshot
}

const replyFeedback = { ok: false, outcome: 'rejected', errorCode: 'send_failed' } as const

afterEach(() => {
  useJiraMentionsStore.getState().clearSelection()
  useJiraMentionsStore.setState({
    projection: projection('not-configured', null, []),
    drafts: {},
    lastReplyResult: null,
    detailLoading: false,
  })
  vi.restoreAllMocks()
})

describe('useJiraMentionsStore detail refresh reconciliation', () => {
  it('reloads the selected detail after startup catalog readiness when open-if-stale returned early', async () => {
    const ipc = installMockIpc(createMockIpc())
    const loading = projection('loading', 200)
    const terminal = projection('ready', 200)
    const staleDetail = detail('first')
    const labeledDetail = detail('first', 'field-name:dev tester')
    let detailReads = 0
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'jira-mentions:get-issue-detail') return ++detailReads === 1 ? staleDetail : labeledDetail
      if (channel === 'jira-mentions:refresh') return loading
      return undefined
    })

    useJiraMentionsStore.setState({ projection: projection('ready', 100) })
    useJiraMentionsStore.getState().receiveProjection(loading)
    await useJiraMentionsStore.getState().select('100', 'comment-1')
    useJiraMentionsStore.getState().saveDraft('100\0comment-1', { text: 'Keep this draft', mentions: [] })
    useJiraMentionsStore.setState({ lastReplyResult: replyFeedback })
    expect(useJiraMentionsStore.getState().detail).toBe(staleDetail)

    await useJiraMentionsStore.getState().refresh('open-if-stale')
    expect(detailReads).toBe(1)
    useJiraMentionsStore.getState().receiveProjection(terminal)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(detailReads).toBe(2)
    expect(useJiraMentionsStore.getState().detail).toBe(labeledDetail)
    expect(useJiraMentionsStore.getState().selected).toEqual({ issueId: '100', incomingCommentId: 'comment-1' })
    expect(useJiraMentionsStore.getState().drafts['100\0comment-1']).toEqual({ text: 'Keep this draft', mentions: [] })
    expect(useJiraMentionsStore.getState().lastReplyResult).toBe(replyFeedback)

    useJiraMentionsStore.getState().receiveProjection(terminal)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(detailReads).toBe(2)
    expect(ipc.invoke.mock.calls.filter(([channel]) => channel === 'jira-mentions:get-issue-detail')).toHaveLength(2)
    expect(ipc.invoke.mock.calls.filter(([channel]) => channel === 'jira-mentions:refresh')).toEqual([
      ['jira-mentions:refresh', 'open-if-stale'],
    ])
  })

  it('reconciles only the current selection and discards old reads after selection changes or clears', async () => {
    const ipc = installMockIpc(createMockIpc())
    let resolveFirst!: (value: JiraIssueSnapshot) => void
    let detailReads = 0
    ipc.invoke.mockImplementation((channel: string, issueId: string) => {
      if (channel !== 'jira-mentions:get-issue-detail') return Promise.resolve(undefined)
      detailReads++
      if (detailReads === 1) return new Promise<JiraIssueSnapshot>((resolve) => { resolveFirst = resolve })
      return Promise.resolve(detail(issueId === '100' ? 'first' : 'second', `read-${detailReads}`))
    })

    const loading = projection('loading', 300, [firstItem, secondItem])
    const terminal = projection('ready', 300, [firstItem, secondItem])
    useJiraMentionsStore.getState().receiveProjection(loading)
    const firstRead = useJiraMentionsStore.getState().select('100', 'comment-1')
    await useJiraMentionsStore.getState().select('200', 'comment-2')
    useJiraMentionsStore.getState().receiveProjection(terminal)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(detailReads).toBe(3)
    expect(ipc.invoke.mock.calls.filter(([channel]) => channel === 'jira-mentions:get-issue-detail').map(([, issueId]) => issueId))
      .toEqual(['100', '200', '200'])
    const currentDetail = useJiraMentionsStore.getState().detail
    expect(currentDetail?.users[0].sources).toContain('read-3')
    resolveFirst(detail('first', 'late-old-response'))
    await firstRead
    expect(useJiraMentionsStore.getState().detail).toBe(currentDetail)

    useJiraMentionsStore.getState().clearSelection()
    useJiraMentionsStore.getState().receiveProjection(projection('loading', 400, [firstItem]))
    await useJiraMentionsStore.getState().select('100', 'comment-1')
    const readsBeforeClear = detailReads
    useJiraMentionsStore.getState().clearSelection()
    useJiraMentionsStore.getState().receiveProjection(projection('ready', 400, [firstItem]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(detailReads).toBe(readsBeforeClear)
  })
})
