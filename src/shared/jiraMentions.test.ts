import { describe, expect, it, vi } from 'vitest'
import {
  classifyJiraIssueMentions,
  extractAdfPlainText,
  extractMentionAccountIds,
  buildReplyAdf,
  getQuickSnoozeUntil,
  orderMentionItems,
  type JiraCommentRecord,
  type JiraMentionProjectionItem,
  type PriorJiraMentionEvidence,
} from './jiraMentions'

const self = 'self-id'
const alice = 'alice-id'
const bob = 'bob-id'
const historyFrom = 1_000
const trackingStartedAt = 2_000

function mention(accountId: string, name: string): unknown {
  return { type: 'mention', attrs: { id: accountId, text: `@${name}` } }
}

function body(...content: unknown[]): unknown {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content }] }
}

function comment(
  commentId: string,
  authorAccountId: string | null,
  createdAt: number,
  content: unknown,
  updatedAt = createdAt,
): JiraCommentRecord {
  return {
    commentId,
    issueId: 'issue-1',
    authorAccountId,
    authorDisplayName: authorAccountId,
    createdAt,
    updatedAt,
    body: content,
    excerpt: '',
    visibility: null,
    availability: 'visible',
  }
}

describe('Jira mention rules', () => {
  it('deduplicates account IDs and does not infer mentions from ordinary text', () => {
    const structured = body(
      { type: 'text', text: 'Please ask Self Name ' },
      mention(self, 'Self Name'),
      mention(self, 'Self Name'),
    )
    expect(extractMentionAccountIds(structured)).toEqual([self])
    expect(extractMentionAccountIds(body({ type: 'text', text: '@Self Name' }))).toEqual([])
    expect(extractAdfPlainText(structured)).toBe('Please ask Self Name @Self Name@Self Name')
  })

  it('resolves only earlier same-issue requests from authors named by a later self reply', () => {
    const comments = [
      comment('a1', alice, 1_100, body(mention(self, 'Self'))),
      comment('a2', alice, 1_200, body({ type: 'text', text: 'second request' })),
      comment('b1', bob, 1_300, body(mention(self, 'Self'))),
      comment('reply-a', self, 1_400, body(mention(alice, 'Alice'))),
      comment('a3', alice, 1_500, body(mention(self, 'Self'))),
      comment('plain', bob, 1_600, body({ type: 'text', text: 'Self Name, please respond' })),
    ]
    const classified = classifyJiraIssueMentions({ comments, selfAccountId: self, historyFrom, trackingStartedAt, observedAt: 3_000 })
    expect(classified.map(({ comment: source, state }) => [source.commentId, state])).toEqual([
      ['a1', 'answered'],
      ['b1', 'unanswered'],
      ['a3', 'unanswered'],
    ])
    expect(classified.find((entry) => entry.comment.commentId === 'a1')?.resolvingCommentId).toBe('reply-a')
  })

  it('does not resolve Alice when the self comment does not mention her', () => {
    const classified = classifyJiraIssueMentions({
      comments: [
        comment('alice-request', alice, 1_100, body(mention(self, 'Self'))),
        comment('self-unrelated', self, 1_200, body({ type: 'text', text: 'I will take a look.' })),
      ],
      selfAccountId: self, historyFrom, trackingStartedAt, observedAt: 3_000,
    })

    expect(classified).toMatchObject([{ comment: { commentId: 'alice-request' }, state: 'unanswered', resolvingCommentId: null }])
  })

  it('keeps a previously tracked mention unknown when a complete snapshot loses its author ID', () => {
    const prior = new Map<string, PriorJiraMentionEvidence>([
      ['tracked', { eligibility: 'new', sourceUpdatedAt: 1_100, previouslyMentionedSelf: true, firstObservedAt: 1_050 }],
    ])
    const missingAuthor = comment('tracked', null, 1_100, body(mention(self, 'Self')), 1_300)
    const classified = classifyJiraIssueMentions({
      comments: [missingAuthor], selfAccountId: self, historyFrom, trackingStartedAt, observedAt: 3_000, previous: prior,
    })

    expect(classified).toMatchObject([{
      comment: { commentId: 'tracked', authorAccountId: null },
      eligibility: 'new',
      firstObservedAt: 1_050,
      state: 'unknown',
      resolvingCommentId: null,
    }])
  })

  it('keeps Bob open after an Alice-only reply and resolves both authors when both are mentioned', () => {
    const aliceRequest = { ...comment('alice-request', alice, 1_100, body(mention(self, 'Self'))), authorDisplayName: 'Alex' }
    const bobRequest = { ...comment('bob-request', bob, 1_200, body(mention(self, 'Self'))), authorDisplayName: 'Alex' }
    const aliceReply = comment('alice-reply', self, 1_300, body(mention(alice, 'Alex')))
    const bothReply = comment('both-reply', self, 1_400, body(mention(alice, 'Alex'), mention(bob, 'Alex')))

    const aliceOnly = classifyJiraIssueMentions({
      comments: [aliceRequest, bobRequest, aliceReply], selfAccountId: self, historyFrom, trackingStartedAt, observedAt: 3_000,
    })
    expect(aliceOnly.map(({ comment: source, state }) => [source.commentId, state])).toEqual([
      ['alice-request', 'answered'], ['bob-request', 'unanswered'],
    ])

    const bothAuthors = classifyJiraIssueMentions({
      comments: [aliceRequest, bobRequest, aliceReply, bothReply], selfAccountId: self, historyFrom, trackingStartedAt, observedAt: 3_000,
    })
    expect(bothAuthors.map(({ comment: source, state }) => [source.commentId, state])).toEqual([
      ['alice-request', 'answered'], ['bob-request', 'answered'],
    ])
    expect(bothAuthors.find(({ comment: source }) => source.commentId === 'bob-request')?.resolvingCommentId).toBe('both-reply')
  })

  it('uses creation time for strict ordering and keeps an edited source answered', () => {
    const source = comment('source', alice, 1_100, body(mention(self, 'Self')), 2_500)
    const equalTimeReply = comment('tie', self, 1_100, body(mention(alice, 'Alice')))
    const beforeReply = classifyJiraIssueMentions({
      comments: [source, equalTimeReply], selfAccountId: self, historyFrom, trackingStartedAt, observedAt: 3_000,
    })
    expect(beforeReply[0].state).toBe('unanswered')

    const laterReply = comment('later', self, 1_200, body(mention(alice, 'Alice')))
    const afterReply = classifyJiraIssueMentions({
      comments: [source, laterReply], selfAccountId: self, historyFrom, trackingStartedAt, observedAt: 3_000,
    })
    expect(afterReply[0]).toMatchObject({ state: 'answered', comment: { createdAt: 1_100, updatedAt: 2_500 } })
  })

  it('accepts later mention edits while excluding old comments first seen before tracking', () => {
    const old = comment('old', alice, 100, body(mention(self, 'Self')), 2_100)
    const prior = new Map<string, PriorJiraMentionEvidence>([
      ['old', { eligibility: 'excluded', sourceUpdatedAt: 1_900, previouslyMentionedSelf: false, firstObservedAt: 1_900 }],
    ])
    const edited = classifyJiraIssueMentions({
      comments: [old], selfAccountId: self, historyFrom, trackingStartedAt, observedAt: 2_200, previous: prior,
    })
    expect(edited[0]).toMatchObject({ eligibility: 'edit', eligibleEditAt: 2_100, state: 'unanswered' })

    const previouslyKnownMention = new Map<string, PriorJiraMentionEvidence>([
      ['old', { eligibility: 'excluded', sourceUpdatedAt: 1_900, previouslyMentionedSelf: true, firstObservedAt: 1_900 }],
    ])
    const unrelatedEdit = classifyJiraIssueMentions({
      comments: [old], selfAccountId: self, historyFrom, trackingStartedAt, observedAt: 2_200, previous: previouslyKnownMention,
    })
    expect(unrelatedEdit).toMatchObject([{ eligibility: 'excluded', state: 'removed' }])

    const firstSeen = classifyJiraIssueMentions({
      comments: [old], selfAccountId: self, historyFrom, trackingStartedAt, observedAt: 2_200,
    })
    expect(firstSeen[0]).toMatchObject({ eligibility: 'ambiguous_edit', state: 'unanswered' })
  })

  it('serializes reply tokens as plain text and structured ADF mentions', () => {
    expect(buildReplyAdf([
      { kind: 'text', id: 't1', text: 'Thanks ' },
      { kind: 'mention', id: 'm1', accountId: alice, displayName: 'Alice' },
      { kind: 'text', id: 't2', text: '\nI will follow up.' },
    ])).toEqual({
      type: 'doc', version: 1, content: [
        { type: 'paragraph', content: [
          { type: 'text', text: 'Thanks ' },
          { type: 'mention', attrs: { id: alice, text: '@Alice' } },
          { type: 'hardBreak' },
          { type: 'text', text: 'I will follow up.' },
        ] },
      ],
    })
  })

  it('preserves consecutive reply line breaks without adding paragraph spacing', () => {
    const body = buildReplyAdf([{ kind: 'text', id: 't1', text: 'First line\n\nThird line' }])
    expect(body).toEqual({
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'First line' },
        { type: 'hardBreak' },
        { type: 'hardBreak' },
        { type: 'text', text: 'Third line' },
      ] }],
    })
    expect(extractAdfPlainText(body)).toBe('First line\n\nThird line')
  })

  it('calculates fixed snooze instants and orders groups by active comment creation time', () => {
    const monday = new Date(2026, 9, 19, 10, 0, 0, 0).getTime()
    const twoHours = getQuickSnoozeUntil('2-hours', monday)
    const oneDay = getQuickSnoozeUntil('1-day', monday)
    const nextMonday = new Date(getQuickSnoozeUntil('next-monday', monday))
    expect(twoHours - monday).toBe(2 * 60 * 60 * 1000)
    expect(oneDay - monday).toBe(24 * 60 * 60 * 1000)
    expect(nextMonday.getDay()).toBe(1)
    expect(nextMonday.getHours()).toBe(9)

    const item = (issueId: string, issueKey: string, commentId: string, createdAt: number, snoozed = false): JiraMentionProjectionItem => ({
      issue: { issueId, issueKey, summary: issueKey } as JiraMentionProjectionItem['issue'],
      comment: comment(commentId, alice, createdAt, body(mention(self, 'Self'))),
      state: { issueId, incomingCommentId: commentId, authorAccountId: alice, sourceCreatedAt: createdAt, sourceUpdatedAt: createdAt,
        sourceHash: '', firstObservedAt: 0, eligibleEditAt: null, eligibility: 'new', state: 'unanswered',
        resolvingCommentId: null, resolvingCreatedAt: null, ruleVersion: 1, computedAt: 0 },
      action: snoozed ? { issueId, incomingCommentId: commentId, disposition: 'snoozed', snoozeUntil: monday + 10_000, updatedAt: monday } : null,
      authors: [],
    })
    const oldActiveA = item('issue-a', 'APP-1', 'old-a', 100)
    const snoozedNewA = item('issue-a', 'APP-1', 'new-snoozed-a', 500, true)
    const activeB = item('issue-b', 'APP-2', 'active-b', 300)
    activeB.issue.updatedAt = 99_999
    const answeredNewA = item('issue-a', 'APP-1', 'new-answered-a', 900)
    answeredNewA.state.state = 'answered'
    const dismissedNewB = item('issue-b', 'APP-2', 'new-dismissed-b', 1_000)
    dismissedNewB.action = { issueId: 'issue-b', incomingCommentId: 'new-dismissed-b', disposition: 'dismissed', snoozeUntil: null, updatedAt: monday }
    const items = [oldActiveA, snoozedNewA, activeB, answeredNewA, dismissedNewB]
    expect(orderMentionItems(items, monday).map((entry) => entry.comment.commentId)).toEqual(['active-b', 'old-a'])
  })

  it('calculates next Monday at 9 AM across the spring DST change and keeps the instant fixed by zone', () => {
    try {
      vi.stubEnv('TZ', 'America/Chicago')
      const saturday = Date.parse('2026-03-07T16:00:00Z')
      const wakeAt = getQuickSnoozeUntil('next-monday', saturday)
      expect(wakeAt).toBe(Date.parse('2026-03-09T14:00:00Z'))
      expect(new Date(wakeAt).getHours()).toBe(9)

      vi.stubEnv('TZ', 'America/Los_Angeles')
      expect(wakeAt).toBe(Date.parse('2026-03-09T14:00:00Z'))
      expect(new Date(wakeAt).getHours()).toBe(7)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
