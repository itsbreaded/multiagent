export type JiraMentionState = 'unanswered' | 'answered' | 'removed' | 'unknown'
export type JiraMentionEligibility = 'initial' | 'new' | 'edit' | 'ambiguous_edit' | 'excluded'
export type JiraCommentAvailability = 'visible' | 'removed' | 'unavailable'

export type JiraCommentVisibility =
  | { type: 'group' | 'role'; value: string; identifier?: string }
  | { type: 'service_desk'; value: 'public' | 'internal'; restriction?: { type: 'group' | 'role'; value: string; identifier?: string } }
  | { type: 'unsupported'; value: string }
  | null

export interface JiraUserReference {
  accountId: string
  displayName: string | null
  avatarUrl?: string
  active?: boolean
  sources: string[]
}

export interface JiraCommentRecord {
  commentId: string
  issueId: string
  authorAccountId: string | null
  authorDisplayName: string | null
  createdAt: number
  updatedAt: number
  body: unknown
  excerpt: string
  visibility: JiraCommentVisibility
  availability: JiraCommentAvailability
}

export interface JiraAttachmentMetadata {
  id: string
  name: string
  contentUrl: string | null
  mimeType: string | null
  size: number | null
  author: JiraUserReference | null
  createdAt: number | null
}

export const JIRA_INLINE_IMAGE_MAX_BYTES = 8 * 1024 * 1024

const JIRA_INLINE_IMAGE_MIME_TYPES = new Set([
  'image/apng',
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
])

export function normalizeJiraInlineImageMimeType(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.split(';', 1)[0].trim().toLowerCase()
  return JIRA_INLINE_IMAGE_MIME_TYPES.has(normalized) ? normalized : null
}

export type JiraAttachmentPreviewResult =
  | { ok: true; mimeType: string; bytes: Uint8Array }
  | { ok: false; reason: 'unavailable' | 'unsupported' | 'too_large' }

export interface JiraIssueMetadata {
  issueId: string
  issueKey: string
  summary: string
  projectId: string | null
  projectKey: string | null
  projectName: string | null
  statusId: string | null
  statusName: string | null
  statusCategory: string | null
  issueType: string | null
  priority: string | null
  assignee: JiraUserReference | null
  reporter: JiraUserReference | null
  creator: JiraUserReference | null
  createdAt: number | null
  updatedAt: number | null
  dueDate: string | null
  resolution: string | null
  description: unknown | null
  attachments: JiraAttachmentMetadata[]
  parent: { issueKey: string; summary: string | null } | null
  subtasks: Array<{ issueKey: string; summary: string | null }>
  issueLinks: Array<{ direction: string; issueKey: string; summary: string | null; linkType: string }>
}

export interface JiraIssueSnapshot {
  issue: JiraIssueMetadata
  comments: JiraCommentRecord[]
  users: JiraUserReference[]
  observedCommentCount: number
  commentsComplete: boolean
  updatedMarker: string | null
}

export interface JiraMentionStateRecord {
  issueId: string
  incomingCommentId: string
  authorAccountId: string | null
  sourceCreatedAt: number
  sourceUpdatedAt: number
  sourceHash: string
  firstObservedAt: number
  eligibleEditAt: number | null
  eligibility: JiraMentionEligibility
  state: JiraMentionState
  resolvingCommentId: string | null
  resolvingCreatedAt: number | null
  ruleVersion: number
  computedAt: number
}

export interface JiraMentionAction {
  issueId: string
  incomingCommentId: string
  disposition: 'active' | 'dismissed' | 'snoozed'
  snoozeUntil: number | null
  updatedAt: number
}

export interface JiraMentionProjectionItem {
  issue: JiraIssueMetadata
  comment: JiraCommentRecord
  state: JiraMentionStateRecord
  action: JiraMentionAction | null
  authors: JiraUserReference[]
  replyUncertain?: boolean
}

export interface JiraMentionsProjection {
  enabled: boolean
  identityVerified: boolean
  status: 'not-configured' | 'not-checked' | 'loading' | 'ready' | 'partial' | 'error'
  errorCode: string | null
  activeCount: number
  lastAttemptAt: number | null
  lastSuccessAt: number | null
  historyFrom: number | null
  coverageThrough: number | null
  cached: boolean
  items: JiraMentionProjectionItem[]
}

export type JiraReplyDraftToken =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'mention'; id: string; accountId: string; displayName: string }

export type JiraMentionsRefreshMode = 'open-if-stale' | 'manual' | 'full'
export type JiraMentionsActionKind = 'activated' | 'dismissed' | 'snoozed' | 'restored'

export interface JiraMentionsActionInput {
  issueId: string
  incomingCommentId: string
  action: JiraMentionsActionKind
  snoozeUntil?: number
}

export interface JiraMentionsReplyInput {
  issueId: string
  sourceCommentId?: string
  tokens: JiraReplyDraftToken[]
}

export type JiraMentionsReplyResult =
  | { ok: true; commentId: string }
  | { ok: false; outcome: 'rejected' | 'unknown'; errorCode: string }

export interface ClassifiedJiraMention {
  comment: JiraCommentRecord
  eligibility: JiraMentionEligibility
  eligibleEditAt: number | null
  firstObservedAt: number
  state: JiraMentionState
  resolvingCommentId: string | null
  resolvingCreatedAt: number | null
}

export interface PriorJiraMentionEvidence {
  eligibility: JiraMentionEligibility
  sourceUpdatedAt: number
  previouslyMentionedSelf: boolean
  firstObservedAt: number
}

export function extractStructuredMentionUsers(body: unknown): JiraUserReference[] {
  const users = new Map<string, JiraUserReference>()
  visitAdf(body, (node) => {
    if (node.type !== 'mention') return
    const attrs = isRecord(node.attrs) ? node.attrs : {}
    const accountId = stringValue(attrs.id) ?? stringValue(attrs.accountId)
    if (!accountId) return
    const displayName = stringValue(attrs.text) ?? stringValue(attrs.displayName)
    mergeUser(users, {
      accountId,
      displayName,
      sources: ['mention'],
    })
  })
  return [...users.values()]
}

export function extractMentionAccountIds(body: unknown): string[] {
  return extractStructuredMentionUsers(body).map((user) => user.accountId)
}

export function extractAdfPlainText(body: unknown): string {
  const parts: string[] = []
  const visit = (value: unknown): void => {
    if (!isRecord(value)) return
    if (value.type === 'text' && typeof value.text === 'string') {
      parts.push(value.text)
      return
    }
    if (value.type === 'mention') {
      const attrs = isRecord(value.attrs) ? value.attrs : {}
      const text = stringValue(attrs.text) ?? stringValue(attrs.displayName)
      if (text) parts.push(text.startsWith('@') ? text : `@${text}`)
      return
    }
    if (value.type === 'hardBreak') {
      parts.push('\n')
      return
    }
    if (Array.isArray(value.content)) {
      for (const child of value.content) visit(child)
      if (BLOCK_ADF_TYPES.has(String(value.type))) parts.push('\n')
    }
  }
  visit(body)
  return parts.join('').replace(/[ \t]+\n/g, '\n').trim()
}

const BLOCK_ADF_TYPES = new Set([
  'doc', 'paragraph', 'blockquote', 'bulletList', 'orderedList', 'listItem',
  'heading', 'codeBlock', 'panel', 'table', 'tableRow', 'tableCell', 'tableHeader',
])

export function classifyJiraIssueMentions(args: {
  comments: JiraCommentRecord[]
  selfAccountId: string
  historyFrom: number
  trackingStartedAt: number
  observedAt: number
  previous?: ReadonlyMap<string, PriorJiraMentionEvidence>
}): ClassifiedJiraMention[] {
  const { comments, selfAccountId, historyFrom, trackingStartedAt, observedAt } = args
  const previous = args.previous ?? new Map<string, PriorJiraMentionEvidence>()
  const repliesByAuthor = new Map<string, JiraCommentRecord[]>()

  for (const comment of comments) {
    if (comment.availability !== 'visible' || comment.authorAccountId !== selfAccountId) continue
    for (const accountId of extractMentionAccountIds(comment.body)) {
      const replies = repliesByAuthor.get(accountId) ?? []
      replies.push(comment)
      repliesByAuthor.set(accountId, replies)
    }
  }
  for (const replies of repliesByAuthor.values()) replies.sort(compareCommentsAscending)

  const result: ClassifiedJiraMention[] = []
  for (const comment of comments) {
    const old = previous.get(comment.commentId)
    if (comment.availability !== 'visible') {
      if (old) result.push({
        comment,
        eligibility: old.eligibility,
        eligibleEditAt: null,
        firstObservedAt: old.firstObservedAt,
        state: comment.availability === 'removed' ? 'removed' : 'unknown',
        resolvingCommentId: null,
        resolvingCreatedAt: null,
      })
      continue
    }

    const mentionsSelf = extractMentionAccountIds(comment.body).includes(selfAccountId)
    if (mentionsSelf && !comment.authorAccountId && old && old.eligibility !== 'excluded') {
      result.push({
        comment,
        eligibility: old.eligibility,
        eligibleEditAt: null,
        firstObservedAt: old.firstObservedAt,
        state: 'unknown',
        resolvingCommentId: null,
        resolvingCreatedAt: null,
      })
      continue
    }
    const incoming = mentionsSelf && Boolean(comment.authorAccountId) && comment.authorAccountId !== selfAccountId
    if (!incoming && !old) continue

    let eligibility: JiraMentionEligibility = old?.eligibility ?? 'excluded'
    let eligibleEditAt: number | null = null
    if (old && old.eligibility !== 'excluded') {
      eligibility = old.eligibility
    } else if (incoming && comment.createdAt >= historyFrom) {
      eligibility = comment.createdAt >= trackingStartedAt ? 'new' : 'initial'
    } else if (incoming && old && !old.previouslyMentionedSelf && comment.updatedAt > old.sourceUpdatedAt && comment.updatedAt >= trackingStartedAt) {
      eligibility = 'edit'
      eligibleEditAt = comment.updatedAt
    } else if (incoming && !old && comment.updatedAt >= trackingStartedAt) {
      eligibility = 'ambiguous_edit'
      eligibleEditAt = comment.updatedAt
    } else {
      eligibility = 'excluded'
    }

    if (!incoming) {
      result.push({
        comment,
        eligibility,
        eligibleEditAt,
        firstObservedAt: old?.firstObservedAt ?? observedAt,
        state: 'removed',
        resolvingCommentId: null,
        resolvingCreatedAt: null,
      })
      continue
    }

    if (eligibility === 'excluded') {
      if (old) result.push({
        comment,
        eligibility,
        eligibleEditAt,
        firstObservedAt: old.firstObservedAt,
        state: 'removed',
        resolvingCommentId: null,
        resolvingCreatedAt: null,
      })
      continue
    }

    const authorId = comment.authorAccountId
    const resolving = authorId
      ? (repliesByAuthor.get(authorId) ?? []).find((reply) => reply.createdAt > comment.createdAt)
      : undefined
    result.push({
      comment,
      eligibility,
      eligibleEditAt,
      firstObservedAt: old?.firstObservedAt ?? observedAt,
      state: resolving ? 'answered' : 'unanswered',
      resolvingCommentId: resolving?.commentId ?? null,
      resolvingCreatedAt: resolving?.createdAt ?? null,
    })
  }

  // Keep deterministic output for the repository and renderer even when Jira
  // returns pages with equal timestamps in different orders.
  return result.sort((a, b) => compareCommentsAscending(a.comment, b.comment))
}

export function compareCommentsAscending(a: JiraCommentRecord, b: JiraCommentRecord): number {
  return a.createdAt - b.createdAt || compareOpaqueIds(a.commentId, b.commentId)
}

export function compareOpaqueIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function buildReplyAdf(tokens: readonly JiraReplyDraftToken[]): Record<string, unknown> {
  const content: Record<string, unknown>[] = []
  let paragraph: Record<string, unknown>[] = []
  const flush = () => {
    if (paragraph.length) content.push({ type: 'paragraph', content: paragraph })
    paragraph = []
  }
  for (const token of tokens) {
    if (token.kind === 'text') {
      if (typeof token.text !== 'string') throw new Error('Invalid reply draft.')
      const lines = token.text.split('\n')
      lines.forEach((line, index) => {
        if (line) paragraph.push({ type: 'text', text: line })
        if (index < lines.length - 1) paragraph.push({ type: 'hardBreak' })
      })
      continue
    }
    if (token.kind !== 'mention' || !token.accountId || !token.displayName) throw new Error('Invalid reply draft.')
    paragraph.push({
      type: 'mention',
      attrs: { id: token.accountId, text: token.displayName.startsWith('@') ? token.displayName : `@${token.displayName}` },
    })
  }
  flush()
  return { type: 'doc', version: 1, content }
}

export type JiraQuickSnooze = '2-hours' | '1-day' | 'next-monday'

export function getQuickSnoozeUntil(kind: JiraQuickSnooze, now: number): number {
  if (kind === '2-hours') return now + 2 * 60 * 60 * 1000
  if (kind === '1-day') return now + 24 * 60 * 60 * 1000
  const next = new Date(now)
  const daysUntilMonday = (8 - next.getDay()) % 7 || 7
  next.setDate(next.getDate() + daysUntilMonday)
  next.setHours(9, 0, 0, 0)
  return next.getTime()
}

export function orderMentionItems(items: readonly JiraMentionProjectionItem[], now: number): JiraMentionProjectionItem[] {
  const active = items.filter((item) => isJiraMentionActive(item, now))
  const issueNewest = new Map<string, number>()
  for (const item of active) issueNewest.set(item.issue.issueId,
    Math.max(issueNewest.get(item.issue.issueId) ?? Number.NEGATIVE_INFINITY, item.comment.createdAt))
  return [...active].sort((a, b) => (issueNewest.get(b.issue.issueId)! - issueNewest.get(a.issue.issueId)!)
    || compareOpaqueIds(a.issue.issueKey, b.issue.issueKey)
    || a.comment.createdAt - b.comment.createdAt
    || compareOpaqueIds(a.comment.commentId, b.comment.commentId))
}

export function isJiraMentionActive(item: JiraMentionProjectionItem, now: number): boolean {
  if (item.action?.disposition === 'active') {
    const answeredAfterActivation = item.state.state === 'answered'
      && item.state.resolvingCreatedAt !== null
      && item.state.resolvingCreatedAt > item.action.updatedAt
    return !answeredAfterActivation
  }
  if (item.action?.disposition === 'dismissed') return false
  if (item.action?.disposition === 'snoozed' && item.action.snoozeUntil !== null && item.action.snoozeUntil > now) return false
  return item.state.state === 'unanswered'
}

export function mergeUserReference(
  users: Map<string, JiraUserReference>,
  candidate: JiraUserReference,
): void {
  mergeUser(users, candidate)
}

function mergeUser(users: Map<string, JiraUserReference>, candidate: JiraUserReference): void {
  const old = users.get(candidate.accountId)
  if (!old) {
    users.set(candidate.accountId, { ...candidate, sources: [...new Set(candidate.sources)] })
    return
  }
  users.set(candidate.accountId, {
    ...old,
    displayName: old.displayName ?? candidate.displayName,
    avatarUrl: old.avatarUrl ?? candidate.avatarUrl,
    active: old.active ?? candidate.active,
    sources: [...new Set([...old.sources, ...candidate.sources])],
  })
}

function visitAdf(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!isRecord(value)) return
  visit(value)
  if (Array.isArray(value.content)) {
    for (const child of value.content) visitAdf(child, visit)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
