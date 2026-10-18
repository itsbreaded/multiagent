import { normalizeJiraAttachmentUrl, normalizeJiraBaseUrl, type JiraOpenIssueResult, type JiraVerifiedIdentityBinding } from '../../shared/jira'
import {
  buildReplyAdf,
  type JiraMentionsActionInput,
  type JiraMentionsProjection,
  type JiraMentionsRefreshMode,
  type JiraMentionsReplyInput,
  type JiraMentionsReplyResult,
  type JiraAttachmentPreviewResult,
  type JiraIssueSnapshot,
  type JiraReplyDraftToken,
  JIRA_INLINE_IMAGE_MAX_BYTES,
  normalizeJiraInlineImageMimeType,
} from '../../shared/jiraMentions'
import { JiraMentionsClient, JiraApiError, buildMentionCandidateJql, type JiraIdentity } from './JiraMentionsClient'
import { JIRA_MENTION_RULE_VERSION, type JiraMentionsRepository, type JiraSyncRun } from './JiraMentionsRepository'
import { JiraSettingsStore } from './JiraSettingsStore'

const OPEN_STALE_MS = 5 * 60 * 1000
const FULL_RECHECK_MS = 24 * 60 * 60 * 1000
const ISSUE_WORKERS = 4
const MAX_TIMER_MS = 2_147_000_000

export interface JiraMentionsServiceOptions {
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  openExternal?: (url: string) => void
}

type Broadcast = (projection: JiraMentionsProjection) => void

function emptyProjection(settings: ReturnType<JiraSettingsStore['getStoredSettings']>, status: JiraMentionsProjection['status'], errorCode: string | null): JiraMentionsProjection {
  return {
    enabled: settings.mentionsEnabled,
    identityVerified: false,
    status,
    errorCode,
    activeCount: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    historyFrom: null,
    coverageThrough: null,
    cached: false,
    items: [],
  }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof JiraApiError) return error.code
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && /^[a-z0-9_]{1,64}$/i.test(error.code)) return error.code
  return 'refresh_failed'
}

function isAccessFailure(error: unknown): boolean {
  return error instanceof JiraApiError && (error.code === 'not_found' || error.code === 'permission')
}

function errorRetryAt(error: unknown, now: number, priorFailureCount: number): number {
  if (error instanceof JiraApiError && error.retryAt !== null) return error.retryAt
  const delay = Math.min(60 * 60_000, 30_000 * (2 ** Math.min(priorFailureCount, 7)))
  return now + delay
}

function visibilityMatches(
  actual: JiraIssueSnapshot['comments'][number]['visibility'],
  expected: JiraIssueSnapshot['comments'][number]['visibility'],
): boolean {
  if (expected === null) return actual === null
  if (expected.type === 'unsupported') return false
  if (!actual || actual.type === 'unsupported' || actual.type !== expected.type) return false
  if (expected.type === 'service_desk') {
    if (actual.type !== 'service_desk') return false
    if (actual.value !== expected.value) return false
    const expectedRestriction = expected.restriction
    const actualRestriction = actual.restriction
    if (!expectedRestriction) return !actualRestriction
    return Boolean(actualRestriction && actualRestriction.type === expectedRestriction.type
      && actualRestriction.value === expectedRestriction.value
      && (!expectedRestriction.identifier || actualRestriction.identifier === expectedRestriction.identifier))
  }
  if (actual.type !== 'group' && actual.type !== 'role') return false
  if (expected.identifier) return actual.identifier === expected.identifier
  return actual.value === expected.value
}

function validTokens(value: unknown): value is JiraReplyDraftToken[] {
  if (!Array.isArray(value) || value.length > 200) return false
  return value.every((token) => token && typeof token === 'object'
    && ((token.kind === 'text' && typeof token.text === 'string' && token.text.length <= 10_000)
      || (token.kind === 'mention' && typeof token.accountId === 'string' && token.accountId.length > 0
        && typeof token.displayName === 'string' && token.displayName.length <= 200)))
}

export class JiraMentionsService {
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  private readonly openExternal?: (url: string) => void
  private contextId: string | null = null
  private identity: JiraIdentity | null = null
  private identityVerified = false
  private configGeneration = 0
  private activeController: AbortController | null = null
  private refreshPromise: Promise<JiraMentionsProjection> | null = null
  private queuedFull = false
  private identityPromise: Promise<boolean> | null = null
  private fieldIds: string[] = []
  private fieldIdsGeneration = -1
  private pollingTimer: ReturnType<typeof setTimeout> | null = null
  private snoozeTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private readonly sendingIssues = new Set<string>()
  private readonly attachmentPreviewRequests = new Map<string, Promise<JiraAttachmentPreviewResult>>()
  private pendingSendCount = 0
  private pendingSendsDrained: (() => void) | null = null

  constructor(
    private readonly repository: JiraMentionsRepository | null,
    private readonly settingsStore: JiraSettingsStore,
    private readonly client: JiraMentionsClient,
    private readonly broadcast: Broadcast,
    options: JiraMentionsServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
    this.openExternal = options.openExternal
  }

  async start(): Promise<void> {
    this.repository?.markInterruptedWork()
    this.restoreBoundContext()
    this.scheduleSnoozeWake()
    this.configurePolling()
    this.publish()
    const settings = this.settingsStore.getStoredSettings()
    if (settings.mentionsEnabled && this.hasCredentials(settings)) {
      void this.refresh('manual').catch(() => this.publish('refresh_failed'))
    }
  }

  getState(): JiraMentionsProjection {
    return this.projection()
  }

  async refresh(mode: JiraMentionsRefreshMode): Promise<JiraMentionsProjection> {
    if (this.closed) return this.projection()
    const settings = this.settingsStore.getStoredSettings()
    if (!settings.mentionsEnabled) return this.publish()
    if (!this.hasCredentials(settings)) return this.publish('invalid_config')
    if (mode === 'open-if-stale') {
      const current = this.projection()
      if (current.lastSuccessAt !== null && this.now() - current.lastSuccessAt < OPEN_STALE_MS) return current
    }
    if (this.refreshPromise) {
      if (mode === 'full') this.queuedFull = true
      return this.refreshPromise
    }
    const operation = this.runRefresh(mode)
    this.refreshPromise = operation.finally(() => {
      if (this.refreshPromise === wrapped) this.refreshPromise = null
    })
    const wrapped = this.refreshPromise
    return wrapped
  }

  async settingsChanged(oldBinding: JiraVerifiedIdentityBinding | null, oldCredentialKey: string | null, wasEnabled?: boolean): Promise<void> {
    const newKey = this.settingsStore.getCredentialRecordKey()
    const changed = oldCredentialKey !== newKey
    if (changed) {
      this.configGeneration++
      this.activeController?.abort()
      this.contextId = null
      this.identity = null
      this.identityVerified = false
      this.fieldIds = []
      this.fieldIdsGeneration = -1
      if (!newKey && oldBinding && this.repository) this.repository.deleteContext(oldBinding.contextId)
    }
    const settings = this.settingsStore.getStoredSettings()
    if (!settings.mentionsEnabled) {
      this.configGeneration++
      this.activeController?.abort()
      this.stopPolling()
    } else {
      this.configurePolling()
      if ((changed && newKey) || wasEnabled === false) {
        void (async () => {
          await this.refreshPromise?.catch(() => undefined)
          if (!this.closed && this.settingsStore.getStoredSettings().mentionsEnabled) await this.refresh('manual')
        })().catch(() => this.publish('refresh_failed'))
      }
    }
    this.scheduleSnoozeWake()
    this.publish(changed && newKey ? 'invalid_config' : undefined)
  }

  async getIssueDetail(issueId: string): Promise<JiraIssueSnapshot | null> {
    const contextId = this.contextId
    if (!contextId || !this.repository || !this.identityVerified || typeof issueId !== 'string') return null
    const projection = this.repository.getProjection(contextId, this.settingsStore.getStoredSettings().mentionsEnabled, true, this.now())
    if (!projection.items.some((item) => item.issue.issueId === issueId)) return null
    return this.repository.getIssueDetail(contextId, issueId)
  }

  async openAttachment(issueId: string, attachmentId: string): Promise<JiraOpenIssueResult> {
    if (typeof issueId !== 'string' || issueId.length > 128
      || typeof attachmentId !== 'string' || attachmentId.length > 128 || !this.openExternal) {
      return { ok: false, error: 'Attachment link is unavailable.' }
    }
    const snapshot = await this.getIssueDetail(issueId)
    const attachment = snapshot?.issue.attachments.find((item) => item.id === attachmentId)
    const url = normalizeJiraAttachmentUrl(this.settingsStore.getStoredSettings().baseUrl, attachment?.contentUrl)
    if (!url) return { ok: false, error: 'Attachment link is unavailable.' }
    this.openExternal(url)
    return { ok: true }
  }

  async getAttachmentPreview(issueId: string, attachmentId: string): Promise<JiraAttachmentPreviewResult> {
    const contextId = this.contextId
    if (!contextId || !this.identityVerified || !this.repository || !this.settingsStore.getStoredSettings().mentionsEnabled
      || typeof issueId !== 'string' || issueId.length > 128
      || typeof attachmentId !== 'string' || attachmentId.length > 128) return { ok: false, reason: 'unavailable' }

    const requestKey = `${contextId}\0${issueId}\0${attachmentId}`
    const pending = this.attachmentPreviewRequests.get(requestKey)
    if (pending) return pending

    const request = this.loadAttachmentPreview(issueId, attachmentId)
    this.attachmentPreviewRequests.set(requestKey, request)
    try {
      return await request
    } finally {
      if (this.attachmentPreviewRequests.get(requestKey) === request) this.attachmentPreviewRequests.delete(requestKey)
    }
  }

  private async loadAttachmentPreview(issueId: string, attachmentId: string): Promise<JiraAttachmentPreviewResult> {
    const contextId = this.contextId
    const credentialRecordKey = this.settingsStore.getCredentialRecordKey()
    let snapshot: JiraIssueSnapshot | null
    try { snapshot = await this.getIssueDetail(issueId) } catch { return { ok: false, reason: 'unavailable' } }
    const attachment = snapshot?.issue.attachments.find((item) => item.id === attachmentId)
    if (!attachment) return { ok: false, reason: 'unavailable' }
    const settings = this.settingsStore.getStoredSettings()
    const mimeType = normalizeJiraInlineImageMimeType(attachment.mimeType)
    if (!mimeType) return { ok: false, reason: 'unsupported' }
    if (attachment.size !== null && attachment.size > JIRA_INLINE_IMAGE_MAX_BYTES) return { ok: false, reason: 'too_large' }

    try {
      const preview = await this.client.fetchAttachmentPreview(settings, attachment.id, mimeType, attachment.size)
      const currentSettings = this.settingsStore.getStoredSettings()
      if (contextId !== this.contextId || credentialRecordKey !== this.settingsStore.getCredentialRecordKey()
        || !currentSettings.mentionsEnabled) return { ok: false, reason: 'unavailable' }
      return { ok: true, ...preview }
    } catch (error) {
      if (error instanceof JiraApiError && error.code === 'too_large') return { ok: false, reason: 'too_large' }
      if (error instanceof JiraApiError && error.code === 'unsupported_media_type') return { ok: false, reason: 'unsupported' }
      return { ok: false, reason: 'unavailable' }
    }
  }

  setAction(input: JiraMentionsActionInput): JiraMentionsProjection {
    const contextId = this.contextId
    if (!contextId || !this.repository || !this.identityVerified) return this.publish('invalid_config')
    if (!input || typeof input.issueId !== 'string' || typeof input.incomingCommentId !== 'string'
      || !['dismissed', 'snoozed', 'restored'].includes(input.action)) return this.projection()
    const now = this.now()
    const snoozeUntil = input.action === 'snoozed' ? input.snoozeUntil : null
    if (input.action === 'snoozed' && (!Number.isFinite(snoozeUntil) || (snoozeUntil as number) <= now
      || (snoozeUntil as number) > now + 370 * 24 * 60 * 60 * 1000)) return this.projection('invalid_request')
    try {
      this.repository.setMentionAction(contextId, input.issueId, input.incomingCommentId, input.action, snoozeUntil ?? null, now)
      this.scheduleSnoozeWake()
      return this.publish()
    } catch {
      return this.projection('invalid_request')
    }
  }

  clearCache(): JiraMentionsProjection {
    const contextId = this.contextId
    if (!contextId || !this.repository) return this.publish('invalid_config')
    this.configGeneration++
    this.activeController?.abort()
    this.repository.clearFetchedCache(contextId)
    this.scheduleSnoozeWake()
    this.publish()
    void (async () => {
      await this.refreshPromise?.catch(() => undefined)
      await this.refresh('manual')
    })().catch(() => this.publish('refresh_failed'))
    return this.projection()
  }

  async postReply(input: JiraMentionsReplyInput): Promise<JiraMentionsReplyResult> {
    const contextId = this.contextId
    const settings = this.settingsStore.getStoredSettings()
    const key = this.settingsStore.getCredentialRecordKey()
    if (!contextId || !this.repository || !this.identityVerified || !settings.mentionsEnabled || !settings.token || !key) {
      return { ok: false, outcome: 'rejected', errorCode: 'invalid_config' }
    }
    if (!input || typeof input.issueId !== 'string' || typeof input.sourceCommentId !== 'string' || !validTokens(input.tokens)) {
      return { ok: false, outcome: 'rejected', errorCode: 'invalid_request' }
    }
    if (!input.tokens.some((token) => token.kind === 'text' && token.text.trim().length > 0)) {
      return { ok: false, outcome: 'rejected', errorCode: 'invalid_request' }
    }
    let projection = this.repository.getProjection(contextId, true, true, this.now())
    let source = projection.items.find((item) => item.issue.issueId === input.issueId
      && item.comment.commentId === input.sourceCommentId)
    if (!source || source.comment.availability !== 'visible') return { ok: false, outcome: 'rejected', errorCode: 'missing_issue' }
    if (source.state.state !== 'unanswered') return { ok: false, outcome: 'rejected', errorCode: 'already_answered' }
    if (source.comment.visibility?.type === 'unsupported') return { ok: false, outcome: 'rejected', errorCode: 'unsupported_audience' }
    const unreconciledAttempts = this.repository.getUnreconciledUnknownReplyAttempts?.(contextId, input.issueId) ?? []
    if (unreconciledAttempts.length) {
      const refreshed = await this.refresh('manual')
      if (refreshed.status !== 'ready') return { ok: false, outcome: 'unknown', errorCode: refreshed.errorCode ?? 'recheck_failed' }
      projection = this.repository.getProjection(contextId, true, true, this.now())
      source = projection.items.find((item) => item.issue.issueId === input.issueId
        && item.comment.commentId === input.sourceCommentId)
      if (!source || source.state.state !== 'unanswered') {
        return { ok: false, outcome: 'rejected', errorCode: 'already_answered' }
      }
      if ((this.repository.getUnreconciledUnknownReplyAttempts?.(contextId, input.issueId) ?? []).length) {
        return { ok: false, outcome: 'unknown', errorCode: 'recheck_failed' }
      }
      return { ok: false, outcome: 'rejected', errorCode: 'delivery_rechecked' }
    }
    const issueLock = `${contextId}\0${input.issueId}`
    if (this.sendingIssues.has(issueLock)) return { ok: false, outcome: 'rejected', errorCode: 'send_in_progress' }
    this.sendingIssues.add(issueLock)
    this.pendingSendCount++
    let released = false
    const releaseLocked = () => {
      if (released) return
      released = true
      this.sendingIssues.delete(issueLock)
      this.pendingSendCount--
      if (this.pendingSendCount === 0) {
        this.pendingSendsDrained?.()
        this.pendingSendsDrained = null
      }
    }
    const rejectLocked = (outcome: 'rejected' | 'unknown', errorCode: string): JiraMentionsReplyResult => {
      releaseLocked()
      return { ok: false, outcome, errorCode }
    }
    try {
    const refreshed = await this.refresh('manual')
    if (refreshed.status !== 'ready') return rejectLocked('rejected', refreshed.errorCode ?? 'recheck_failed')
    projection = this.repository.getProjection(contextId, true, true, this.now())
    source = projection.items.find((item) => item.issue.issueId === input.issueId
      && item.comment.commentId === input.sourceCommentId && item.state.state === 'unanswered')
    if (!source) return rejectLocked('rejected', 'already_answered')
    if (source.comment.visibility?.type === 'unsupported') return rejectLocked('rejected', 'unsupported_audience')
    const usersById = new Map(source.authors.map((user) => [user.accountId, user]))
    const mentionTokens = input.tokens.filter((token): token is Extract<JiraReplyDraftToken, { kind: 'mention' }> => token.kind === 'mention')
    const mentionIds = mentionTokens.map((token) => token.accountId)
    if (mentionTokens.some((token) => !usersById.has(token.accountId))) return rejectLocked('rejected', 'invalid_recipient')
    if (input.tokens.reduce((total, token) => total + (token.kind === 'text' ? token.text.length : 0), 0) > 10_000) {
      return rejectLocked('rejected', 'invalid_request')
    }
    if (key !== this.settingsStore.getCredentialRecordKey() || contextId !== this.contextId) {
      return rejectLocked('rejected', 'identity_changed')
    }
    const safeTokens = input.tokens.map((token) => token.kind === 'mention'
      ? { ...token, displayName: usersById.get(token.accountId)?.displayName ?? 'Unknown user' }
      : token)
    let body: Record<string, unknown>
    try { body = buildReplyAdf(safeTokens) } catch { return rejectLocked('rejected', 'invalid_request') }
    let attempt: ReturnType<JiraMentionsRepository['startReplyAttempt']>
    try { attempt = this.repository.startReplyAttempt(contextId, input.issueId, body, mentionIds, this.now()) }
    catch { return rejectLocked('rejected', 'cache_unavailable') }
    const visibility = source.comment.visibility
    try {
      const result = await this.client.postComment(settings, input.issueId, body, visibility, source.issue.issueKey)
      if (!result.commentId || result.authorAccountId !== this.identity?.accountId
        || !Number.isFinite(result.createdAt) || JSON.stringify(result.body) !== JSON.stringify(body)
        || !visibilityMatches(result.visibility, visibility)) {
        this.repository.finishReplyAttempt(contextId, attempt.attemptId, {
          outcome: 'unknown', endedAt: this.now(), errorCode: 'invalid_response',
        })
        this.publish()
        return { ok: false, outcome: 'unknown', errorCode: 'invalid_response' }
      }
      this.repository.applyConfirmedReply(contextId, input.issueId, result, attempt.attemptId)
      this.publish()
      return { ok: true, commentId: result.commentId }
    } catch (error) {
      const rejected = error instanceof JiraApiError && error.status !== null && error.status >= 400 && error.status < 500
      const outcome = rejected ? 'rejected' : 'unknown'
      this.repository.finishReplyAttempt(contextId, attempt.attemptId, {
        outcome,
        endedAt: this.now(),
        errorCode: safeErrorCode(error),
      })
      if (outcome === 'unknown') this.publish()
      return { ok: false, outcome, errorCode: safeErrorCode(error) }
    }
    } finally {
      releaseLocked()
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.configGeneration++
    this.activeController?.abort()
    this.stopPolling()
    if (this.snoozeTimer) this.clearTimer(this.snoozeTimer)
    this.snoozeTimer = null
    await this.refreshPromise?.catch(() => undefined)
    if (this.pendingSendCount) await new Promise<void>((resolve) => { this.pendingSendsDrained = resolve })
  }

  private async runRefresh(mode: JiraMentionsRefreshMode): Promise<JiraMentionsProjection> {
    let requestedMode = mode
    let result: JiraMentionsProjection
    do {
      this.queuedFull = false
      result = await this.runSingleRefresh(requestedMode)
      requestedMode = 'full'
    } while (this.queuedFull && !this.closed)
    return result
  }

  private async runSingleRefresh(mode: JiraMentionsRefreshMode): Promise<JiraMentionsProjection> {
    const settings = this.settingsStore.getStoredSettings()
    if (!settings.mentionsEnabled || !this.hasCredentials(settings)) return this.publish('invalid_config')
    if (!await this.ensureIdentity()) return this.projection()
    const contextId = this.contextId
    const context = contextId && this.repository?.getContext(contextId)
    if (!context || !this.repository || !this.identity) return this.publish('database_unavailable')
    const sync = this.repository.getSyncState(contextId)
    if (sync.retryNotBefore !== null && sync.retryNotBefore > this.now()) return this.publish(sync.lastErrorCode ?? 'rate_limited')
    const ruleVersionChanged = context.ruleVersion !== JIRA_MENTION_RULE_VERSION
    const dueFull = sync.lastFullAt === null || this.now() - sync.lastFullAt >= FULL_RECHECK_MS
    const full = mode === 'full' || dueFull || ruleVersionChanged
    const kind: JiraSyncRun['kind'] = sync.lastSuccessAt === null ? 'initial' : full ? 'full' : 'incremental'
    const lowerBound = kind === 'initial' || kind === 'full'
      ? context.historyFrom
      : Math.max(context.historyFrom, (sync.lastSuccessStartedAt ?? context.trackingStartedAt) - 10 * 60_000)
    const scanStartedAt = this.now()
    const run = this.repository.startRun(contextId, {
      kind, lowerBound, scanStartedAt, baseGeneration: sync.generation,
      configGeneration: this.configGeneration, ruleVersion: JIRA_MENTION_RULE_VERSION,
    })
    const effectiveLowerBound = run.lowerBound
    this.activeController = new AbortController()
    const signal = this.activeController.signal
    this.publish()
    let failedCount = 0
    let failureCode: string | null = null
    let retryAt: number | null = null
    let accessLost = false
    try {
      const jql = buildMentionCandidateJql(effectiveLowerBound, this.identity.timeZone, this.identity.accountId)
      const discovered = await this.client.searchAll(settings, jql, signal)
      if (this.configGeneration !== run.configGeneration) throw new JiraApiError('network')
      const issueById = new Map(discovered.map((issue) => [issue.issueId, issue]))
      const knownIds = this.repository.getIssueIdsForRecheck(contextId, full || kind === 'initial')
      for (const issueId of knownIds) {
        if (issueById.has(issueId)) continue
        try {
          const candidate = await this.client.getIssueCandidate(settings, issueId, signal)
          issueById.set(issueId, candidate)
        } catch (error) {
          if (isAccessFailure(error)) {
            this.repository.purgeIssueAccess(contextId, issueId)
            accessLost = true
          } else {
            failedCount++
            failureCode ??= safeErrorCode(error)
            retryAt = errorRetryAt(error, this.now(), failedCount - 1)
          }
        }
      }
      const userFieldIds = await this.getUserFieldIds(settings, run.configGeneration, signal)
      this.repository.setExpectedIssueCount(run, issueById.size)
      const candidates = [...issueById.values()]
      await mapConcurrent(candidates, ISSUE_WORKERS, async (candidate) => {
        if (signal.aborted || this.configGeneration !== run.configGeneration) return
        try {
          let snapshot: JiraIssueSnapshot
          try {
            snapshot = await this.client.fetchIssueSnapshot(settings, candidate, userFieldIds, this.identity!.accountId, signal)
          } catch (firstError) {
            if (!(firstError instanceof JiraApiError) || firstError.code !== 'invalid_response') throw firstError
            snapshot = await this.client.fetchIssueSnapshot(settings, candidate, userFieldIds, this.identity!.accountId, signal)
          }
          if (signal.aborted || this.configGeneration !== run.configGeneration) return
          this.repository!.stageIssueSnapshot(run, snapshot)
        } catch (error) {
          failedCount++
          failureCode ??= safeErrorCode(error)
          retryAt = errorRetryAt(error, this.now(), failedCount - 1)
          if (isAccessFailure(error)) {
            this.repository!.purgeIssueAccess(contextId, candidate.issueId)
            accessLost = true
          } else {
            this.repository!.stageIssueFailure(run, candidate.issueId, false)
          }
        }
      })
      if (signal.aborted || this.closed || this.configGeneration !== run.configGeneration) {
        this.repository.failRun(run, this.now(), 'superseded', null, true)
        return this.publish('partial')
      }
      if (failedCount || accessLost) {
        this.repository.failRun(run, this.now(), failureCode ?? 'partial', retryAt, true)
        return this.publish(failureCode ?? 'partial')
      }
      if (this.settingsStore.getCredentialRecordKey() !== this.settingsStore.getVerifiedIdentityBinding()?.credentialRecordKey
        || this.contextId !== contextId) {
        this.repository.failRun(run, this.now(), 'identity_changed', null, true)
        return this.publish('identity_changed')
      }
      this.repository.commitRun(run, { endedAt: this.now(), retryNotBefore: retryAt, full: kind === 'initial' || full })
      this.scheduleSnoozeWake()
      return this.publish()
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'stale_generation') {
        try { this.repository.failRun(run, this.now(), 'superseded', null, true) } catch { /* superseded or already closed */ }
        return this.publish('partial')
      }
      failureCode = safeErrorCode(error)
      retryAt = errorRetryAt(error, this.now(), failedCount)
      try { this.repository.failRun(run, this.now(), failureCode, retryAt, false) } catch { /* superseded or already closed */ }
      return this.publish(failureCode)
    } finally {
      if (this.activeController?.signal === signal) this.activeController = null
    }
  }

  private async ensureIdentity(): Promise<boolean> {
    if (this.identityPromise) return this.identityPromise
    const generation = this.configGeneration
    const settings = this.settingsStore.getStoredSettings()
    const credentialKey = this.settingsStore.getCredentialRecordKey()
    if (!credentialKey || !this.hasCredentials(settings)) {
      this.publish('invalid_config')
      return false
    }
    const operation = (async () => {
      const binding = this.settingsStore.getVerifiedIdentityBinding()
      const hasCurrentBoundContext = Boolean(binding && binding.credentialRecordKey === credentialKey
        && binding.siteUrl === settings.baseUrl && this.repository?.getContext(binding.contextId))
      if (hasCurrentBoundContext && this.contextId === binding!.contextId && this.identityVerified && this.identity) return true
      if (hasCurrentBoundContext && !this.contextId) {
        this.contextId = binding!.contextId
        this.identityVerified = true
        this.publish()
      }
      try {
        const identity = await this.client.getIdentity(settings)
        if (generation !== this.configGeneration || credentialKey !== this.settingsStore.getCredentialRecordKey()) return false
        if (!this.repository) return false
        const context = this.repository.ensureVerifiedContext(settings.baseUrl, identity.accountId, this.now())
        const nextBinding: JiraVerifiedIdentityBinding = {
          contextId: context.contextId,
          siteUrl: normalizeJiraBaseUrl(settings.baseUrl)!,
          accountId: identity.accountId,
          verifiedAt: this.now(),
          credentialRecordKey: credentialKey,
        }
        if (!this.settingsStore.saveVerifiedIdentityBinding(credentialKey, nextBinding)) {
          if (generation === this.configGeneration) this.publish('binding_save_failed')
          return false
        }
        if (generation !== this.configGeneration || credentialKey !== this.settingsStore.getCredentialRecordKey()) return false
        this.contextId = context.contextId
        this.identity = identity
        this.identityVerified = true
        if (binding && binding.contextId !== context.contextId) this.contextId = context.contextId
        this.publish()
        return true
      } catch (error) {
        if (generation === this.configGeneration && !hasCurrentBoundContext) this.publish(safeErrorCode(error))
        else if (generation === this.configGeneration) this.publish(safeErrorCode(error))
        return false
      }
    })()
    this.identityPromise = operation.finally(() => {
      if (this.identityPromise === wrapped) this.identityPromise = null
    })
    const wrapped = this.identityPromise
    return wrapped
  }

  private restoreBoundContext(): void {
    if (!this.repository) return
    const settings = this.settingsStore.getStoredSettings()
    const key = this.settingsStore.getCredentialRecordKey()
    const binding = this.settingsStore.getVerifiedIdentityBinding()
    if (!key || !binding || !settings.mentionsEnabled || binding.credentialRecordKey !== key
      || binding.siteUrl !== settings.baseUrl) return
    const context = this.repository.getContext(binding.contextId)
    if (!context || context.siteUrl !== binding.siteUrl || context.selfAccountId !== binding.accountId) return
    this.contextId = context.contextId
    this.identityVerified = true
    this.identity = { accountId: context.selfAccountId, displayName: null, timeZone: null }
  }

  private async getUserFieldIds(settings: ReturnType<JiraSettingsStore['getStoredSettings']>, generation: number, signal: AbortSignal): Promise<string[]> {
    if (this.fieldIdsGeneration === generation) return this.fieldIds
    this.fieldIds = await this.client.getUserFieldIds(settings, signal)
    this.fieldIdsGeneration = generation
    return this.fieldIds
  }

  private projection(errorCode?: string): JiraMentionsProjection {
    const settings = this.settingsStore.getStoredSettings()
    if (!settings.mentionsEnabled) return emptyProjection(settings, 'not-configured', null)
    if (!this.repository) return emptyProjection(settings, 'error', 'database_unavailable')
    if (!this.contextId) return emptyProjection(settings, 'not-configured', errorCode ?? null)
    try {
      const projection = this.repository.getProjection(this.contextId, true, this.identityVerified, this.now())
      return errorCode ? { ...projection, status: errorCode === 'partial' ? 'partial' : 'error', errorCode } : projection
    } catch {
      return emptyProjection(settings, 'error', 'database_unavailable')
    }
  }

  private publish(errorCode?: string): JiraMentionsProjection {
    const projection = this.projection(errorCode)
    this.broadcast(projection)
    return projection
  }

  private hasCredentials(settings: ReturnType<JiraSettingsStore['getStoredSettings']>): boolean {
    return Boolean(settings.token && settings.email && normalizeJiraBaseUrl(settings.baseUrl))
  }

  private configurePolling(): void {
    this.stopPolling()
    const settings = this.settingsStore.getStoredSettings()
    if (!settings.mentionsEnabled || !settings.mentionsPollingEnabled || this.closed) return
    this.pollingTimer = this.setTimer(() => {
      this.pollingTimer = null
      void this.refresh('manual').catch(() => this.publish('refresh_failed')).finally(() => this.configurePolling())
    }, settings.mentionsPollingMinutes * 60_000)
  }

  private stopPolling(): void {
    if (this.pollingTimer) this.clearTimer(this.pollingTimer)
    this.pollingTimer = null
  }

  private scheduleSnoozeWake(): void {
    if (this.snoozeTimer) this.clearTimer(this.snoozeTimer)
    this.snoozeTimer = null
    if (!this.contextId || !this.repository || this.closed) return
    let items: JiraMentionsProjection['items']
    try {
      items = this.repository.getProjection(this.contextId, true, this.identityVerified, this.now()).items
    } catch {
      return
    }
    const nextWake = items.map((item) => item.action?.disposition === 'snoozed' ? item.action.snoozeUntil : null)
      .filter((value): value is number => value !== null && value !== undefined && value > this.now())
      .sort((a, b) => a - b)[0]
    if (nextWake === undefined) return
    const delay = Math.max(0, Math.min(MAX_TIMER_MS, nextWake - this.now()))
    this.snoozeTimer = this.setTimer(() => {
      this.snoozeTimer = null
      this.publish()
      this.scheduleSnoozeWake()
    }, delay)
  }
}

async function mapConcurrent<T>(items: readonly T[], workers: number, operation: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const count = Math.min(Math.max(1, workers), items.length)
  await Promise.all(Array.from({ length: count }, async () => {
    while (next < items.length) {
      const index = next++
      await operation(items[index])
    }
  }))
}
