import { normalizeJiraAttachmentUrl, normalizeJiraBaseUrl } from '../../shared/jira'
import type {
  JiraAttachmentPreviewResult,
  JiraAttachmentMetadata,
  JiraCommentRecord,
  JiraIssueMetadata,
  JiraIssueSnapshot,
  JiraCommentVisibility,
  JiraUserReference,
} from '../../shared/jiraMentions'
import { JIRA_INLINE_IMAGE_MAX_BYTES, normalizeJiraInlineImageMimeType } from '../../shared/jiraMentions'
import { extractAdfPlainText, extractStructuredMentionUsers, mergeUserReference } from '../../shared/jiraMentions'
import type { JiraStoredSettings } from './JiraSettingsStore'

export interface JiraMentionsResponse {
  ok: boolean
  status: number
  headers?: { get(name: string): string | null }
  body?: ReadableStream<Uint8Array> | null
  arrayBuffer?(): Promise<ArrayBuffer>
  json(): Promise<unknown>
}

export type JiraMentionsFetch = (url: string, init: RequestInit) => Promise<JiraMentionsResponse>

export type JiraApiFailureCode = 'invalid_config' | 'invalid_response' | 'validation' | 'auth' | 'permission' | 'not_found' | 'rate_limited' | 'network' | 'too_large' | 'unsupported_media_type'

export class JiraApiError extends Error {
  constructor(readonly code: JiraApiFailureCode, readonly retryAt: number | null = null, readonly status: number | null = null) {
    super(code)
    this.name = 'JiraApiError'
  }
}

export interface JiraIdentity {
  accountId: string
  displayName: string | null
  timeZone: string | null
}

export interface JiraSearchIssue {
  issueId: string
  issueKey: string
  updatedMarker: string | null
  updatedAt: number | null
  commentTotal: number | null
  inlineComments: unknown[]
  inlineStartAt: number | null
  inlineMaxResults: number | null
  summary: string
  project: { id: string | null; key: string | null; name: string | null; projectTypeKey: string | null }
}

export interface JiraMentionsClientOptions {
  fetch?: JiraMentionsFetch
  timeoutMs?: number
  pageSize?: number
}

interface RawComment {
  id?: unknown
  author?: unknown
  body?: unknown
  created?: unknown
  updated?: unknown
  visibility?: unknown
}

interface RawServiceDeskComment {
  id?: unknown
  public?: unknown
}

const DISCOVERY_FIELDS = ['summary', 'updated', 'comment', 'project']
const DETAIL_FIELDS = [
  'summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter', 'creator', 'created', 'updated',
  'duedate', 'resolution', 'description', 'attachment', 'parent', 'subtasks', 'issuelinks',
]

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseUser(value: unknown, source: string): JiraUserReference | null {
  const user = record(value)
  if (!user) return null
  const accountId = str(user.accountId)
  if (!accountId) return null
  const avatarUrls = record(user.avatarUrls)
  return {
    accountId,
    displayName: str(user.displayName) ?? str(user.name),
    ...(str(avatarUrls?.['48x48']) ? { avatarUrl: str(avatarUrls?.['48x48'])! } : {}),
    ...(typeof user.active === 'boolean' ? { active: user.active } : {}),
    sources: [source],
  }
}

function parseVisibility(value: unknown, projectTypeKey: string | null, serviceDeskPublic?: boolean): JiraCommentRecord['visibility'] {
  if (projectTypeKey === 'service_desk') {
    if (typeof serviceDeskPublic === 'boolean') {
      const restriction = parsePlatformRestriction(value)
      if (value !== undefined && value !== null && restriction === null) return { type: 'unsupported', value: 'service_desk' }
      return { type: 'service_desk', value: serviceDeskPublic ? 'public' : 'internal', ...(restriction ? { restriction } : {}) }
    }
    return { type: 'unsupported', value: 'service_desk' }
  }
  // Jira omits visibility for unrestricted comments; it is only populated for
  // role/group-restricted comments.
  if (value === undefined || value === null) return null
  return parsePlatformRestriction(value) ?? { type: 'unsupported', value: str(record(value)?.type) ?? 'unknown' }
}

function parsePlatformRestriction(value: unknown): { type: 'group' | 'role'; value: string; identifier?: string } | null {
  const visibility = record(value)
  if (!visibility) return null
  const type = str(visibility.type)
  const restriction = str(visibility.value)
  const identifier = str(visibility.identifier)
  if (type !== 'group' && type !== 'role') return null
  const audienceValue = restriction ?? identifier
  return audienceValue ? { type, value: audienceValue, ...(identifier ? { identifier } : {}) } : null
}

function mapComment(rawValue: unknown, issueId: string, projectTypeKey: string | null, serviceDeskAudiences?: ReadonlyMap<string, boolean>): JiraCommentRecord {
  const raw = record(rawValue) as RawComment | null
  const id = str(raw?.id)
  const createdAt = parseTime(raw?.created)
  const updatedAt = parseTime(raw?.updated) ?? createdAt
  if (!id || createdAt === null || updatedAt === null) throw new JiraApiError('invalid_response')
  const author = parseUser(raw?.author, 'comment_author')
  const body = raw?.body ?? { type: 'doc', version: 1, content: [] }
  return {
    commentId: id,
    issueId,
    authorAccountId: author?.accountId ?? null,
    authorDisplayName: author?.displayName ?? null,
    createdAt,
    updatedAt,
    body,
    excerpt: extractAdfPlainText(body).slice(0, 500),
    visibility: parseVisibility(raw?.visibility, projectTypeKey, id ? serviceDeskAudiences?.get(id) : undefined),
    availability: 'visible',
  }
}

function parseSearchIssue(value: unknown): JiraSearchIssue {
  const issue = record(value)
  const id = str(issue?.id)
  const key = str(issue?.key)
  const fields = record(issue?.fields)
  if (!id || !key || !fields) throw new JiraApiError('invalid_response')
  const project = record(fields.project)
  const comment = record(fields.comment)
  const inlineComments = Array.isArray(comment?.comments) ? comment.comments : []
  return {
    issueId: id,
    issueKey: key,
    updatedMarker: str(fields.updated),
    updatedAt: parseTime(fields.updated),
    commentTotal: numeric(comment?.total),
    inlineComments,
    inlineStartAt: numeric(comment?.startAt),
    inlineMaxResults: numeric(comment?.maxResults),
    summary: str(fields.summary) ?? '',
    project: {
      id: str(project?.id),
      key: str(project?.key),
      name: str(project?.name),
      projectTypeKey: str(project?.projectTypeKey),
    },
  }
}

function hasCompleteInlineComments(issue: JiraSearchIssue): boolean {
  return issue.inlineStartAt === 0 && issue.commentTotal !== null
    && issue.inlineComments.length === issue.commentTotal
}

function parseRetryAt(response: JiraMentionsResponse, now: number): number | null {
  const value = response.headers?.get('retry-after')
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(now, date) : null
}

function zonedDateForJql(timestamp: number, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  const parts = Object.fromEntries(formatter.formatToParts(timestamp).map((part) => [part.type, part.value]))
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`
}

function quoteJqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function buildMentionCandidateJql(timestamp: number, timeZone: string | null, accountId: string): string {
  let effective = timestamp
  let zone = timeZone ?? 'UTC'
  if (!timeZone) effective -= 2 * 24 * 60 * 60 * 1000
  let date: string
  try {
    date = zonedDateForJql(effective, zone)
  } catch {
    effective = timestamp - 2 * 24 * 60 * 60 * 1000
    zone = 'UTC'
    date = zonedDateForJql(effective, zone)
  }
  return `updated >= ${quoteJqlString(date)} AND comment ~ ${quoteJqlString(accountId)} ORDER BY updated ASC, key ASC`
}

export class JiraMentionsClient {
  private readonly fetchImpl: JiraMentionsFetch
  private readonly timeoutMs: number
  private readonly pageSize: number

  constructor(options: JiraMentionsClientOptions = {}) {
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as JiraMentionsFetch)
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.pageSize = options.pageSize ?? 100
  }

  async fetchAttachmentPreview(
    settings: JiraStoredSettings,
    attachmentId: unknown,
    expectedMimeType: unknown,
    expectedSize?: unknown,
  ): Promise<Omit<Extract<JiraAttachmentPreviewResult, { ok: true }>, 'ok'>> {
    const baseUrl = normalizeJiraBaseUrl(settings.baseUrl)
    const mimeType = normalizeJiraInlineImageMimeType(expectedMimeType)
    const id = typeof attachmentId === 'string' || typeof attachmentId === 'number' ? String(attachmentId) : ''
    if (!baseUrl || !mimeType || new URL(baseUrl).protocol !== 'https:' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new JiraApiError('validation')
    }
    if (typeof expectedSize === 'number') {
      if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) throw new JiraApiError('invalid_response')
      if (expectedSize > JIRA_INLINE_IMAGE_MAX_BYTES) throw new JiraApiError('too_large')
    }

    // Jira's content endpoint negotiates a generic binary response; advertising the image's
    // exact MIME can produce 406. When metadata has the size, request only that full file
    // range. Asking for the 8 MiB cap on a 40 KiB image can make Jira return an invalid range.
    const headers = new Headers({ Accept: '*/*' })
    if (typeof expectedSize === 'number') headers.set('Range', `bytes=0-${expectedSize - 1}`)
    const contentUrl = new URL(`${baseUrl}/rest/api/3/attachment/content/${encodeURIComponent(id)}`)
    contentUrl.searchParams.set('redirect', 'false')
    let response = await this.fetchAuthenticatedUrl(settings, contentUrl.href, { headers, redirect: 'manual' })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const mediaUrl = validatedMediaServiceRedirect(response.headers?.get('location'))
      if (!mediaUrl) throw new JiraApiError('invalid_response', null, response.status)
      response = await this.fetchUnauthenticatedUrl(mediaUrl, { headers })
    }
    if (!response.ok) throw classifyFailure(response, Date.now())

    const responseMimeType = normalizeJiraInlineImageMimeType(response.headers?.get('content-type'))
    if (!responseMimeType || responseMimeType !== mimeType) throw new JiraApiError('unsupported_media_type', null, response.status)

    const declaredLength = parseContentLength(response.headers?.get('content-length'))
    if (declaredLength !== null && declaredLength > JIRA_INLINE_IMAGE_MAX_BYTES) throw new JiraApiError('too_large', null, response.status)

    let expectedResponseLength: number | null = null
    if (response.status === 206) {
      const contentRange = response.headers?.get('content-range') ?? ''
      const match = /^bytes 0-(\d+)\/(\d+)$/.exec(contentRange)
      if (!match) throw new JiraApiError('invalid_response', null, response.status)
      const end = Number(match[1])
      const total = Number(match[2])
      if (!Number.isSafeInteger(end) || !Number.isSafeInteger(total) || total <= 0 || end >= total) {
        throw new JiraApiError('invalid_response', null, response.status)
      }
      if (total > JIRA_INLINE_IMAGE_MAX_BYTES) throw new JiraApiError('too_large', null, response.status)
      if (typeof expectedSize === 'number' && (total !== expectedSize || end + 1 !== expectedSize)) {
        throw new JiraApiError('invalid_response', null, response.status)
      }
      expectedResponseLength = end + 1
    }

    const bytes = await readResponseBytes(response, JIRA_INLINE_IMAGE_MAX_BYTES)
    if (bytes.byteLength === 0) throw new JiraApiError('invalid_response', null, response.status)
    const expectedByteLength = typeof expectedSize === 'number' ? expectedSize : expectedResponseLength
    if (expectedByteLength !== null && bytes.byteLength !== expectedByteLength) {
      throw new JiraApiError('invalid_response', null, response.status)
    }
    return { mimeType, bytes }
  }

  async getIdentity(settings: JiraStoredSettings): Promise<JiraIdentity> {
    const body = await this.requestJson(settings, '/rest/api/3/myself')
    const accountId = str(body.accountId)
    if (!accountId) throw new JiraApiError('invalid_response')
    return {
      accountId,
      displayName: str(body.displayName),
      timeZone: str(body.timeZone),
    }
  }

  async getUserFieldIds(settings: JiraStoredSettings, signal?: AbortSignal): Promise<string[]> {
    let body: unknown
    try {
      body = await this.requestJsonValue(settings, '/rest/api/3/field', { signal })
    } catch (error) {
      if (error instanceof JiraApiError && error.code === 'permission') return []
      throw error
    }
    if (!Array.isArray(body)) throw new JiraApiError('invalid_response')
    const ids: string[] = []
    for (const fieldValue of body) {
      const field = record(fieldValue)
      const schema = record(field?.schema)
      const id = str(field?.id)
      const isUser = schema?.type === 'user' || (schema?.type === 'array' && schema.items === 'user')
      if (id?.startsWith('customfield_') && isUser) ids.push(id)
    }
    return ids
  }

  async searchAll(settings: JiraStoredSettings, jql: string, signal?: AbortSignal): Promise<JiraSearchIssue[]> {
    const all: JiraSearchIssue[] = []
    const seenTokens = new Set<string>()
    let nextPageToken: string | undefined
    while (true) {
      const body: Record<string, unknown> = {
        jql,
        fields: DISCOVERY_FIELDS,
        maxResults: this.pageSize,
      }
      if (nextPageToken) body.nextPageToken = nextPageToken
      const response = await this.requestJson(settings, '/rest/api/3/search/jql', {
        method: 'POST',
        body: JSON.stringify(body),
        signal,
      })
      if (!Array.isArray(response.issues)) throw new JiraApiError('invalid_response')
      all.push(...response.issues.map(parseSearchIssue))
      const token = str(response.nextPageToken)
      if (!token) {
        if (response.isLast === false) throw new JiraApiError('invalid_response')
        break
      }
      if (seenTokens.has(token)) throw new JiraApiError('invalid_response')
      seenTokens.add(token)
      nextPageToken = token
    }
    const unique = new Map<string, JiraSearchIssue>()
    for (const issue of all) unique.set(issue.issueId, issue)
    return [...unique.values()]
  }

  async getIssueCandidate(settings: JiraStoredSettings, issueId: string, signal?: AbortSignal): Promise<JiraSearchIssue> {
    const query = new URLSearchParams({ fields: 'summary,updated,comment,project' })
    const issue = await this.requestJson(settings, `/rest/api/3/issue/${encodeURIComponent(issueId)}?${query.toString()}`, { signal })
    return parseSearchIssue(issue)
  }

  async fetchIssueSnapshot(
    settings: JiraStoredSettings,
    searchIssue: JiraSearchIssue,
    userFieldIds: readonly string[],
    selfAccountId: string,
    signal?: AbortSignal,
  ): Promise<JiraIssueSnapshot> {
    const inlineCommentsComplete = hasCompleteInlineComments(searchIssue)
    const commentSource = await this.getAllComments(settings, searchIssue, signal)
    const hasMentionSelf = commentSource.some((value) => extractStructuredMentionUsers(record(value)?.body)
      .some((user) => user.accountId === selfAccountId))
    const detail = hasMentionSelf
      ? await this.getIssueDetails(settings, searchIssue.issueId, userFieldIds, signal)
      : null
    // A complete inline comment snapshot and its updated marker came from the
    // same search response. Re-reading the issue marker here would add one
    // request per candidate without strengthening snapshot consistency.
    const marker = inlineCommentsComplete && searchIssue.updatedMarker !== null && searchIssue.updatedAt !== null
      ? { updatedMarker: searchIssue.updatedMarker, updatedAt: searchIssue.updatedAt, commentTotal: searchIssue.commentTotal }
      : await this.getIssueMarker(settings, searchIssue.issueId, signal)
    if (searchIssue.updatedAt !== null && marker.updatedAt !== null && searchIssue.updatedAt !== marker.updatedAt) {
      throw new JiraApiError('invalid_response')
    }
    if (searchIssue.commentTotal !== null && marker.commentTotal !== null && searchIssue.commentTotal !== marker.commentTotal) {
      throw new JiraApiError('invalid_response')
    }

    const projectTypeKey = detail?.project.projectTypeKey ?? searchIssue.project.projectTypeKey
    let serviceDeskAudiences: Map<string, boolean> | undefined
    if (projectTypeKey === 'service_desk' && hasMentionSelf) {
      try {
        serviceDeskAudiences = await this.getServiceDeskCommentAudiences(settings, detail?.issue.issueKey ?? searchIssue.issueKey, signal)
      } catch {
        // Keep readable Jira comments visible when JSM audience metadata is
        // unavailable, but leave their reply audience explicitly unsupported.
        serviceDeskAudiences = new Map()
      }
    }
    const comments = commentSource.map((raw) => mapComment(raw, searchIssue.issueId, projectTypeKey, serviceDeskAudiences))
    const users = new Map<string, JiraUserReference>()
    for (const user of [detail?.assignee, detail?.reporter, detail?.creator]) if (user) mergeUserReference(users, user)
    for (const user of detail?.customUsers ?? []) mergeUserReference(users, user)
    for (const comment of comments) {
      if (comment.authorAccountId) mergeUserReference(users, {
        accountId: comment.authorAccountId, displayName: comment.authorDisplayName, sources: ['comment_author'],
      })
      for (const user of extractStructuredMentionUsers(comment.body)) mergeUserReference(users, user)
    }
    const issue = detail?.issue ?? minimalIssue(searchIssue)
    return {
      issue,
      comments,
      users: [...users.values()],
      observedCommentCount: comments.length,
      commentsComplete: commentSource.length === marker.commentTotal,
      updatedMarker: marker.updatedMarker,
    }
  }

  async getComment(settings: JiraStoredSettings, issueId: string, commentId: string, signal?: AbortSignal): Promise<JiraCommentRecord> {
    const body = await this.requestJson(settings, `/rest/api/3/issue/${encodeURIComponent(issueId)}/comment/${encodeURIComponent(commentId)}`, { signal })
    return mapComment(body, issueId, null)
  }

  async postComment(
    settings: JiraStoredSettings,
    issueId: string,
    adfBody: unknown,
    visibility: JiraCommentVisibility,
    issueKey?: string,
    signal?: AbortSignal,
  ): Promise<JiraCommentRecord> {
    if (visibility?.type === 'unsupported') throw new JiraApiError('validation')
    const body: Record<string, unknown> = { body: adfBody }
    if (visibility?.type === 'group' || visibility?.type === 'role') body.visibility = visibility
    if (visibility?.type === 'service_desk') {
      if (!issueKey) throw new JiraApiError('invalid_config')
      if (visibility.restriction) body.visibility = visibility.restriction
      body.properties = [{ key: 'sd.public.comment', value: { internal: visibility.value === 'internal' } }]
    }
    const response = await this.requestJson(settings, `/rest/api/3/issue/${encodeURIComponent(issueId)}/comment`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    })
    const result = mapComment(response, issueId, null)
    if (visibility?.type === 'service_desk') {
      const restrictionMatches = visibility.restriction
        ? result.visibility?.type === visibility.restriction.type
          && result.visibility.value === visibility.restriction.value
          && (!visibility.restriction.identifier || result.visibility.identifier === visibility.restriction.identifier)
        : result.visibility === null
      if (!restrictionMatches) throw new JiraApiError('invalid_response')
      const serviceDeskPublic = await this.getServiceDeskCommentPublic(settings, issueKey!, result.commentId, signal)
      if (serviceDeskPublic !== (visibility.value === 'public')) throw new JiraApiError('invalid_response')
      result.visibility = visibility
    }
    return result
  }

  private async getServiceDeskCommentAudiences(settings: JiraStoredSettings, issueKey: string, signal?: AbortSignal): Promise<Map<string, boolean>> {
    const audiences = new Map<string, boolean>()
    let start = 0
    while (true) {
      const query = new URLSearchParams({ start: String(start), limit: String(this.pageSize) })
      const page = await this.requestJson(settings,
        `/rest/servicedeskapi/request/${encodeURIComponent(issueKey)}/comment?${query.toString()}`, { signal })
      if (!Array.isArray(page.values)) throw new JiraApiError('invalid_response')
      const values = page.values as unknown[]
      for (const value of values) {
        const comment = record(value) as RawServiceDeskComment | null
        const id = str(comment?.id)
        if (!id || typeof comment?.public !== 'boolean' || audiences.has(id)) throw new JiraApiError('invalid_response')
        audiences.set(id, comment.public)
      }
      const isLastPage = typeof page.isLastPage === 'boolean' ? page.isLastPage : values.length < this.pageSize
      if (isLastPage) return audiences
      if (values.length === 0) throw new JiraApiError('invalid_response')
      start += values.length
    }
  }

  private async getServiceDeskCommentPublic(settings: JiraStoredSettings, issueKey: string, commentId: string, signal?: AbortSignal): Promise<boolean | null> {
    const value = await this.requestJson(settings,
      `/rest/servicedeskapi/request/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`, { signal })
    return typeof value.public === 'boolean' ? value.public : null
  }

  private async getAllComments(settings: JiraStoredSettings, issue: JiraSearchIssue, signal?: AbortSignal): Promise<unknown[]> {
    if (hasCompleteInlineComments(issue)) return issue.inlineComments

    const comments: unknown[] = []
    const seenIds = new Set<string>()
    let startAt = 0
    let total: number | null = null
    while (total === null || startAt < total) {
      const query = new URLSearchParams({ startAt: String(startAt), maxResults: String(this.pageSize), orderBy: 'created' })
      const page = await this.requestJson(settings,
        `/rest/api/3/issue/${encodeURIComponent(issue.issueId)}/comment?${query.toString()}`, { signal })
      if (!Array.isArray(page.comments) || typeof page.total !== 'number' || !Number.isInteger(page.total)) {
        throw new JiraApiError('invalid_response')
      }
      const items = page.comments as unknown[]
      if (items.length === 0 && startAt < page.total) throw new JiraApiError('invalid_response')
      for (const item of items) {
        const id = str(record(item)?.id)
        if (!id || seenIds.has(id)) throw new JiraApiError('invalid_response')
        seenIds.add(id)
        comments.push(item)
      }
      if (total !== null && total !== page.total) throw new JiraApiError('invalid_response')
      total = page.total
      const reportedStart = numeric(page.startAt)
      const advance = items.length
      if (advance <= 0 || (reportedStart !== null && reportedStart !== startAt)) throw new JiraApiError('invalid_response')
      startAt += advance
      if (startAt > total) throw new JiraApiError('invalid_response')
    }
    if (comments.length !== total) throw new JiraApiError('invalid_response')
    return comments
  }

  private async getIssueDetails(settings: JiraStoredSettings, issueId: string, userFieldIds: readonly string[], signal?: AbortSignal): Promise<{
    issue: JiraIssueMetadata; assignee: JiraUserReference | null; reporter: JiraUserReference | null;
    creator: JiraUserReference | null; customUsers: JiraUserReference[]; project: { projectTypeKey: string | null }
  }> {
    const fields = [...DETAIL_FIELDS, ...userFieldIds]
    const query = new URLSearchParams({ fields: fields.join(',') })
    const result = await this.requestJson(settings, `/rest/api/3/issue/${encodeURIComponent(issueId)}?${query.toString()}`, { signal })
    const fieldsObject = record(result.fields)
    const project = record(fieldsObject?.project)
    const users: JiraUserReference[] = []
    for (const fieldId of userFieldIds) collectUserValues(fieldsObject?.[fieldId], `field:${fieldId}`, users)
    const assignee = parseUser(fieldsObject?.assignee, 'assignee')
    const reporter = parseUser(fieldsObject?.reporter, 'reporter')
    const creator = parseUser(fieldsObject?.creator, 'creator')
    const metadata: JiraIssueMetadata = {
      issueId: str(result.id) ?? issueId,
      issueKey: str(result.key) ?? '',
      summary: str(fieldsObject?.summary) ?? '',
      projectId: str(project?.id),
      projectKey: str(project?.key),
      projectName: str(project?.name),
      statusId: str(record(fieldsObject?.status)?.id),
      statusName: str(record(fieldsObject?.status)?.name),
      statusCategory: str(record(record(fieldsObject?.status)?.statusCategory)?.name),
      issueType: str(record(fieldsObject?.issuetype)?.name),
      priority: str(record(fieldsObject?.priority)?.name),
      assignee,
      reporter,
      creator,
      createdAt: parseTime(fieldsObject?.created),
      updatedAt: parseTime(fieldsObject?.updated),
      dueDate: str(fieldsObject?.duedate),
      resolution: str(record(fieldsObject?.resolution)?.name),
      description: fieldsObject?.description ?? null,
      attachments: mapAttachments(fieldsObject?.attachment, settings.baseUrl),
      parent: mapLinkedIssue(fieldsObject?.parent),
      subtasks: Array.isArray(fieldsObject?.subtasks) ? fieldsObject.subtasks.map(mapLinkedIssue).filter(isLinkedIssue) : [],
      issueLinks: mapIssueLinks(fieldsObject?.issuelinks),
    }
    if (!metadata.issueKey || metadata.issueId !== issueId) throw new JiraApiError('invalid_response')
    return { issue: metadata, assignee, reporter, creator, customUsers: users, project: { projectTypeKey: str(project?.projectTypeKey) } }
  }

  private async getIssueMarker(settings: JiraStoredSettings, issueId: string, signal?: AbortSignal): Promise<{ updatedMarker: string | null; updatedAt: number | null; commentTotal: number | null }> {
    const query = new URLSearchParams({ fields: 'updated,comment' })
    const response = await this.requestJson(settings, `/rest/api/3/issue/${encodeURIComponent(issueId)}?${query.toString()}`, { signal })
    const fields = record(response.fields)
    return {
      updatedMarker: str(fields?.updated),
      updatedAt: parseTime(fields?.updated),
      commentTotal: numeric(record(fields?.comment)?.total),
    }
  }

  private async requestJson(settings: JiraStoredSettings, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const parsed = record(await this.requestJsonValue(settings, path, init))
    if (!parsed) throw new JiraApiError('invalid_response')
    return parsed
  }

  private async requestJsonValue(settings: JiraStoredSettings, path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchResponse(settings, path, init)
    if (!response.ok) throw classifyFailure(response, Date.now())
    try { return await response.json() } catch { throw new JiraApiError('invalid_response') }
  }

  private async fetchResponse(settings: JiraStoredSettings, path: string, init: RequestInit): Promise<JiraMentionsResponse> {
    const baseUrl = normalizeJiraBaseUrl(settings.baseUrl)
    if (!baseUrl) throw new JiraApiError('invalid_config')
    return this.fetchAuthenticatedUrl(settings, `${baseUrl}${path}`, init)
  }

  private async fetchAuthenticatedUrl(settings: JiraStoredSettings, url: string, init: RequestInit): Promise<JiraMentionsResponse> {
    if (!settings.email || !settings.token) throw new JiraApiError('invalid_config')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const externalSignal = init.signal
    const onAbort = () => controller.abort()
    if (externalSignal?.aborted) controller.abort()
    externalSignal?.addEventListener('abort', onAbort, { once: true })
    try {
      const authorization = Buffer.from(`${settings.email}:${settings.token}`, 'utf8').toString('base64')
      const headers = new Headers(init.headers)
      if (!headers.has('Accept')) headers.set('Accept', 'application/json')
      headers.set('Authorization', `Basic ${authorization}`)
      if (init.body !== undefined) headers.set('Content-Type', 'application/json')
      return await this.fetchImpl(url, {
        ...init,
        headers,
        signal: controller.signal,
        redirect: init.redirect ?? 'error',
      })
    } catch {
      if (controller.signal.aborted) throw new JiraApiError('network')
      throw new JiraApiError('network')
    } finally {
      externalSignal?.removeEventListener('abort', onAbort)
      clearTimeout(timer)
    }
  }

  private async fetchUnauthenticatedUrl(url: string, init: RequestInit): Promise<JiraMentionsResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const externalSignal = init.signal
    const onAbort = () => controller.abort()
    if (externalSignal?.aborted) controller.abort()
    externalSignal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await this.fetchImpl(url, {
        ...init,
        headers: new Headers(init.headers),
        signal: controller.signal,
        redirect: 'error',
      })
    } catch {
      throw new JiraApiError('network')
    } finally {
      externalSignal?.removeEventListener('abort', onAbort)
      clearTimeout(timer)
    }
  }
}

function parseContentLength(value: string | null | undefined): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null
  const size = Number(value)
  return Number.isSafeInteger(size) ? size : null
}

function validatedMediaServiceRedirect(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.origin !== 'https://api.media.atlassian.com'
      || url.username || url.password || url.hash
      || !/^\/file\/[a-f0-9-]{36}\/binary$/i.test(url.pathname)
      || !url.searchParams.get('token') || !url.searchParams.get('client')) return null
    return url.href
  } catch {
    return null
  }
}

async function readResponseBytes(response: JiraMentionsResponse, maxBytes: number): Promise<Uint8Array> {
  if (response.body?.getReader) {
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        size += value.byteLength
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined)
          throw new JiraApiError('too_large', null, response.status)
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    const result = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  }
  if (!response.arrayBuffer) throw new JiraApiError('invalid_response', null, response.status)
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > maxBytes) throw new JiraApiError('too_large', null, response.status)
  return new Uint8Array(buffer)
}

function classifyFailure(response: JiraMentionsResponse, now: number): JiraApiError {
  if (response.status === 401) return new JiraApiError('auth', null, response.status)
  if (response.status === 403) return new JiraApiError('permission', null, response.status)
  if (response.status === 404) return new JiraApiError('not_found', null, response.status)
  if (response.status === 429) return new JiraApiError('rate_limited', parseRetryAt(response, now), response.status)
  if (response.status === 400 || response.status === 422) return new JiraApiError('validation', null, response.status)
  return new JiraApiError('network', null, response.status)
}

function collectUserValues(value: unknown, source: string, users: JiraUserReference[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectUserValues(item, source, users)
    return
  }
  const user = parseUser(value, source)
  if (user) users.push(user)
}

function mapAttachments(value: unknown, baseUrl: string): JiraAttachmentMetadata[] {
  if (!Array.isArray(value)) return []
  const result: JiraAttachmentMetadata[] = []
  for (const item of value) {
    const attachment = record(item)
    const id = str(attachment?.id)
    const name = str(attachment?.filename)
    if (!id || !name) continue
    result.push({
      id,
      name,
      contentUrl: normalizeJiraAttachmentUrl(baseUrl, attachment?.content),
      mimeType: str(attachment?.mimeType),
      size: numeric(attachment?.size),
      author: parseUser(attachment?.author, 'attachment_author'),
      createdAt: parseTime(attachment?.created),
    })
  }
  return result
}

function mapLinkedIssue(value: unknown): { issueKey: string; summary: string | null } | null {
  const issue = record(value)
  const key = str(issue?.key)
  if (!key) return null
  return { issueKey: key, summary: str(record(issue?.fields)?.summary) }
}

function isLinkedIssue(value: { issueKey: string; summary: string | null } | null): value is { issueKey: string; summary: string | null } {
  return value !== null
}

function mapIssueLinks(value: unknown): JiraIssueMetadata['issueLinks'] {
  if (!Array.isArray(value)) return []
  const result: JiraIssueMetadata['issueLinks'] = []
  for (const item of value) {
    const link = record(item)
    const type = str(record(link?.type)?.name) ?? ''
    const inward = mapLinkedIssue(link?.inwardIssue)
    const outward = mapLinkedIssue(link?.outwardIssue)
    if (inward) result.push({ ...inward, direction: 'inward', linkType: type })
    if (outward) result.push({ ...outward, direction: 'outward', linkType: type })
  }
  return result
}

function minimalIssue(search: JiraSearchIssue): JiraIssueMetadata {
  return {
    issueId: search.issueId,
    issueKey: search.issueKey,
    summary: search.summary,
    projectId: search.project.id,
    projectKey: search.project.key,
    projectName: search.project.name,
    statusId: null,
    statusName: null,
    statusCategory: null,
    issueType: null,
    priority: null,
    assignee: null,
    reporter: null,
    creator: null,
    createdAt: null,
    updatedAt: search.updatedAt,
    dueDate: null,
    resolution: null,
    description: null,
    attachments: [],
    parent: null,
    subtasks: [],
    issueLinks: [],
  }
}
