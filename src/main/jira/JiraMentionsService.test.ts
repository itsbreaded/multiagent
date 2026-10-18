import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JiraMentionsService } from './JiraMentionsService'
import { JiraApiError } from './JiraMentionsClient'
import { JIRA_MENTION_RULE_VERSION } from './JiraMentionsRepository'
import { JiraSettingsStore, type JiraSecureStorage } from './JiraSettingsStore'
import type { JiraCommentRecord, JiraIssueSnapshot, JiraMentionsProjection } from '../../shared/jiraMentions'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function settingsStore(pollingEnabled = false): JiraSettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-mentions-service-'))
  tempDirs.push(dir)
  const secure: JiraSecureStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => value.toString('utf8'),
  }
  const store = new JiraSettingsStore(path.join(dir, 'jira.json'), secure)
  const saved = store.save({
    baseUrl: 'https://jira.example.test', email: 'person@example.test', apiToken: 'token-secret', patterns: [],
    mentionsEnabled: true, mentionsPollingEnabled: pollingEnabled, mentionsPollingMinutes: 15,
  })
  if (!saved.ok) throw new Error('fixture settings were rejected')
  return store
}

function snapshot(): JiraIssueSnapshot {
  return {
    issue: {
      issueId: '100', issueKey: 'APP-1', summary: 'A test issue', projectId: '10', projectKey: 'APP', projectName: 'App',
      statusId: '1', statusName: 'Open', statusCategory: 'To Do', issueType: 'Task', priority: null,
      assignee: null, reporter: null, creator: null, createdAt: null, updatedAt: null, dueDate: null, resolution: null,
      description: null, attachments: [], parent: null, subtasks: [], issueLinks: [],
    },
    comments: [], users: [], observedCommentCount: 0, commentsComplete: true, updatedMarker: '2026-10-16T12:00:00Z',
  }
}

function emptyProjection(): JiraMentionsProjection {
  return {
    enabled: true, identityVerified: true, status: 'not-checked', errorCode: null, activeCount: 0,
    lastAttemptAt: null, lastSuccessAt: null, historyFrom: 0, coverageThrough: null, cached: false, items: [],
  }
}

describe('JiraMentionsService', () => {
  it('serves previews only for image attachments in the verified cached issue snapshot', async () => {
    const settings = settingsStore()
    const detail = snapshot()
    const attachment = {
      id: 'att-1', name: 'diagram.png', contentUrl: null,
      mimeType: 'image/png', size: 12, author: null, createdAt: 1_000,
    }
    const issueSnapshot = { ...detail, issue: { ...detail.issue, attachments: [attachment] } }
    const repository = {
      getProjection: vi.fn(() => ({ items: [{ issue: issueSnapshot.issue }] })),
      getIssueDetail: vi.fn(() => issueSnapshot),
    }
    const preview = { mimeType: 'image/png', bytes: Uint8Array.from([1, 2, 3]) }
    const client = { fetchAttachmentPreview: vi.fn(async () => preview) }
    const service = new JiraMentionsService(repository as never, settings, client as never, vi.fn())
    Object.assign(service as unknown as { contextId: string | null; identityVerified: boolean }, { contextId: 'ctx', identityVerified: true })

    await expect(service.getAttachmentPreview('100', 'att-1')).resolves.toEqual({ ok: true, ...preview })
    expect(repository.getIssueDetail).toHaveBeenCalledWith('ctx', '100')
    expect(client.fetchAttachmentPreview).toHaveBeenCalledWith(settings.getStoredSettings(), attachment.id, 'image/png', attachment.size)
    await expect(service.getAttachmentPreview('100', 'not-in-cache')).resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(client.fetchAttachmentPreview).toHaveBeenCalledOnce()
  })

  it('blocks unsupported audiences before POST and treats a broader POST response as uncertain', async () => {
    const settings = settingsStore()
    const context = {
      contextId: 'ctx', siteUrl: 'https://jira.example.test', selfAccountId: 'self-id',
      trackingStartedAt: 1_000, historyFrom: 1_000, identityVerifiedAt: 1_000,
      ruleVersion: JIRA_MENTION_RULE_VERSION, discoveryVersion: 1, committedGeneration: 0,
    }
    const issue = snapshot().issue
    const comment: JiraCommentRecord = {
      commentId: 'incoming-1', issueId: issue.issueId, authorAccountId: 'alice-id', authorDisplayName: 'Alice',
      createdAt: 1_000, updatedAt: 1_000, body: { type: 'doc', version: 1, content: [] }, excerpt: 'Please review',
      visibility: { type: 'group', value: 'jira-developers', identifier: 'group-123' }, availability: 'visible' as const,
    }
    let projection: JiraMentionsProjection = {
      ...emptyProjection(),
      status: 'ready',
      identityVerified: true,
      items: [{
        issue, comment,
        state: {
          issueId: issue.issueId, incomingCommentId: comment.commentId, authorAccountId: 'alice-id',
          sourceCreatedAt: 1_000, sourceUpdatedAt: 1_000, sourceHash: 'source', firstObservedAt: 1_000,
          eligibleEditAt: null, eligibility: 'new', state: 'unanswered', resolvingCommentId: null,
          resolvingCreatedAt: null, ruleVersion: JIRA_MENTION_RULE_VERSION, computedAt: 1_000,
        },
        action: null,
        authors: [{ accountId: 'alice-id', displayName: 'Alice', sources: ['comment'] }],
      }],
    }
    const repo = {
      markInterruptedWork: vi.fn(),
      getContext: vi.fn(() => context),
      getSyncState: vi.fn(() => ({
        lastAttemptAt: null, lastSuccessAt: null, lastSuccessStartedAt: null, lastFullAt: null,
        checkpoint: null, coverageFrom: null, coverageThrough: null, backfillComplete: false,
        generation: 0, retryNotBefore: null, lastOutcome: null, lastErrorCode: null,
      })),
      ensureVerifiedContext: vi.fn(() => context),
      getIssueIdsForRecheck: vi.fn(() => []),
      startRun: vi.fn((_contextId, input) => ({ ...input, contextId: 'ctx', runId: 'visibility-test' })),
      setExpectedIssueCount: vi.fn(),
      commitRun: vi.fn(),
      failRun: vi.fn(),
      getProjection: vi.fn(() => projection),
      startReplyAttempt: vi.fn(() => ({ attemptId: 'attempt-1' })),
      finishReplyAttempt: vi.fn(),
      applyConfirmedReply: vi.fn(),
    }
    let postedVisibility: JiraCommentRecord['visibility'] | undefined = null
    let searchCount = 0
    const client = {
      getIdentity: vi.fn(async () => ({ accountId: 'self-id', displayName: 'Self', timeZone: 'UTC' })),
      getUserFieldIds: vi.fn(async () => []),
      searchAll: vi.fn(async () => {
        searchCount++
        if (searchCount === 2) {
          projection = {
            ...projection,
            items: [{ ...projection.items[0], comment: { ...comment, visibility: { type: 'unsupported', value: 'service_desk' } } }],
          }
        }
        return []
      }),
      fetchIssueSnapshot: vi.fn(),
      postComment: vi.fn(async (_settings: unknown, _issueId: string, body: unknown, visibility: JiraCommentRecord['visibility']) => ({
        commentId: 'reply-1', authorAccountId: 'self-id', createdAt: 3_000, updatedAt: 3_000,
        body, excerpt: 'I will review this.', visibility: postedVisibility === undefined ? visibility : postedVisibility, availability: 'visible' as const,
      })),
    }
    const service = new JiraMentionsService(repo as never, settings, client as never, vi.fn(), { now: () => 2_000 })
    await service.refresh('manual')

    const result = await service.postReply({
      issueId: issue.issueId,
      sourceCommentId: comment.commentId,
      tokens: [{ kind: 'text', id: 'text-1', text: 'I will review this.' }],
    })

    expect(result).toEqual({ ok: false, outcome: 'rejected', errorCode: 'unsupported_audience' })
    expect(client.searchAll).toHaveBeenCalledTimes(2)
    expect(repo.startReplyAttempt).not.toHaveBeenCalled()
    expect(client.postComment).not.toHaveBeenCalled()

    projection = { ...projection, items: [{ ...projection.items[0], comment }] }
    const mismatchedResult = await service.postReply({
      issueId: issue.issueId,
      sourceCommentId: comment.commentId,
      tokens: [{ kind: 'text', id: 'text-2', text: 'I will review this.' }],
    })
    expect(mismatchedResult).toEqual({ ok: false, outcome: 'unknown', errorCode: 'invalid_response' })
    expect(client.postComment).toHaveBeenCalledWith(settings.getStoredSettings(), issue.issueId, expect.any(Object), {
      type: 'group', value: 'jira-developers', identifier: 'group-123',
    }, issue.issueKey)
    expect(repo.finishReplyAttempt).toHaveBeenCalledWith('ctx', 'attempt-1', expect.objectContaining({
      outcome: 'unknown', errorCode: 'invalid_response',
    }))

    const serviceDeskVisibility = { type: 'service_desk', value: 'public' } as const
    postedVisibility = serviceDeskVisibility
    projection = { ...projection, items: [{ ...projection.items[0], comment: { ...comment, visibility: serviceDeskVisibility } }] }
    const serviceDeskResult = await service.postReply({
      issueId: issue.issueId,
      sourceCommentId: comment.commentId,
      tokens: [{ kind: 'text', id: 'text-3', text: 'I will review this.' }],
    })
    expect(serviceDeskResult).toEqual({ ok: true, commentId: 'reply-1' })
    expect(client.postComment).toHaveBeenLastCalledWith(settings.getStoredSettings(), issue.issueId, expect.any(Object), serviceDeskVisibility, issue.issueKey)
    await service.close()
  })

  it('opens only attachment URLs from the current cached Jira issue on the configured site', async () => {
    const settings = settingsStore()
    const context = {
      contextId: 'ctx', siteUrl: 'https://jira.example.test', selfAccountId: 'self-id',
      trackingStartedAt: 0, historyFrom: 0, identityVerifiedAt: 0,
      ruleVersion: JIRA_MENTION_RULE_VERSION, discoveryVersion: 1, committedGeneration: 0,
    }
    const detail = snapshot()
    detail.issue.attachments = [
      { id: 'safe', name: 'safe.txt', contentUrl: 'https://jira.example.test/rest/api/3/attachment/content/safe', mimeType: 'text/plain', size: 1, author: null, createdAt: null },
      { id: 'unsafe', name: 'unsafe.txt', contentUrl: 'https://attacker.example/file.txt', mimeType: 'text/plain', size: 1, author: null, createdAt: null },
    ]
    const visibleProjection = {
      ...emptyProjection(),
      items: [{ issue: detail.issue }],
    }
    const repo = {
      markInterruptedWork: vi.fn(),
      getContext: vi.fn(() => context),
      getSyncState: vi.fn(() => ({
        lastAttemptAt: null, lastSuccessAt: null, lastSuccessStartedAt: null, lastFullAt: null,
        checkpoint: null, coverageFrom: null, coverageThrough: null, backfillComplete: false,
        generation: 0, retryNotBefore: null, lastOutcome: null, lastErrorCode: null,
      })),
      ensureVerifiedContext: vi.fn(() => context),
      getIssueIdsForRecheck: vi.fn(() => []),
      startRun: vi.fn((_contextId, input) => ({ ...input, contextId: 'ctx', runId: 'attachment-open' })),
      setExpectedIssueCount: vi.fn(),
      commitRun: vi.fn(),
      failRun: vi.fn(),
      getProjection: vi.fn(() => visibleProjection),
      getIssueDetail: vi.fn(() => detail),
    }
    const client = {
      getIdentity: vi.fn(async () => ({ accountId: 'self-id', displayName: 'Self', timeZone: 'UTC' })),
      getUserFieldIds: vi.fn(async () => []),
      searchAll: vi.fn(async () => []),
      fetchIssueSnapshot: vi.fn(),
    }
    const openExternal = vi.fn()
    const service = new JiraMentionsService(repo as never, settings, client as never, vi.fn(), {
      now: () => 1234,
      openExternal,
    })
    await service.refresh('full')

    await expect(service.openAttachment('100', 'safe')).resolves.toEqual({ ok: true })
    expect(openExternal).toHaveBeenCalledWith('https://jira.example.test/rest/api/3/attachment/content/safe')
    await expect(service.openAttachment('100', 'unsafe')).resolves.toMatchObject({ ok: false })
    await expect(service.openAttachment('100', 'missing')).resolves.toMatchObject({ ok: false })
    expect(openExternal).toHaveBeenCalledOnce()
    await service.close()
  })

  it('publishes a completed empty search as a ready zero-item inbox', async () => {
    const settings = settingsStore()
    const context = {
      contextId: 'ctx', siteUrl: 'https://jira.example.test', selfAccountId: 'self-id',
      trackingStartedAt: 0, historyFrom: 0, identityVerifiedAt: 0,
      ruleVersion: 1, discoveryVersion: 1, committedGeneration: 0,
    }
    let outcome: JiraMentionsProjection = emptyProjection()
    const repo = {
      markInterruptedWork: vi.fn(),
      getContext: vi.fn(() => context),
      getSyncState: vi.fn(() => ({
        lastAttemptAt: null, lastSuccessAt: null, lastSuccessStartedAt: null, lastFullAt: null,
        checkpoint: null, coverageFrom: null, coverageThrough: null, backfillComplete: false,
        generation: 0, retryNotBefore: null, lastOutcome: null, lastErrorCode: null,
      })),
      ensureVerifiedContext: vi.fn(() => context),
      getIssueIdsForRecheck: vi.fn(() => []),
      startRun: vi.fn((_contextId, input) => ({ ...input, contextId: 'ctx', runId: 'empty-run' })),
      setExpectedIssueCount: vi.fn(),
      commitRun: vi.fn(() => {
        outcome = { ...outcome, status: 'ready', lastSuccessAt: 1234, coverageThrough: 1234, cached: true }
      }),
      failRun: vi.fn(),
      getProjection: vi.fn(() => outcome),
    }
    let requestedJql = ''
    const client = {
      getIdentity: vi.fn(async () => ({ accountId: 'self-id', displayName: 'Self', timeZone: 'UTC' })),
      getUserFieldIds: vi.fn(async () => []),
      searchAll: vi.fn(async (_settings: unknown, jql: string) => { requestedJql = jql; return [] }),
      fetchIssueSnapshot: vi.fn(),
    }
    const service = new JiraMentionsService(repo as never, settings, client as never, vi.fn(), { now: () => 1234 })

    const result = await service.refresh('full')

    expect(client.searchAll).toHaveBeenCalledOnce()
    expect(requestedJql).toContain('comment ~ "self-id"')
    expect(repo.setExpectedIssueCount).toHaveBeenCalledWith(expect.objectContaining({ runId: 'empty-run' }), 0)
    expect(client.fetchIssueSnapshot).not.toHaveBeenCalled()
    expect(repo.commitRun).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ status: 'ready', activeCount: 0, items: [], lastSuccessAt: 1234 })
    await service.close()
  })

  it('rechecks a known tracked issue by ID when account-ID JQL omits it', async () => {
    const settings = settingsStore()
    const context = {
      contextId: 'ctx', siteUrl: 'https://jira.example.test', selfAccountId: 'self-id',
      trackingStartedAt: 0, historyFrom: 0, identityVerifiedAt: 0,
      ruleVersion: JIRA_MENTION_RULE_VERSION, discoveryVersion: 1, committedGeneration: 0,
    }
    const trackedCandidate = {
      issueId: '100', issueKey: 'APP-1', updatedMarker: '2026-10-16T12:00:00Z',
      updatedAt: Date.parse('2026-10-16T12:00:00Z'), commentTotal: 1,
      inlineComments: [], inlineStartAt: null, inlineMaxResults: null, summary: 'A test issue',
      project: { id: '10', key: 'APP', name: 'App', projectTypeKey: 'software' },
    }
    const repo = {
      markInterruptedWork: vi.fn(),
      getContext: vi.fn(() => context),
      getSyncState: vi.fn(() => ({
        lastAttemptAt: null, lastSuccessAt: null, lastSuccessStartedAt: null, lastFullAt: null,
        checkpoint: null, coverageFrom: null, coverageThrough: null, backfillComplete: false,
        generation: 0, retryNotBefore: null, lastOutcome: null, lastErrorCode: null,
      })),
      ensureVerifiedContext: vi.fn(() => context),
      getIssueIdsForRecheck: vi.fn(() => ['100']),
      startRun: vi.fn((_contextId, input) => ({ ...input, contextId: 'ctx', runId: 'tracked-recheck' })),
      setExpectedIssueCount: vi.fn(),
      stageIssueSnapshot: vi.fn(),
      commitRun: vi.fn(),
      failRun: vi.fn(),
      getProjection: vi.fn(() => ({ ...emptyProjection(), status: 'ready' as const, lastSuccessAt: 1234, cached: true })),
    }
    let requestedJql = ''
    const client = {
      getIdentity: vi.fn(async () => ({ accountId: 'self-id', displayName: 'Self', timeZone: 'UTC' })),
      getUserFieldIds: vi.fn(async () => []),
      searchAll: vi.fn(async (_settings: unknown, jql: string) => { requestedJql = jql; return [] }),
      getIssueCandidate: vi.fn(async () => trackedCandidate),
      fetchIssueSnapshot: vi.fn(async () => snapshot()),
    }
    const service = new JiraMentionsService(repo as never, settings, client as never, vi.fn(), { now: () => 1234 })

    await service.refresh('full')

    expect(requestedJql).toContain('comment ~ "self-id"')
    expect(client.searchAll).toHaveBeenCalledOnce()
    expect(client.getIssueCandidate).toHaveBeenCalledOnce()
    expect(client.getIssueCandidate).toHaveBeenCalledWith(settings.getStoredSettings(), '100', expect.any(AbortSignal))
    expect(client.fetchIssueSnapshot).toHaveBeenCalledOnce()
    expect(repo.stageIssueSnapshot).toHaveBeenCalledOnce()
    expect(repo.commitRun).toHaveBeenCalledOnce()
    await service.close()
  })

  it('forces a full recheck when cached mention rules are older than the current version', async () => {
    const settings = settingsStore()
    const now = 10_000
    const context = {
      contextId: 'ctx', siteUrl: 'https://jira.example.test', selfAccountId: 'self-id',
      trackingStartedAt: 0, historyFrom: 0, identityVerifiedAt: 0,
      ruleVersion: JIRA_MENTION_RULE_VERSION - 1, discoveryVersion: 1, committedGeneration: 4,
    }
    const sync = {
      lastAttemptAt: now - 600, lastSuccessAt: now - 500, lastSuccessStartedAt: now - 600,
      lastFullAt: now - 400, checkpoint: now - 600, coverageFrom: 0, coverageThrough: now - 600,
      backfillComplete: true, generation: 4, retryNotBefore: null, lastOutcome: 'success' as const, lastErrorCode: null,
    }
    const runInputs: Array<Record<string, unknown>> = []
    const repo = {
      markInterruptedWork: vi.fn(),
      getContext: vi.fn(() => context),
      getSyncState: vi.fn(() => sync),
      ensureVerifiedContext: vi.fn(() => context),
      getIssueIdsForRecheck: vi.fn(() => []),
      startRun: vi.fn((_contextId, input) => {
        runInputs.push(input)
        return { ...input, contextId: 'ctx', runId: 'rule-upgrade' }
      }),
      setExpectedIssueCount: vi.fn(),
      stageIssueSnapshot: vi.fn(),
      commitRun: vi.fn(),
      failRun: vi.fn(),
      getProjection: vi.fn(() => ({ ...emptyProjection(), status: 'ready' as const, lastSuccessAt: now, cached: true })),
    }
    const client = {
      getIdentity: vi.fn(async () => ({ accountId: 'self-id', displayName: 'Self', timeZone: 'UTC' })),
      getUserFieldIds: vi.fn(async () => []),
      searchAll: vi.fn(async () => []),
      fetchIssueSnapshot: vi.fn(),
    }
    const service = new JiraMentionsService(repo as never, settings, client as never, vi.fn(), { now: () => now })

    await service.refresh('manual')

    expect(repo.getIssueIdsForRecheck).toHaveBeenCalledWith('ctx', true)
    expect(runInputs).toEqual([expect.objectContaining({ kind: 'full', ruleVersion: JIRA_MENTION_RULE_VERSION })])
    expect(client.searchAll).toHaveBeenCalledOnce()
    expect(repo.commitRun).toHaveBeenCalledOnce()
    await service.close()
  })

  it('purges cached issue state when access is lost during a refresh', async () => {
    const settings = settingsStore()
    const context = {
      contextId: 'ctx', siteUrl: 'https://jira.example.test', selfAccountId: 'self-id',
      trackingStartedAt: 0, historyFrom: 0, identityVerifiedAt: 0,
      ruleVersion: JIRA_MENTION_RULE_VERSION, discoveryVersion: 1, committedGeneration: 0,
    }
    const repo = {
      markInterruptedWork: vi.fn(),
      getContext: vi.fn(() => context),
      getSyncState: vi.fn(() => ({
        lastAttemptAt: null, lastSuccessAt: null, lastSuccessStartedAt: null, lastFullAt: null,
        checkpoint: null, coverageFrom: null, coverageThrough: null, backfillComplete: false,
        generation: 0, retryNotBefore: null, lastOutcome: null, lastErrorCode: null,
      })),
      ensureVerifiedContext: vi.fn(() => context),
      getIssueIdsForRecheck: vi.fn(() => []),
      startRun: vi.fn((_contextId, input) => ({ ...input, contextId: 'ctx', runId: 'access-loss' })),
      setExpectedIssueCount: vi.fn(),
      fetchIssueSnapshot: vi.fn(),
      purgeIssueAccess: vi.fn(),
      stageIssueFailure: vi.fn(),
      failRun: vi.fn(),
      commitRun: vi.fn(),
      getProjection: vi.fn(() => ({ ...emptyProjection(), status: 'partial' as const, errorCode: 'permission' })),
    }
    const client = {
      getIdentity: vi.fn(async () => ({ accountId: 'self-id', displayName: 'Self', timeZone: 'UTC' })),
      getUserFieldIds: vi.fn(async () => []),
      searchAll: vi.fn(async () => [{
        issueId: '100', issueKey: 'APP-1', updatedMarker: null, updatedAt: null, commentTotal: 0,
        inlineComments: [], inlineStartAt: 0, inlineMaxResults: 20, summary: 'A test issue',
        project: { id: '10', key: 'APP', name: 'App', projectTypeKey: 'software' },
      }]),
      fetchIssueSnapshot: vi.fn(async () => { throw new JiraApiError('permission', null, 403) }),
    }
    const service = new JiraMentionsService(repo as never, settings, client as never, vi.fn(), { now: () => 2_000 })

    const result = await service.refresh('full')

    expect(repo.purgeIssueAccess).toHaveBeenCalledOnce()
    expect(repo.purgeIssueAccess).toHaveBeenCalledWith('ctx', '100')
    expect(repo.stageIssueFailure).not.toHaveBeenCalled()
    expect(repo.failRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'access-loss' }), 2_000, 'permission', 32_000, true)
    expect(result).toMatchObject({ status: 'error', errorCode: 'permission', activeCount: 0 })
    await service.close()
  })

  it('coalesces overlapping refreshes and publishes the verified scan once', async () => {
    const settings = settingsStore()
    let now = 1_000
    const context = {
      contextId: 'ctx', siteUrl: 'https://jira.example.test', selfAccountId: 'self-id',
      trackingStartedAt: 0, historyFrom: 0, identityVerifiedAt: 0,
      ruleVersion: 1, discoveryVersion: 1, committedGeneration: 0,
    }
    let outcome: JiraMentionsProjection = emptyProjection()
    const repo = {
      markInterruptedWork: vi.fn(),
      getContext: vi.fn(() => context),
      getSyncState: vi.fn(() => ({
        lastAttemptAt: null, lastSuccessAt: null, lastSuccessStartedAt: null, lastFullAt: null,
        checkpoint: null, coverageFrom: null, coverageThrough: null, backfillComplete: false,
        generation: 0, retryNotBefore: null, lastOutcome: null, lastErrorCode: null,
      })),
      ensureVerifiedContext: vi.fn(() => context),
      getIssueIdsForRecheck: vi.fn(() => []),
      startRun: vi.fn((_contextId, input) => {
        outcome = { ...outcome, status: 'loading' }
        return { ...input, contextId: 'ctx', runId: 'run-1' }
      }),
      setExpectedIssueCount: vi.fn(),
      stageIssueSnapshot: vi.fn(),
      stageIssueFailure: vi.fn(),
      commitRun: vi.fn(() => { outcome = { ...outcome, status: 'ready', lastSuccessAt: now, cached: true } }),
      failRun: vi.fn(),
      getProjection: vi.fn(() => outcome),
    }
    const fetchStarted = vi.fn()
    let releaseSearch: () => void = () => undefined
    const client = {
      getIdentity: vi.fn(async () => ({ accountId: 'self-id', displayName: 'Self', timeZone: 'UTC' })),
      getUserFieldIds: vi.fn(async () => []),
      searchAll: vi.fn(async () => {
        fetchStarted()
        await new Promise<void>((resolve) => { releaseSearch = resolve })
        return [{
          issueId: '100', issueKey: 'APP-1', updatedMarker: null, updatedAt: null, commentTotal: 0,
          inlineComments: [], inlineStartAt: 0, inlineMaxResults: 20, summary: 'A test issue',
          project: { id: '10', key: 'APP', name: 'App', projectTypeKey: 'software' },
        }]
      }),
      fetchIssueSnapshot: vi.fn(async () => snapshot()),
    }
    const broadcasts: JiraMentionsProjection[] = []
    const service = new JiraMentionsService(repo as never, settings, client as never, (state) => broadcasts.push(state), { now: () => now })
    const first = service.refresh('manual')
    await vi.waitFor(() => expect(fetchStarted).toHaveBeenCalledTimes(1))
    const second = service.refresh('manual')
    releaseSearch()
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(client.getIdentity).toHaveBeenCalledTimes(1)
    expect(client.searchAll).toHaveBeenCalledTimes(1)
    expect(client.fetchIssueSnapshot).toHaveBeenCalledTimes(1)
    expect(repo.commitRun).toHaveBeenCalledTimes(1)
    expect(firstResult.status).toBe('ready')
    expect(secondResult.status).toBe('ready')
    expect(broadcasts.some((state) => state.status === 'loading')).toBe(true)
    expect(settings.getVerifiedIdentityBinding()).toMatchObject({ contextId: 'ctx', accountId: 'self-id' })

    now += 5 * 60_000 + 1
    const staleOpenCheck = service.refresh('open-if-stale')
    await vi.waitFor(() => expect(client.searchAll).toHaveBeenCalledTimes(2))
    releaseSearch()
    await staleOpenCheck
    await service.close()
  })

  it('does not commit an in-flight scan after tracking is disabled', async () => {
    const settings = settingsStore()
    const context = {
      contextId: 'ctx', siteUrl: 'https://jira.example.test', selfAccountId: 'self-id',
      trackingStartedAt: 0, historyFrom: 0, identityVerifiedAt: 0,
      ruleVersion: JIRA_MENTION_RULE_VERSION, discoveryVersion: 1, committedGeneration: 0,
    }
    const repo = {
      markInterruptedWork: vi.fn(),
      getContext: vi.fn(() => context),
      getSyncState: vi.fn(() => ({
        lastAttemptAt: null, lastSuccessAt: null, lastSuccessStartedAt: null, lastFullAt: null,
        checkpoint: null, coverageFrom: null, coverageThrough: null, backfillComplete: false,
        generation: 0, retryNotBefore: null, lastOutcome: null, lastErrorCode: null,
      })),
      ensureVerifiedContext: vi.fn(() => context),
      getIssueIdsForRecheck: vi.fn(() => []),
      startRun: vi.fn((_contextId, input) => ({ ...input, contextId: 'ctx', runId: 'in-flight' })),
      setExpectedIssueCount: vi.fn(),
      stageIssueSnapshot: vi.fn(),
      stageIssueFailure: vi.fn(),
      commitRun: vi.fn(),
      failRun: vi.fn(),
      getProjection: vi.fn(() => emptyProjection()),
    }
    let searchStarted!: () => void
    const started = new Promise<void>((resolve) => { searchStarted = resolve })
    const client = {
      getIdentity: vi.fn(async () => ({ accountId: 'self-id', displayName: 'Self', timeZone: 'UTC' })),
      getUserFieldIds: vi.fn(async () => []),
      searchAll: vi.fn(async (_settings: unknown, _jql: string, signal: AbortSignal) => {
        searchStarted()
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        return []
      }),
      fetchIssueSnapshot: vi.fn(),
    }
    const service = new JiraMentionsService(repo as never, settings, client as never, vi.fn(), { now: () => 5_000 })
    const refresh = service.refresh('manual')
    await started

    const current = settings.getStoredSettings()
    const credentialKey = settings.getCredentialRecordKey()!
    expect(settings.save({
      baseUrl: current.baseUrl, email: current.email, apiToken: current.token!, patterns: current.patterns,
      mentionsEnabled: false, mentionsPollingEnabled: current.mentionsPollingEnabled,
      mentionsPollingMinutes: current.mentionsPollingMinutes,
    }).ok).toBe(true)
    await service.settingsChanged(null, credentialKey, true)
    const result = await refresh

    expect(result).toMatchObject({ enabled: false, status: 'not-configured' })
    expect(repo.commitRun).not.toHaveBeenCalled()
    expect(repo.failRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'in-flight' }), 5_000, 'network', expect.any(Number), false)
    await service.close()
  })

  it('does not start another refresh before Jira Retry-After expires', async () => {
    const settings = settingsStore()
    let now = 9_000
    const retryAt = 10_000
    const context = {
      contextId: 'ctx', siteUrl: 'https://jira.example.test', selfAccountId: 'self-id',
      trackingStartedAt: 0, historyFrom: 0, identityVerifiedAt: 0,
      ruleVersion: JIRA_MENTION_RULE_VERSION, discoveryVersion: 1, committedGeneration: 0,
    }
    const outcome: { value: JiraMentionsProjection } = { value: emptyProjection() }
    const repo = {
      markInterruptedWork: vi.fn(),
      getContext: vi.fn(() => context),
      getSyncState: vi.fn(() => ({
        lastAttemptAt: 8_000, lastSuccessAt: null, lastSuccessStartedAt: null, lastFullAt: null,
        checkpoint: null, coverageFrom: null, coverageThrough: null, backfillComplete: false,
        generation: 0, retryNotBefore: retryAt, lastOutcome: 'failure' as const, lastErrorCode: 'rate_limited',
      })),
      ensureVerifiedContext: vi.fn(() => context),
      getIssueIdsForRecheck: vi.fn(() => []),
      startRun: vi.fn((_contextId, input) => ({ ...input, contextId: 'ctx', runId: 'after-retry' })),
      setExpectedIssueCount: vi.fn(),
      stageIssueSnapshot: vi.fn(),
      stageIssueFailure: vi.fn(),
      commitRun: vi.fn(() => { outcome.value = { ...emptyProjection(), status: 'ready', lastSuccessAt: now, cached: true } }),
      failRun: vi.fn(),
      getProjection: vi.fn(() => outcome.value),
    }
    const client = {
      getIdentity: vi.fn(async () => ({ accountId: 'self-id', displayName: 'Self', timeZone: 'UTC' })),
      getUserFieldIds: vi.fn(async () => []),
      searchAll: vi.fn(async () => []),
      fetchIssueSnapshot: vi.fn(),
    }
    const service = new JiraMentionsService(repo as never, settings, client as never, vi.fn(), { now: () => now })

    await expect(service.refresh('manual')).resolves.toMatchObject({ errorCode: 'rate_limited' })
    expect(repo.startRun).not.toHaveBeenCalled()
    expect(client.searchAll).not.toHaveBeenCalled()

    now = retryAt
    await expect(service.refresh('manual')).resolves.toMatchObject({ status: 'ready', lastSuccessAt: retryAt })
    expect(client.searchAll).toHaveBeenCalledOnce()
    expect(repo.startRun).toHaveBeenCalledOnce()
    await service.close()
  })

  it('keeps stale-generation conflicts out of backoff and accepts an immediate refresh', async () => {
    const settings = settingsStore()
    const context = {
      contextId: 'ctx', siteUrl: 'https://jira.example.test', selfAccountId: 'self-id',
      trackingStartedAt: 0, historyFrom: 0, identityVerifiedAt: 0,
      ruleVersion: 1, discoveryVersion: 1, committedGeneration: 0,
    }
    let outcome: JiraMentionsProjection = emptyProjection()
    let commits = 0
    const repo = {
      markInterruptedWork: vi.fn(),
      getContext: vi.fn(() => context),
      getSyncState: vi.fn(() => ({
        lastAttemptAt: null, lastSuccessAt: null, lastSuccessStartedAt: null, lastFullAt: null,
        checkpoint: null, coverageFrom: null, coverageThrough: null, backfillComplete: false,
        generation: 0, retryNotBefore: null, lastOutcome: null, lastErrorCode: null,
      })),
      ensureVerifiedContext: vi.fn(() => context),
      getIssueIdsForRecheck: vi.fn(() => []),
      startRun: vi.fn((_contextId, input) => ({ ...input, contextId: 'ctx', runId: `run-${commits}` })),
      setExpectedIssueCount: vi.fn(),
      stageIssueSnapshot: vi.fn(),
      failRun: vi.fn(() => { outcome = { ...outcome, status: 'partial', errorCode: 'superseded' } }),
      commitRun: vi.fn(() => {
        commits++
        if (commits === 1) throw Object.assign(new Error('reply committed during scan'), { code: 'stale_generation' })
        outcome = { ...outcome, status: 'ready', lastSuccessAt: 2_000, cached: true }
      }),
      getProjection: vi.fn(() => outcome),
    }
    const client = {
      getIdentity: vi.fn(async () => ({ accountId: 'self-id', displayName: 'Self', timeZone: 'UTC' })),
      getUserFieldIds: vi.fn(async () => []),
      searchAll: vi.fn(async () => [{
        issueId: '100', issueKey: 'APP-1', updatedMarker: null, updatedAt: null, commentTotal: 0,
        inlineComments: [], inlineStartAt: 0, inlineMaxResults: 20, summary: 'A test issue',
        project: { id: '10', key: 'APP', name: 'App', projectTypeKey: 'software' },
      }]),
      fetchIssueSnapshot: vi.fn(async () => snapshot()),
    }
    const service = new JiraMentionsService(repo as never, settings, client as never, vi.fn(), { now: () => 2_000 })

    await expect(service.refresh('manual')).resolves.toMatchObject({ status: 'partial', errorCode: 'partial' })
    expect(repo.failRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-0' }), 2_000, 'superseded', null, true)
    await expect(service.refresh('manual')).resolves.toMatchObject({ status: 'ready', lastSuccessAt: 2_000 })
    expect(client.searchAll).toHaveBeenCalledTimes(2)
    expect(repo.commitRun).toHaveBeenCalledTimes(2)
    await service.close()
  })

  it('does not bind a delayed identity response to credentials saved while it was in flight', async () => {
    const settings = settingsStore()
    const oldCredentialKey = settings.getCredentialRecordKey()
    const contexts = new Map<string, { contextId: string; siteUrl: string; selfAccountId: string; trackingStartedAt: number; historyFrom: number; identityVerifiedAt: number; ruleVersion: number; discoveryVersion: number; committedGeneration: number }>()
    const repository = {
      markInterruptedWork: vi.fn(),
      getContext: vi.fn((contextId: string) => contexts.get(contextId) ?? null),
      getSyncState: vi.fn(() => ({
        lastAttemptAt: null, lastSuccessAt: null, lastSuccessStartedAt: null, lastFullAt: null,
        checkpoint: null, coverageFrom: null, coverageThrough: null, backfillComplete: false,
        generation: 0, retryNotBefore: null, lastOutcome: null, lastErrorCode: null,
      })),
      ensureVerifiedContext: vi.fn((siteUrl: string, selfAccountId: string, now: number) => {
        const context = {
          contextId: `ctx-${selfAccountId}`, siteUrl, selfAccountId, trackingStartedAt: now, historyFrom: now - 7 * 24 * 60 * 60_000,
          identityVerifiedAt: now, ruleVersion: 1, discoveryVersion: 1, committedGeneration: 0,
        }
        contexts.set(context.contextId, context)
        return context
      }),
      getIssueIdsForRecheck: vi.fn(() => []),
      startRun: vi.fn((contextId: string, input: Record<string, unknown>) => ({ ...input, contextId, runId: `run-${contextId}` })),
      setExpectedIssueCount: vi.fn(),
      commitRun: vi.fn(),
      failRun: vi.fn(),
      getProjection: vi.fn((_contextId: string, enabled: boolean, identityVerified: boolean) => ({
        ...emptyProjection(), enabled, identityVerified, status: 'ready' as const,
      })),
    }
    const oldIdentityControl: { release?: (identity: { accountId: string; displayName: string; timeZone: string }) => void } = {}
    const client = {
      getIdentity: vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { oldIdentityControl.release = resolve }))
        .mockResolvedValueOnce({ accountId: 'new-account', displayName: 'New account', timeZone: 'UTC' }),
      getUserFieldIds: vi.fn(async () => []),
      searchAll: vi.fn(async () => []),
      fetchIssueSnapshot: vi.fn(),
    }
    const service = new JiraMentionsService(repository as never, settings, client as never, vi.fn(), { now: () => 2_000 })

    const oldRefresh = service.refresh('full')
    await vi.waitFor(() => expect(client.getIdentity).toHaveBeenCalledTimes(1))
    const current = settings.getStoredSettings()
    const saved = settings.save({
      baseUrl: current.baseUrl,
      email: 'new@example.test',
      apiToken: 'replacement-token',
      patterns: current.patterns,
      mentionsEnabled: current.mentionsEnabled,
      mentionsPollingEnabled: current.mentionsPollingEnabled,
      mentionsPollingMinutes: current.mentionsPollingMinutes,
    })
    expect(saved.ok).toBe(true)
    await service.settingsChanged(null, oldCredentialKey)
    expect(settings.getVerifiedIdentityBinding()).toBeNull()
    oldIdentityControl.release?.({ accountId: 'old-account', displayName: 'Old account', timeZone: 'UTC' })
    await oldRefresh

    await vi.waitFor(() => expect(settings.getVerifiedIdentityBinding()?.accountId).toBe('new-account'))
    expect(repository.ensureVerifiedContext).toHaveBeenCalledTimes(1)
    expect(repository.ensureVerifiedContext).toHaveBeenCalledWith(current.baseUrl, 'new-account', 2_000)
    expect(client.searchAll).toHaveBeenCalledTimes(1)
    await service.close()
  })

  it('starts with an unreadable cached projection and reports a recoverable database error', async () => {
    const settings = settingsStore()
    const credentialKey = settings.getCredentialRecordKey()!
    settings.saveVerifiedIdentityBinding(credentialKey, {
      contextId: 'ctx', siteUrl: 'https://jira.example.test', accountId: 'self-id',
      verifiedAt: 1_000, credentialRecordKey: credentialKey,
    })
    const context = {
      contextId: 'ctx', siteUrl: 'https://jira.example.test', selfAccountId: 'self-id',
      trackingStartedAt: 0, historyFrom: 0, identityVerifiedAt: 0,
      ruleVersion: JIRA_MENTION_RULE_VERSION, discoveryVersion: 1, committedGeneration: 0,
    }
    const repo = {
      markInterruptedWork: vi.fn(),
      getContext: vi.fn(() => context),
      getSyncState: vi.fn(() => ({
        lastAttemptAt: null, lastSuccessAt: null, lastSuccessStartedAt: null, lastFullAt: null,
        checkpoint: null, coverageFrom: null, coverageThrough: null, backfillComplete: false,
        generation: 0, retryNotBefore: null, lastOutcome: null, lastErrorCode: null,
      })),
      getIssueIdsForRecheck: vi.fn(() => []),
      startRun: vi.fn((_contextId, input) => ({ ...input, contextId: 'ctx', runId: 'cache-recovery' })),
      setExpectedIssueCount: vi.fn(),
      commitRun: vi.fn(),
      failRun: vi.fn(),
      getProjection: vi.fn(() => { throw Object.assign(new Error('unreadable Jira cache row'), { code: 'invalid_cache' }) }),
    }
    const client = {
      getIdentity: vi.fn(async () => ({ accountId: 'self-id', displayName: 'Self', timeZone: 'UTC' })),
      getUserFieldIds: vi.fn(async () => []),
      searchAll: vi.fn(async () => []),
      fetchIssueSnapshot: vi.fn(),
    }
    const service = new JiraMentionsService(repo as never, settings, client as never, vi.fn())

    await expect(service.start()).resolves.toBeUndefined()
    await vi.waitFor(() => expect(client.searchAll).toHaveBeenCalledOnce())
    expect(service.getState()).toMatchObject({ status: 'error', errorCode: 'database_unavailable', items: [] })
    await service.close()
  })

  it('sanitizes Jira refresh failures without logging their sensitive error text', async () => {
    const settings = settingsStore()
    const context = {
      contextId: 'ctx', siteUrl: 'https://jira.example.test', selfAccountId: 'self-id',
      trackingStartedAt: 0, historyFrom: 0, identityVerifiedAt: 0,
      ruleVersion: JIRA_MENTION_RULE_VERSION, discoveryVersion: 1, committedGeneration: 0,
    }
    const repo = {
      markInterruptedWork: vi.fn(),
      getContext: vi.fn(() => context),
      getSyncState: vi.fn(() => ({
        lastAttemptAt: null, lastSuccessAt: null, lastSuccessStartedAt: null, lastFullAt: null,
        checkpoint: null, coverageFrom: null, coverageThrough: null, backfillComplete: false,
        generation: 0, retryNotBefore: null, lastOutcome: null, lastErrorCode: null,
      })),
      ensureVerifiedContext: vi.fn(() => context),
      getIssueIdsForRecheck: vi.fn(() => []),
      startRun: vi.fn((_contextId, input) => ({ ...input, contextId: 'ctx', runId: 'safe-error' })),
      failRun: vi.fn(),
      getProjection: vi.fn(() => emptyProjection()),
    }
    const sensitiveError = 'token=synthetic-secret comment=private-reply-body'
    const client = {
      getIdentity: vi.fn(async () => ({ accountId: 'self-id', displayName: 'Self', timeZone: 'UTC' })),
      getUserFieldIds: vi.fn(async () => []),
      searchAll: vi.fn(async () => { throw new Error(sensitiveError) }),
      fetchIssueSnapshot: vi.fn(),
    }
    const service = new JiraMentionsService(repo as never, settings, client as never, vi.fn())
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const infoLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      const result = await service.refresh('manual')
      expect(result).toMatchObject({ status: 'error', errorCode: 'refresh_failed' })
      expect(JSON.stringify(result)).not.toContain(sensitiveError)
      expect(errorLog).not.toHaveBeenCalled()
      expect(warningLog).not.toHaveBeenCalled()
      expect(infoLog).not.toHaveBeenCalled()
    } finally {
      errorLog.mockRestore()
      warningLog.mockRestore()
      infoLog.mockRestore()
      await service.close()
    }
  })

  it('clears the previous Jira context when credentials are removed', async () => {
    const settings = settingsStore()
    const oldCredentialKey = settings.getCredentialRecordKey()!
    const oldBinding = {
      contextId: 'old-context', siteUrl: 'https://jira.example.test', accountId: 'self-id',
      verifiedAt: 1_000, credentialRecordKey: oldCredentialKey,
    }
    expect(settings.saveVerifiedIdentityBinding(oldCredentialKey, oldBinding)).toBe(true)
    const repository = { deleteContext: vi.fn() }
    const service = new JiraMentionsService(repository as never, settings, {} as never, vi.fn())

    const current = settings.getStoredSettings()
    const saved = settings.save({
      baseUrl: current.baseUrl, email: current.email, clearToken: true, patterns: current.patterns,
      mentionsEnabled: current.mentionsEnabled, mentionsPollingEnabled: current.mentionsPollingEnabled,
      mentionsPollingMinutes: current.mentionsPollingMinutes,
    })
    expect(saved.ok).toBe(true)
    await service.settingsChanged(oldBinding, oldCredentialKey)

    expect(settings.getCredentialRecordKey()).toBeNull()
    expect(settings.getVerifiedIdentityBinding()).toBeNull()
    expect(repository.deleteContext).toHaveBeenCalledOnce()
    expect(repository.deleteContext).toHaveBeenCalledWith('old-context')
    await service.close()
  })

  it('refreshes at startup, schedules optional polling, and leaves polling off by default', async () => {
    const timers: Array<{ callback: () => void; delayMs: number; handle: ReturnType<typeof setTimeout> }> = []
    const setTimer = vi.fn((callback: () => void, delayMs: number) => {
      const handle = {} as ReturnType<typeof setTimeout>
      timers.push({ callback, delayMs, handle })
      return handle
    })
    const clearTimer = vi.fn()
    const client = { getIdentity: vi.fn(async () => ({ accountId: 'self-id', displayName: 'Self', timeZone: 'UTC' })) }

    const disabledSettings = settingsStore()
    const disabled = new JiraMentionsService(null, disabledSettings, client as never, vi.fn(), { setTimer, clearTimer })
    await disabled.start()
    await vi.waitFor(() => expect(client.getIdentity).toHaveBeenCalledTimes(1))
    expect(timers).toHaveLength(0)
    await disabled.close()

    const pollingSettings = settingsStore(true)
    const pollingClient = { getIdentity: vi.fn(async () => ({ accountId: 'self-id', displayName: 'Self', timeZone: 'UTC' })) }
    const polling = new JiraMentionsService(null, pollingSettings, pollingClient as never, vi.fn(), { setTimer, clearTimer })
    await polling.start()
    await vi.waitFor(() => expect(pollingClient.getIdentity).toHaveBeenCalledTimes(1))
    expect(timers.at(-1)?.delayMs).toBe(15 * 60_000)
    timers.at(-1)?.callback()
    await vi.waitFor(() => expect(timers.length).toBeGreaterThan(1))
    expect(timers.at(-1)?.delayMs).toBe(15 * 60_000)
    const scheduledHandle = timers.at(-1)!.handle
    const current = pollingSettings.getStoredSettings()
    expect(pollingSettings.save({
      baseUrl: current.baseUrl, email: current.email, apiToken: current.token!, patterns: current.patterns,
      mentionsEnabled: true, mentionsPollingEnabled: false, mentionsPollingMinutes: current.mentionsPollingMinutes,
    }).ok).toBe(true)
    const credentialKey = pollingSettings.getCredentialRecordKey()!
    await polling.settingsChanged(null, credentialKey)
    expect(clearTimer).toHaveBeenCalledWith(scheduledHandle)
    expect(timers).toHaveLength(2)
    await polling.close()
    expect(clearTimer).toHaveBeenCalled()
  })

  it('publishes a snooze wake-up at expiry without another Jira request', async () => {
    const settings = settingsStore()
    let now = 10_000
    const snoozeUntil = now + 5_000
    const context = {
      contextId: 'ctx', siteUrl: 'https://jira.example.test', selfAccountId: 'self-id',
      trackingStartedAt: 0, historyFrom: 0, identityVerifiedAt: 0,
      ruleVersion: JIRA_MENTION_RULE_VERSION, discoveryVersion: 1, committedGeneration: 0,
    }
    const issue = snapshot().issue
    const mention = {
      issue,
      comment: {
        commentId: 'incoming-1', issueId: issue.issueId, authorAccountId: 'alice-id', authorDisplayName: 'Alice',
        createdAt: 1_000, updatedAt: 1_000, body: { type: 'doc', content: [] }, excerpt: 'Request',
        visibility: null, availability: 'visible',
      },
      state: {
        issueId: issue.issueId, incomingCommentId: 'incoming-1', authorAccountId: 'alice-id',
        sourceCreatedAt: 1_000, sourceUpdatedAt: 1_000, sourceHash: '', firstObservedAt: 1_000,
        eligibleEditAt: null, eligibility: 'new', state: 'unanswered', resolvingCommentId: null,
        resolvingCreatedAt: null, ruleVersion: JIRA_MENTION_RULE_VERSION, computedAt: 1_000,
      },
      action: { issueId: issue.issueId, incomingCommentId: 'incoming-1', disposition: 'snoozed', snoozeUntil, updatedAt: now },
      authors: [],
    } as JiraMentionsProjection['items'][number]
    const syncState = {
      lastAttemptAt: null, lastSuccessAt: null, lastSuccessStartedAt: null, lastFullAt: null,
      checkpoint: null, coverageFrom: null, coverageThrough: null, backfillComplete: false,
      generation: 0, retryNotBefore: null, lastOutcome: null, lastErrorCode: null,
    }
    const repo = {
      markInterruptedWork: vi.fn(),
      getContext: vi.fn(() => context),
      getSyncState: vi.fn(() => syncState),
      ensureVerifiedContext: vi.fn(() => context),
      getIssueIdsForRecheck: vi.fn(() => []),
      startRun: vi.fn((_contextId, input) => ({ ...input, contextId: 'ctx', runId: 'snooze-wake' })),
      setExpectedIssueCount: vi.fn(),
      commitRun: vi.fn(),
      failRun: vi.fn(),
      getProjection: vi.fn((_contextId: string, enabled: boolean, identityVerified: boolean, at: number) => ({
        ...emptyProjection(), enabled, identityVerified, activeCount: at >= snoozeUntil ? 1 : 0, items: [mention],
      })),
    }
    const timers: Array<{ callback: () => void; delayMs: number }> = []
    const broadcasts: JiraMentionsProjection[] = []
    const client = {
      getIdentity: vi.fn(async () => ({ accountId: 'self-id', displayName: 'Self', timeZone: 'UTC' })),
      getUserFieldIds: vi.fn(async () => []),
      searchAll: vi.fn(async () => []),
      fetchIssueSnapshot: vi.fn(),
    }
    const service = new JiraMentionsService(repo as never, settings, client as never,
      (projection) => broadcasts.push(projection), {
        now: () => now,
        setTimer: (callback, delayMs) => {
          timers.push({ callback, delayMs })
          return {} as ReturnType<typeof setTimeout>
        },
        clearTimer: vi.fn(),
      })

    await service.refresh('manual')
    expect(timers.at(-1)?.delayMs).toBe(5_000)
    now = snoozeUntil
    timers.at(-1)?.callback()
    expect(broadcasts.at(-1)?.activeCount).toBe(1)
    expect(client.searchAll).toHaveBeenCalledOnce()
    await service.close()
  })
})
