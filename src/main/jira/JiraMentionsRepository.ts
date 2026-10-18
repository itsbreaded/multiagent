import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { normalizeJiraBaseUrl } from '../../shared/jira'
import {
  classifyJiraIssueMentions,
  extractAdfPlainText,
  extractMentionAccountIds,
  extractStructuredMentionUsers,
  type ClassifiedJiraMention,
  type JiraCommentRecord,
  type JiraIssueMetadata,
  type JiraIssueSnapshot,
  type JiraMentionAction,
  type JiraMentionEligibility,
  type JiraMentionProjectionItem,
  type JiraMentionsProjection,
  type JiraUserReference,
  type PriorJiraMentionEvidence,
} from '../../shared/jiraMentions'

export const JIRA_MENTION_RULE_VERSION = 2
const DISCOVERY_VERSION = 1
const EMPTY_ADF = JSON.stringify({ type: 'doc', version: 1, content: [] })

export interface JiraCacheContext {
  contextId: string
  siteUrl: string
  selfAccountId: string
  trackingStartedAt: number
  historyFrom: number
  identityVerifiedAt: number
  ruleVersion: number
  discoveryVersion: number
  committedGeneration: number
}

export interface JiraSyncState {
  lastAttemptAt: number | null
  lastSuccessAt: number | null
  lastSuccessStartedAt: number | null
  lastFullAt: number | null
  checkpoint: number | null
  coverageFrom: number | null
  coverageThrough: number | null
  backfillComplete: boolean
  generation: number
  retryNotBefore: number | null
  lastOutcome: 'running' | 'success' | 'partial' | 'failed' | 'interrupted' | null
  lastErrorCode: string | null
}

export interface JiraSyncRun {
  contextId: string
  runId: string
  kind: 'initial' | 'incremental' | 'full'
  lowerBound: number
  scanStartedAt: number
  baseGeneration: number
  configGeneration: number
  ruleVersion: number
}

export interface JiraReplyAttempt {
  attemptId: string
  contextId: string
  issueId: string
  outcome: 'sending' | 'confirmed' | 'rejected' | 'unknown'
  bodyHash: string
  mentionedAccountIds: string[]
  returnedCommentId: string | null
  safeErrorCode: string | null
  startedAt: number
  endedAt: number | null
  reconciledAt: number | null
}

export interface JiraRepositoryError extends Error {
  code: 'missing_context' | 'invalid_cache' | 'stale_generation' | 'incomplete_run' | 'missing_issue'
}

interface ContextRow {
  context_id: string
  site_url: string
  self_account_id: string
  tracking_started_at: number
  history_from: number
  identity_verified_at: number
  rule_version: number
  discovery_version: number
  committed_generation: number
}

interface SyncStateRow {
  context_id: string
  last_attempt_run_id: string | null
  last_success_run_id: string | null
  last_success_started_at: number | null
  last_success_ended_at: number | null
  last_full_at: number | null
  checkpoint: number | null
  coverage_from: number | null
  coverage_through: number | null
  backfill_complete: number
  generation: number
  retry_not_before: number | null
}

interface CachedIssueRow {
  context_id: string
  issue_id: string
  issue_key: string
  metadata_json: string
  jira_updated_at: number | null
  metadata_fetched_at: number
  comment_snapshot_at: number | null
  comment_count: number | null
  access_state: 'visible' | 'partial' | 'unavailable'
  generation: number
}

interface CachedCommentRow {
  comment_id: string
  issue_id: string
  author_account_id: string | null
  author_name: string | null
  created_at: number
  updated_at: number
  body_json: string
  excerpt: string
  visibility_json: string
  availability: 'visible' | 'removed' | 'unavailable'
}

function repositoryError(code: JiraRepositoryError['code']): JiraRepositoryError {
  const message = code === 'stale_generation'
    ? 'Refresh results were superseded by a newer Jira update.'
    : code === 'incomplete_run'
      ? 'The Jira refresh did not include a complete issue snapshot.'
      : code === 'missing_issue'
        ? 'The Jira issue is no longer available in the verified inbox.'
        : 'The Jira cache could not be read safely.'
  return Object.assign(new Error(message), { code })
}

function asContext(row: ContextRow): JiraCacheContext {
  return {
    contextId: row.context_id,
    siteUrl: row.site_url,
    selfAccountId: row.self_account_id,
    trackingStartedAt: row.tracking_started_at,
    historyFrom: row.history_from,
    identityVerifiedAt: row.identity_verified_at,
    ruleVersion: row.rule_version,
    discoveryVersion: row.discovery_version,
    committedGeneration: row.committed_generation,
  }
}

function asAction(row: { issue_id: string; incoming_comment_id: string; disposition: 'dismissed' | 'snoozed'; snooze_until: number | null; updated_at: number }): JiraMentionAction {
  return {
    issueId: row.issue_id,
    incomingCommentId: row.incoming_comment_id,
    disposition: row.disposition,
    snoozeUntil: row.snooze_until,
    updatedAt: row.updated_at,
  }
}

function asComment(row: CachedCommentRow, body: unknown, visibility: JiraCommentRecord['visibility']): JiraCommentRecord {
  return {
    commentId: row.comment_id,
    issueId: row.issue_id,
    authorAccountId: row.author_account_id,
    authorDisplayName: row.author_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    body,
    excerpt: row.excerpt,
    visibility,
    availability: row.availability,
  }
}

function parseJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    throw repositoryError('invalid_cache')
  }
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex')
}

function normalizeUserList(users: JiraUserReference[]): JiraUserReference[] {
  const merged = new Map<string, JiraUserReference>()
  for (const user of users) {
    if (!user.accountId) continue
    const existing = merged.get(user.accountId)
    if (!existing) merged.set(user.accountId, { ...user, sources: [...new Set(user.sources)] })
    else merged.set(user.accountId, {
      ...existing,
      displayName: existing.displayName ?? user.displayName,
      avatarUrl: existing.avatarUrl ?? user.avatarUrl,
      active: existing.active ?? user.active,
      sources: [...new Set([...existing.sources, ...user.sources])],
    })
  }
  return [...merged.values()]
}

export class JiraMentionsRepository {
  constructor(private readonly db: Database.Database) {}

  getContextByIdentity(siteUrl: string, accountId: string): JiraCacheContext | null {
    const normalized = normalizeJiraBaseUrl(siteUrl)
    if (!normalized || !accountId) return null
    const row = this.db.prepare(`SELECT * FROM jira_cache_contexts WHERE site_url = ? AND self_account_id = ?`)
      .get(normalized, accountId) as ContextRow | undefined
    return row ? asContext(row) : null
  }

  getContext(contextId: string): JiraCacheContext | null {
    const row = this.db.prepare(`SELECT * FROM jira_cache_contexts WHERE context_id = ?`).get(contextId) as ContextRow | undefined
    return row ? asContext(row) : null
  }

  ensureVerifiedContext(siteUrl: string, accountId: string, verifiedAt: number): JiraCacheContext {
    const normalized = normalizeJiraBaseUrl(siteUrl)
    if (!normalized || !accountId) throw repositoryError('missing_context')
    const contextId = createHash('sha256').update(`${normalized}\0${accountId}`).digest('hex')
    const existing = this.getContext(contextId)
    if (existing) {
      this.db.prepare(`UPDATE jira_cache_contexts SET identity_verified_at = ? WHERE context_id = ?`).run(verifiedAt, contextId)
      return { ...existing, identityVerifiedAt: verifiedAt }
    }
    const historyFrom = verifiedAt - 7 * 24 * 60 * 60 * 1000
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO jira_cache_contexts(
        context_id,site_url,self_account_id,tracking_started_at,history_from,identity_verified_at,
        rule_version,discovery_version,committed_generation,initial_scan_started
      ) VALUES(?,?,?,?,?,?,?,?,0,0)`).run(contextId, normalized, accountId, verifiedAt, historyFrom, verifiedAt, JIRA_MENTION_RULE_VERSION, DISCOVERY_VERSION)
      this.db.prepare(`INSERT INTO jira_sync_state(context_id) VALUES(?)`).run(contextId)
    })()
    return {
      contextId,
      siteUrl: normalized,
      selfAccountId: accountId,
      trackingStartedAt: verifiedAt,
      historyFrom,
      identityVerifiedAt: verifiedAt,
      ruleVersion: JIRA_MENTION_RULE_VERSION,
      discoveryVersion: DISCOVERY_VERSION,
      committedGeneration: 0,
    }
  }

  getSyncState(contextId: string): JiraSyncState {
    const row = this.db.prepare(`
      SELECT s.*, r.scan_started_at, r.ended_at, r.outcome, r.safe_error_code
      FROM jira_sync_state s LEFT JOIN jira_sync_runs r
        ON r.context_id = s.context_id AND r.run_id = s.last_attempt_run_id
      WHERE s.context_id = ?
    `).get(contextId) as (SyncStateRow & {
      scan_started_at: number | null; ended_at: number | null; outcome: JiraSyncState['lastOutcome']; safe_error_code: string | null
    }) | undefined
    if (!row) throw repositoryError('missing_context')
    return {
      lastAttemptAt: row.scan_started_at ?? null,
      lastSuccessAt: row.last_success_ended_at,
      lastSuccessStartedAt: row.last_success_started_at,
      lastFullAt: row.last_full_at,
      checkpoint: row.checkpoint,
      coverageFrom: row.coverage_from,
      coverageThrough: row.coverage_through,
      backfillComplete: row.backfill_complete === 1,
      generation: row.generation,
      retryNotBefore: row.retry_not_before,
      lastOutcome: row.outcome ?? null,
      lastErrorCode: row.safe_error_code ?? null,
    }
  }

  getProjection(contextId: string, enabled: boolean, identityVerified: boolean, now: number): JiraMentionsProjection {
    const context = this.getContext(contextId)
    if (!context) throw repositoryError('missing_context')
    const sync = this.getSyncState(contextId)
    const items = this.getMentionItems(contextId)
    const activeCount = items.filter((item) => isActive(item, now)).length
    const status: JiraMentionsProjection['status'] = sync.lastOutcome === 'running'
      ? 'loading'
      : sync.lastOutcome === 'partial'
        ? 'partial'
        : sync.lastOutcome === 'failed' || sync.lastOutcome === 'interrupted'
          ? 'error'
          : sync.lastSuccessAt === null
            ? 'not-checked'
            : 'ready'
    return {
      enabled,
      identityVerified,
      status,
      errorCode: sync.lastErrorCode,
      activeCount,
      lastAttemptAt: sync.lastAttemptAt,
      lastSuccessAt: sync.lastSuccessAt,
      historyFrom: context.historyFrom,
      coverageThrough: sync.coverageThrough,
      cached: sync.lastSuccessAt !== null,
      items,
    }
  }

  getIssueDetail(contextId: string, issueId: string): JiraIssueSnapshot | null {
    const issueRow = this.db.prepare(`SELECT * FROM jira_cached_issues WHERE context_id = ? AND issue_id = ?`)
      .get(contextId, issueId) as CachedIssueRow | undefined
    if (!issueRow) return null
    const issue = parseJson<JiraIssueMetadata>(issueRow.metadata_json)
    const comments = this.getComments(contextId, issueId)
    const users = this.getIssueUsers(contextId, issueId)
    return {
      issue,
      comments,
      users,
      observedCommentCount: issueRow.comment_count ?? comments.length,
      commentsComplete: issueRow.access_state === 'visible' && issueRow.comment_count !== null && issueRow.comment_count <= comments.length,
      updatedMarker: issueRow.jira_updated_at === null ? null : new Date(issueRow.jira_updated_at).toISOString(),
    }
  }

  getIssueIdsForRecheck(contextId: string, full: boolean): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT issue_id FROM jira_mention_state
      WHERE context_id = ? AND eligibility <> 'excluded'
        AND state IN ('unanswered','answered','unknown')
        AND (? = 1 OR state = 'unanswered')
      ORDER BY issue_id`)
      .all(contextId, full ? 1 : 0) as Array<{ issue_id: string }>
    return rows.map((row) => row.issue_id)
  }

  startRun(contextId: string, input: Omit<JiraSyncRun, 'contextId' | 'runId'>): JiraSyncRun {
    const context = this.getContext(contextId)
    if (!context) throw repositoryError('missing_context')
    const initialScanStarted = Boolean((this.db.prepare(`SELECT initial_scan_started FROM jira_cache_contexts WHERE context_id=?`)
      .get(contextId) as { initial_scan_started: number } | undefined)?.initial_scan_started)
    const isFirstScan = input.kind === 'initial' && !initialScanStarted
    const historyFrom = isFirstScan ? input.scanStartedAt - 7 * 24 * 60 * 60 * 1000 : context.historyFrom
    const run: JiraSyncRun = {
      ...input,
      lowerBound: isFirstScan ? historyFrom : input.lowerBound,
      contextId,
      runId: randomUUID(),
    }
    this.db.transaction(() => {
      if (isFirstScan) {
        this.db.prepare(`UPDATE jira_cache_contexts SET tracking_started_at=?,history_from=?,initial_scan_started=1 WHERE context_id=?`)
          .run(input.scanStartedAt, historyFrom, contextId)
      }
      this.db.prepare(`UPDATE jira_sync_runs SET outcome='interrupted', ended_at=? WHERE context_id=? AND outcome='running'`)
        .run(run.scanStartedAt, contextId)
      this.db.prepare(`INSERT INTO jira_sync_runs(
        context_id,run_id,kind,lower_bound,scan_started_at,base_generation,config_generation,rule_version,outcome
      ) VALUES(?,?,?,?,?,?,?,?, 'running')`).run(
        contextId, run.runId, run.kind, run.lowerBound, run.scanStartedAt,
        run.baseGeneration, run.configGeneration, run.ruleVersion,
      )
      this.db.prepare(`UPDATE jira_sync_state SET last_attempt_run_id=?, retry_not_before=NULL WHERE context_id=?`)
        .run(run.runId, contextId)
    })()
    return run
  }

  stageIssueSnapshot(run: JiraSyncRun, snapshot: JiraIssueSnapshot): void {
    validateSnapshot(snapshot)
    const json = JSON.stringify(snapshot)
    if (!json) throw repositoryError('invalid_cache')
    this.db.prepare(`INSERT INTO jira_sync_issue_work(context_id,run_id,issue_id,outcome,fetched_at,snapshot_json)
      VALUES(?,?,?,'complete',?,?) ON CONFLICT(context_id,run_id,issue_id) DO UPDATE SET
        outcome='complete',fetched_at=excluded.fetched_at,snapshot_json=excluded.snapshot_json`)
      .run(run.contextId, run.runId, snapshot.issue.issueId, Date.now(), json)
    this.db.prepare(`UPDATE jira_sync_runs SET completed_issues=completed_issues+1 WHERE context_id=? AND run_id=?`)
      .run(run.contextId, run.runId)
  }

  stageIssueFailure(run: JiraSyncRun, issueId: string, accessLost: boolean): void {
    this.db.prepare(`INSERT INTO jira_sync_issue_work(context_id,run_id,issue_id,outcome)
      VALUES(?,?,?,?) ON CONFLICT(context_id,run_id,issue_id) DO UPDATE SET outcome=excluded.outcome,snapshot_json=NULL`)
      .run(run.contextId, run.runId, issueId, accessLost ? 'access_lost' : 'failed')
  }

  setExpectedIssueCount(run: JiraSyncRun, count: number): void {
    this.db.prepare(`UPDATE jira_sync_runs SET expected_issues=? WHERE context_id=? AND run_id=?`)
      .run(Math.max(0, Math.floor(count)), run.contextId, run.runId)
  }

  commitRun(run: JiraSyncRun, options: { endedAt: number; retryNotBefore?: number | null; full: boolean }): void {
    const transaction = this.db.transaction(() => {
      const context = this.getContext(run.contextId)
      const sync = this.getSyncRow(run.contextId)
      const runRow = this.db.prepare(`SELECT outcome,expected_issues,completed_issues FROM jira_sync_runs WHERE context_id=? AND run_id=?`)
        .get(run.contextId, run.runId) as { outcome: string; expected_issues: number; completed_issues: number } | undefined
      if (!context || !sync || !runRow) throw repositoryError('missing_context')
      if (runRow.outcome !== 'running' || context.committedGeneration !== run.baseGeneration || sync.generation !== run.baseGeneration) {
        throw repositoryError('stale_generation')
      }
      const work = this.db.prepare(`SELECT issue_id,outcome,snapshot_json FROM jira_sync_issue_work WHERE context_id=? AND run_id=?`)
        .all(run.contextId, run.runId) as Array<{ issue_id: string; outcome: string; snapshot_json: string | null }>
      const incomplete = work.some((item) => item.outcome !== 'complete' || !item.snapshot_json)
        || runRow.completed_issues < runRow.expected_issues
      if (incomplete) throw repositoryError('incomplete_run')

      const nextGeneration = context.committedGeneration + 1
      for (const item of work) {
        const snapshot = parseJson<JiraIssueSnapshot>(item.snapshot_json!)
        this.publishIssueSnapshot(run.contextId, snapshot, nextGeneration, run.scanStartedAt)
      }
      const historyFrom = context.historyFrom
      this.db.prepare(`UPDATE jira_cache_contexts SET committed_generation=? WHERE context_id=?`)
        .run(nextGeneration, run.contextId)
      this.db.prepare(`UPDATE jira_cache_contexts SET rule_version=? WHERE context_id=?`)
        .run(run.ruleVersion, run.contextId)
      this.db.prepare(`UPDATE jira_sync_state SET
        last_success_run_id=?,last_success_started_at=?,last_success_ended_at=?,
        last_full_at=CASE WHEN ? THEN ? ELSE last_full_at END,
        checkpoint=?,coverage_from=?,coverage_through=?,
        backfill_complete=CASE WHEN ? THEN 1 ELSE backfill_complete END,
        generation=?,retry_not_before=NULL
        WHERE context_id=?`).run(
        run.runId, run.scanStartedAt, options.endedAt, options.full ? 1 : 0, options.endedAt,
        run.scanStartedAt, historyFrom, run.scanStartedAt, run.kind === 'initial' || options.full ? 1 : 0,
        nextGeneration, run.contextId,
      )
      this.db.prepare(`UPDATE jira_sync_runs SET outcome='success',ended_at=?,discovery_complete=1,safe_error_code=NULL WHERE context_id=? AND run_id=?`)
        .run(options.endedAt, run.contextId, run.runId)
      this.db.prepare(`UPDATE jira_reply_attempts SET reconciled_at=? WHERE context_id=? AND outcome='unknown'
        AND reconciled_at IS NULL AND issue_id IN (
          SELECT issue_id FROM jira_sync_issue_work WHERE context_id=? AND run_id=? AND outcome='complete'
        )`).run(options.endedAt, run.contextId, run.contextId, run.runId)
      this.db.prepare(`UPDATE jira_sync_runs SET outcome='interrupted',ended_at=? WHERE context_id=? AND outcome='running' AND run_id<>?`)
        .run(options.endedAt, run.contextId, run.runId)
      this.db.prepare(`DELETE FROM jira_sync_issue_work WHERE context_id=? AND run_id=?`).run(run.contextId, run.runId)
      this.pruneRuns(run.contextId)
    })
    try {
      transaction.immediate()
    } catch (error) {
      const code = (error as Partial<JiraRepositoryError>)?.code
      if (code === 'stale_generation' || code === 'incomplete_run' || code === 'missing_context') throw error
      this.failRun(run, options.endedAt, 'cache_commit_failed', options.retryNotBefore ?? null)
      throw repositoryError('invalid_cache')
    }
  }

  failRun(run: JiraSyncRun, endedAt: number, errorCode: string, retryNotBefore: number | null = null, partial = false): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE jira_sync_runs SET outcome=?,ended_at=?,safe_error_code=? WHERE context_id=? AND run_id=? AND outcome='running'`)
        .run(partial ? 'partial' : 'failed', endedAt, safeErrorCode(errorCode), run.contextId, run.runId)
      this.db.prepare(`UPDATE jira_sync_state SET retry_not_before=? WHERE context_id=?`).run(retryNotBefore, run.contextId)
      this.db.prepare(`DELETE FROM jira_sync_issue_work WHERE context_id=? AND run_id=?`).run(run.contextId, run.runId)
    })()
  }

  markInterruptedWork(): void {
    const now = Date.now()
    this.db.transaction(() => {
      this.db.prepare(`UPDATE jira_sync_runs SET outcome='interrupted',ended_at=?,safe_error_code='app_restarted' WHERE outcome='running'`).run(now)
      this.db.prepare(`UPDATE jira_reply_attempts SET outcome='unknown',ended_at=?,safe_error_code='app_restarted' WHERE outcome='sending'`).run(now)
      this.db.prepare(`DELETE FROM jira_sync_issue_work WHERE run_id IN (SELECT run_id FROM jira_sync_runs WHERE outcome='interrupted')`).run()
    })()
  }

  setMentionAction(contextId: string, issueId: string, commentId: string, action: 'dismissed' | 'snoozed' | 'restored', snoozeUntil: number | null, now: number): void {
    if (!this.getContext(contextId)) throw repositoryError('missing_context')
    if (action === 'restored') {
      this.db.prepare(`DELETE FROM jira_mention_actions WHERE context_id=? AND issue_id=? AND incoming_comment_id=?`)
        .run(contextId, issueId, commentId)
      return
    }
    if (action === 'snoozed' && (!Number.isFinite(snoozeUntil) || (snoozeUntil as number) <= now)) {
      throw new Error('Invalid snooze time.')
    }
    const exists = this.db.prepare(`SELECT 1 FROM jira_mention_state WHERE context_id=? AND issue_id=? AND incoming_comment_id=? AND state='unanswered'`)
      .get(contextId, issueId, commentId)
    if (!exists) throw repositoryError('missing_issue')
    this.db.prepare(`INSERT INTO jira_mention_actions(context_id,issue_id,incoming_comment_id,disposition,snooze_until,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(context_id,issue_id,incoming_comment_id) DO UPDATE SET
        disposition=excluded.disposition,snooze_until=excluded.snooze_until,updated_at=excluded.updated_at`)
      .run(contextId, issueId, commentId, action, action === 'snoozed' ? snoozeUntil : null, now)
  }

  clearFetchedCache(contextId: string): void {
    const transaction = this.db.transaction(() => {
      const context = this.getContext(contextId)
      if (!context) throw repositoryError('missing_context')
      this.db.prepare(`DELETE FROM jira_sync_issue_work WHERE context_id=?`).run(contextId)
      this.db.prepare(`DELETE FROM jira_sync_runs WHERE context_id=?`).run(contextId)
      this.db.prepare(`DELETE FROM jira_mention_state WHERE context_id=?`).run(contextId)
      this.db.prepare(`DELETE FROM jira_cached_issues WHERE context_id=?`).run(contextId)
      this.db.prepare(`UPDATE jira_cache_contexts SET committed_generation=committed_generation+1 WHERE context_id=?`).run(contextId)
      this.db.prepare(`UPDATE jira_sync_state SET last_attempt_run_id=NULL,last_success_run_id=NULL,
        last_success_started_at=NULL,last_success_ended_at=NULL,last_full_at=NULL,checkpoint=NULL,
        coverage_from=NULL,coverage_through=NULL,backfill_complete=0,generation=generation+1,retry_not_before=NULL
        WHERE context_id=?`).run(contextId)
    })
    transaction.immediate()
  }

  deleteContext(contextId: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM jira_mention_state WHERE context_id=?`).run(contextId)
      this.db.prepare(`DELETE FROM jira_cache_contexts WHERE context_id=?`).run(contextId)
    })()
  }

  purgeIssueAccess(contextId: string, issueId: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM jira_mention_state WHERE context_id=? AND issue_id=?`).run(contextId, issueId)
      this.db.prepare(`DELETE FROM jira_cached_issues WHERE context_id=? AND issue_id=?`).run(contextId, issueId)
      this.db.prepare(`UPDATE jira_cache_contexts SET committed_generation=committed_generation+1 WHERE context_id=?`).run(contextId)
      this.db.prepare(`UPDATE jira_sync_state SET generation=generation+1 WHERE context_id=?`).run(contextId)
    })()
  }

  startReplyAttempt(contextId: string, issueId: string, body: unknown, mentionedAccountIds: string[], startedAt: number): JiraReplyAttempt {
    const attempt: JiraReplyAttempt = {
      attemptId: randomUUID(), contextId, issueId, outcome: 'sending', bodyHash: fingerprint(body),
      mentionedAccountIds: [...new Set(mentionedAccountIds)], returnedCommentId: null, safeErrorCode: null,
      startedAt, endedAt: null, reconciledAt: null,
    }
    this.db.prepare(`INSERT INTO jira_reply_attempts(context_id,attempt_id,issue_id,started_at,outcome,body_hash,mentioned_ids_json)
      VALUES(?,?,?,?,'sending',?,?)`)
      .run(contextId, attempt.attemptId, issueId, startedAt, attempt.bodyHash, JSON.stringify(attempt.mentionedAccountIds))
    return attempt
  }

  finishReplyAttempt(contextId: string, attemptId: string, result: {
    outcome: 'confirmed' | 'rejected' | 'unknown'; endedAt: number; returnedCommentId?: string | null; errorCode?: string | null
  }): void {
    this.db.prepare(`UPDATE jira_reply_attempts SET outcome=?,ended_at=?,returned_comment_id=?,safe_error_code=? WHERE context_id=? AND attempt_id=?`)
      .run(result.outcome, result.endedAt, result.returnedCommentId ?? null, result.errorCode ? safeErrorCode(result.errorCode) : null, contextId, attemptId)
  }

  getUnknownReplyAttempts(contextId: string, issueId: string): JiraReplyAttempt[] {
    return (this.db.prepare(`SELECT * FROM jira_reply_attempts WHERE context_id=? AND issue_id=? AND outcome='unknown' ORDER BY started_at`)
      .all(contextId, issueId) as Array<Record<string, unknown>>).map(mapReplyAttempt)
  }

  getUnreconciledUnknownReplyAttempts(contextId: string, issueId: string): JiraReplyAttempt[] {
    return (this.db.prepare(`SELECT * FROM jira_reply_attempts WHERE context_id=? AND issue_id=?
      AND outcome='unknown' AND reconciled_at IS NULL ORDER BY started_at`)
      .all(contextId, issueId) as Array<Record<string, unknown>>).map(mapReplyAttempt)
  }

  applyConfirmedReply(contextId: string, issueId: string, comment: JiraCommentRecord, attemptId: string): void {
    const transaction = this.db.transaction(() => {
      const context = this.getContext(contextId)
      const issue = this.db.prepare(`SELECT 1 FROM jira_cached_issues WHERE context_id=? AND issue_id=?`).get(contextId, issueId)
      if (!context || !issue || comment.issueId !== issueId || !comment.authorAccountId) throw repositoryError('missing_issue')
      this.saveComment(contextId, comment, context.committedGeneration + 1)
      this.replaceCommentMentions(contextId, issueId, comment.commentId, extractMentionAccountIds(comment.body))
      this.addUsers(contextId, issueId, [
        ...(comment.authorAccountId ? [{ accountId: comment.authorAccountId, displayName: comment.authorDisplayName, sources: ['comment_author'] }] : []),
        ...extractStructuredMentionUsers(comment.body),
      ], context.committedGeneration + 1)
      this.recomputeIssueStates(contextId, issueId, context, context.committedGeneration + 1, comment.updatedAt)
      this.db.prepare(`UPDATE jira_cache_contexts SET committed_generation=committed_generation+1 WHERE context_id=?`).run(contextId)
      this.db.prepare(`UPDATE jira_sync_state SET generation=generation+1 WHERE context_id=?`).run(contextId)
      this.db.prepare(`UPDATE jira_reply_attempts SET outcome='confirmed',ended_at=?,returned_comment_id=?,safe_error_code=NULL WHERE context_id=? AND attempt_id=?`)
        .run(Date.now(), comment.commentId, contextId, attemptId)
    })
    transaction.immediate()
  }

  private getSyncRow(contextId: string): SyncStateRow | undefined {
    return this.db.prepare(`SELECT * FROM jira_sync_state WHERE context_id=?`).get(contextId) as SyncStateRow | undefined
  }

  private publishIssueSnapshot(contextId: string, snapshot: JiraIssueSnapshot, generation: number, observedAt: number): void {
    const { issue } = snapshot
    const oldRows = this.db.prepare(`SELECT * FROM jira_comments WHERE context_id=? AND issue_id=?`)
      .all(contextId, issue.issueId) as CachedCommentRow[]
    const prior = this.getPriorEvidence(contextId, issue.issueId)
    const incomingIds = new Set(snapshot.comments.map((comment) => comment.commentId))

    this.db.prepare(`INSERT INTO jira_cached_issues(
      context_id,issue_id,issue_key,metadata_json,jira_updated_at,metadata_fetched_at,
      comment_snapshot_at,comment_count,access_state,generation
    ) VALUES(?,?,?,?,?,?,?,?, 'visible',?) ON CONFLICT(context_id,issue_id) DO UPDATE SET
      issue_key=excluded.issue_key,metadata_json=excluded.metadata_json,jira_updated_at=excluded.jira_updated_at,
      metadata_fetched_at=excluded.metadata_fetched_at,comment_snapshot_at=excluded.comment_snapshot_at,
      comment_count=excluded.comment_count,access_state='visible',generation=excluded.generation`)
      .run(contextId, issue.issueId, issue.issueKey, JSON.stringify(issue), issue.updatedAt, observedAt,
        observedAt, snapshot.observedCommentCount, generation)

    this.db.prepare(`UPDATE jira_mention_state SET resolving_comment_id=NULL,resolving_created_at=NULL WHERE context_id=? AND issue_id=?`)
      .run(contextId, issue.issueId)
    for (const comment of snapshot.comments) this.saveComment(contextId, comment, generation)
    for (const old of oldRows) {
      if (incomingIds.has(old.comment_id)) continue
      this.db.prepare(`UPDATE jira_comments SET author_account_id=NULL,author_name=NULL,body_json=?,excerpt='',
        visibility_json='null',body_hash=?,availability='removed',fetched_at=?,generation=?
        WHERE context_id=? AND issue_id=? AND comment_id=?`)
        .run(EMPTY_ADF, fingerprint(null), observedAt, generation, contextId, issue.issueId, old.comment_id)
      this.db.prepare(`DELETE FROM jira_comment_mentions WHERE context_id=? AND issue_id=? AND comment_id=?`)
        .run(contextId, issue.issueId, old.comment_id)
    }
    this.db.prepare(`DELETE FROM jira_comment_mentions WHERE context_id=? AND issue_id=? AND comment_id IN
      (SELECT comment_id FROM jira_comments WHERE context_id=? AND issue_id=?)`)
      .run(contextId, issue.issueId, contextId, issue.issueId)
    for (const comment of snapshot.comments) {
      this.replaceCommentMentions(contextId, issue.issueId, comment.commentId, extractMentionAccountIds(comment.body))
    }
    this.db.prepare(`DELETE FROM jira_issue_users WHERE context_id=? AND issue_id=?`).run(contextId, issue.issueId)
    const userCandidates: JiraUserReference[] = [...snapshot.users]
    if (issue.assignee) userCandidates.push({ ...issue.assignee, sources: [...issue.assignee.sources, 'assignee'] })
    if (issue.reporter) userCandidates.push({ ...issue.reporter, sources: [...issue.reporter.sources, 'reporter'] })
    if (issue.creator) userCandidates.push({ ...issue.creator, sources: [...issue.creator.sources, 'creator'] })
    for (const comment of snapshot.comments) {
      if (comment.authorAccountId) userCandidates.push({
        accountId: comment.authorAccountId, displayName: comment.authorDisplayName, sources: ['comment_author'],
      })
      userCandidates.push(...extractStructuredMentionUsers(comment.body))
    }
    this.addUsers(contextId, issue.issueId, userCandidates, generation)

    const allComments = this.getComments(contextId, issue.issueId)
    const classified = classifyJiraIssueMentions({
      comments: allComments,
      selfAccountId: this.getContext(contextId)!.selfAccountId,
      historyFrom: this.getContext(contextId)!.historyFrom,
      trackingStartedAt: this.getContext(contextId)!.trackingStartedAt,
      observedAt,
      previous: prior,
    })
    this.saveClassifications(contextId, issue.issueId, classified, generation, observedAt)
  }

  private recomputeIssueStates(contextId: string, issueId: string, context: JiraCacheContext, generation: number, observedAt: number): void {
    const prior = this.getPriorEvidence(contextId, issueId)
    const comments = this.getComments(contextId, issueId)
    const classified = classifyJiraIssueMentions({
      comments,
      selfAccountId: context.selfAccountId,
      historyFrom: context.historyFrom,
      trackingStartedAt: context.trackingStartedAt,
      observedAt,
      previous: prior,
    })
    this.saveClassifications(contextId, issueId, classified, generation, observedAt)
  }

  private saveClassifications(contextId: string, issueId: string, classified: ClassifiedJiraMention[], generation: number, computedAt: number): void {
    const statement = this.db.prepare(`INSERT INTO jira_mention_state(
      context_id,issue_id,incoming_comment_id,author_account_id,source_created_at,source_updated_at,
      source_hash,first_observed_at,eligible_edit_at,eligibility,state,resolving_comment_id,
      resolving_created_at,rule_version,computed_at,generation
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(context_id,issue_id,incoming_comment_id) DO UPDATE SET
      author_account_id=excluded.author_account_id,source_created_at=excluded.source_created_at,
      source_updated_at=excluded.source_updated_at,source_hash=excluded.source_hash,
      eligible_edit_at=COALESCE(excluded.eligible_edit_at,jira_mention_state.eligible_edit_at),
      eligibility=excluded.eligibility,state=excluded.state,resolving_comment_id=excluded.resolving_comment_id,
      resolving_created_at=excluded.resolving_created_at,rule_version=excluded.rule_version,
      computed_at=excluded.computed_at,generation=excluded.generation`)
    for (const item of classified) {
      statement.run(
        contextId, issueId, item.comment.commentId, item.comment.authorAccountId,
        item.comment.createdAt, item.comment.updatedAt, fingerprint(item.comment.body), item.firstObservedAt,
        item.eligibleEditAt, item.eligibility, item.state, item.resolvingCommentId, item.resolvingCreatedAt,
        JIRA_MENTION_RULE_VERSION, computedAt, generation,
      )
    }
  }

  private getPriorEvidence(contextId: string, issueId: string): Map<string, PriorJiraMentionEvidence> {
    const rows = this.db.prepare(`SELECT s.incoming_comment_id,s.eligibility,s.source_updated_at,s.first_observed_at,
        EXISTS(SELECT 1 FROM jira_comment_mentions m WHERE m.context_id=s.context_id AND m.issue_id=s.issue_id
          AND m.comment_id=s.incoming_comment_id AND m.mentioned_account_id=c.self_account_id) AS mentioned_self
      FROM jira_mention_state s JOIN jira_cache_contexts c ON c.context_id=s.context_id
      WHERE s.context_id=? AND s.issue_id=?`).all(contextId, issueId) as Array<{
        incoming_comment_id: string; eligibility: JiraMentionEligibility; source_updated_at: number;
        first_observed_at: number; mentioned_self: number
      }>
    return new Map(rows.map((row) => [row.incoming_comment_id, {
      eligibility: row.eligibility,
      sourceUpdatedAt: row.source_updated_at,
      previouslyMentionedSelf: row.mentioned_self === 1,
      firstObservedAt: row.first_observed_at,
    }]))
  }

  private saveComment(contextId: string, comment: JiraCommentRecord, generation: number): void {
    this.db.prepare(`INSERT INTO jira_comments(
      context_id,issue_id,comment_id,author_account_id,author_name,created_at,updated_at,body_json,excerpt,
      visibility_json,body_hash,fetched_at,availability,generation
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(context_id,issue_id,comment_id) DO UPDATE SET
      author_account_id=excluded.author_account_id,author_name=excluded.author_name,created_at=excluded.created_at,
      updated_at=excluded.updated_at,body_json=excluded.body_json,excerpt=excluded.excerpt,
      visibility_json=excluded.visibility_json,body_hash=excluded.body_hash,fetched_at=excluded.fetched_at,
      availability=excluded.availability,generation=excluded.generation`)
      .run(contextId, comment.issueId, comment.commentId, comment.authorAccountId, comment.authorDisplayName,
        comment.createdAt, comment.updatedAt, JSON.stringify(comment.body), comment.excerpt || extractAdfPlainText(comment.body).slice(0, 500),
        JSON.stringify(comment.visibility), fingerprint(comment.body), Date.now(), comment.availability, generation)
  }

  private replaceCommentMentions(contextId: string, issueId: string, commentId: string, accountIds: string[]): void {
    this.db.prepare(`DELETE FROM jira_comment_mentions WHERE context_id=? AND issue_id=? AND comment_id=?`)
      .run(contextId, issueId, commentId)
    const insert = this.db.prepare(`INSERT OR IGNORE INTO jira_comment_mentions(context_id,issue_id,comment_id,mentioned_account_id) VALUES(?,?,?,?)`)
    for (const accountId of new Set(accountIds)) insert.run(contextId, issueId, commentId, accountId)
  }

  private addUsers(contextId: string, issueId: string, users: JiraUserReference[], generation: number): void {
    const insert = this.db.prepare(`INSERT INTO jira_issue_users(context_id,issue_id,account_id,display_name,avatar_url,active,sources_json,generation)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(context_id,issue_id,account_id) DO UPDATE SET
        display_name=COALESCE(jira_issue_users.display_name,excluded.display_name),
        avatar_url=COALESCE(jira_issue_users.avatar_url,excluded.avatar_url),
        active=COALESCE(jira_issue_users.active,excluded.active),
        sources_json=excluded.sources_json,generation=excluded.generation`)
    for (const user of normalizeUserList(users)) {
      insert.run(contextId, issueId, user.accountId, user.displayName, user.avatarUrl ?? null,
        user.active === undefined ? null : user.active ? 1 : 0, JSON.stringify(user.sources), generation)
    }
  }

  private getComments(contextId: string, issueId: string): JiraCommentRecord[] {
    const rows = this.db.prepare(`SELECT comment_id,issue_id,author_account_id,author_name,created_at,updated_at,
      body_json,excerpt,visibility_json,availability FROM jira_comments
      WHERE context_id=? AND issue_id=? ORDER BY created_at,comment_id`).all(contextId, issueId) as CachedCommentRow[]
    return rows.map((row) => asComment(row, parseJson(row.body_json), parseJson(row.visibility_json)))
  }

  private getIssueUsers(contextId: string, issueId: string): JiraUserReference[] {
    const rows = this.db.prepare(`SELECT account_id,display_name,avatar_url,active,sources_json FROM jira_issue_users
      WHERE context_id=? AND issue_id=? ORDER BY display_name COLLATE NOCASE,account_id`).all(contextId, issueId) as Array<{
        account_id: string; display_name: string | null; avatar_url: string | null; active: number | null; sources_json: string
      }>
    return rows.map((row) => ({
      accountId: row.account_id,
      displayName: row.display_name,
      ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
      ...(row.active === null ? {} : { active: row.active === 1 }),
      sources: parseJson<string[]>(row.sources_json),
    }))
  }

  private getMentionItems(contextId: string): JiraMentionProjectionItem[] {
    const rows = this.db.prepare(`SELECT s.*,i.metadata_json,c.author_name,c.author_account_id,c.created_at,
        c.updated_at,c.body_json,c.excerpt,c.visibility_json,c.availability,a.disposition,a.snooze_until,a.updated_at AS action_updated_at,
        EXISTS(SELECT 1 FROM jira_reply_attempts r WHERE r.context_id=s.context_id AND r.issue_id=s.issue_id
          AND r.outcome='unknown' AND r.reconciled_at IS NULL) AS reply_uncertain
      FROM jira_mention_state s
      JOIN jira_cached_issues i ON i.context_id=s.context_id AND i.issue_id=s.issue_id
      JOIN jira_comments c ON c.context_id=s.context_id AND c.issue_id=s.issue_id AND c.comment_id=s.incoming_comment_id
      LEFT JOIN jira_mention_actions a ON a.context_id=s.context_id AND a.issue_id=s.issue_id AND a.incoming_comment_id=s.incoming_comment_id
      WHERE s.context_id=? AND s.eligibility<>'excluded' AND s.state IN ('unanswered','answered','unknown')
      AND c.availability='visible' ORDER BY s.source_created_at,s.incoming_comment_id`).all(contextId) as Array<Record<string, unknown>>
    const usersByIssue = new Map<string, JiraUserReference[]>()
    return rows.map((row) => {
      const issueId = String(row.issue_id)
      let authors = usersByIssue.get(issueId)
      if (!authors) {
        authors = this.getIssueUsers(contextId, issueId)
        usersByIssue.set(issueId, authors)
      }
      const state: JiraMentionProjectionItem['state'] = {
        issueId,
        incomingCommentId: String(row.incoming_comment_id),
        authorAccountId: typeof row.author_account_id === 'string' ? row.author_account_id : null,
        sourceCreatedAt: Number(row.source_created_at),
        sourceUpdatedAt: Number(row.source_updated_at),
        sourceHash: String(row.source_hash),
        firstObservedAt: Number(row.first_observed_at),
        eligibleEditAt: row.eligible_edit_at === null ? null : Number(row.eligible_edit_at),
        eligibility: row.eligibility as JiraMentionEligibility,
        state: row.state as 'unanswered' | 'answered' | 'removed' | 'unknown',
        resolvingCommentId: typeof row.resolving_comment_id === 'string' ? row.resolving_comment_id : null,
        resolvingCreatedAt: row.resolving_created_at === null ? null : Number(row.resolving_created_at),
        ruleVersion: Number(row.rule_version),
        computedAt: Number(row.computed_at),
      }
      const commentRow: CachedCommentRow = {
        comment_id: String(row.incoming_comment_id), issue_id: issueId,
        author_account_id: typeof row.author_account_id === 'string' ? row.author_account_id : null,
        author_name: typeof row.author_name === 'string' ? row.author_name : null,
        created_at: Number(row.created_at), updated_at: Number(row.updated_at), body_json: String(row.body_json),
        excerpt: String(row.excerpt), visibility_json: String(row.visibility_json),
        availability: row.availability as CachedCommentRow['availability'],
      }
      const action = typeof row.disposition === 'string' ? asAction({
        issue_id: issueId,
        incoming_comment_id: String(row.incoming_comment_id),
        disposition: row.disposition as 'dismissed' | 'snoozed',
        snooze_until: row.snooze_until === null ? null : Number(row.snooze_until),
        updated_at: Number(row.action_updated_at),
      }) : null
      return {
        issue: parseJson<JiraIssueMetadata>(String(row.metadata_json)),
        comment: asComment(commentRow, parseJson(commentRow.body_json), parseJson(commentRow.visibility_json)),
        state,
        action,
        authors: authors ?? [],
        replyUncertain: row.reply_uncertain === 1,
      }
    })
  }

  private pruneRuns(contextId: string): void {
    this.db.prepare(`DELETE FROM jira_sync_runs WHERE context_id=? AND outcome<>'running'
      AND run_id NOT IN (SELECT last_attempt_run_id FROM jira_sync_state WHERE context_id=? AND last_attempt_run_id IS NOT NULL)
      AND run_id NOT IN (SELECT last_success_run_id FROM jira_sync_state WHERE context_id=? AND last_success_run_id IS NOT NULL)
      AND scan_started_at < ?`).run(contextId, contextId, contextId, Date.now() - 30 * 24 * 60 * 60 * 1000)
  }
}

export function isActive(item: JiraMentionProjectionItem, now: number): boolean {
  if (item.state.state !== 'unanswered') return false
  if (item.action?.disposition === 'dismissed') return false
  return !(item.action?.disposition === 'snoozed' && item.action.snoozeUntil !== null && item.action.snoozeUntil > now)
}

function validateSnapshot(snapshot: JiraIssueSnapshot): void {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.issue || typeof snapshot.issue.issueId !== 'string'
    || !snapshot.issue.issueId || typeof snapshot.issue.issueKey !== 'string' || !Array.isArray(snapshot.comments)
    || !Array.isArray(snapshot.users) || snapshot.commentsComplete !== true) {
    throw repositoryError('incomplete_run')
  }
  const ids = new Set<string>()
  for (const comment of snapshot.comments) {
    if (!comment.commentId || comment.issueId !== snapshot.issue.issueId || !Number.isFinite(comment.createdAt)
      || !Number.isFinite(comment.updatedAt) || ids.has(comment.commentId) || comment.availability !== 'visible') {
      throw repositoryError('invalid_cache')
    }
    ids.add(comment.commentId)
  }
  if (!Number.isFinite(snapshot.observedCommentCount) || snapshot.observedCommentCount !== snapshot.comments.length) {
    throw repositoryError('incomplete_run')
  }
}

function safeErrorCode(value: string): string {
  return /^[a-z0-9_]{1,64}$/i.test(value) ? value : 'request_failed'
}

function mapReplyAttempt(row: Record<string, unknown>): JiraReplyAttempt {
  return {
    attemptId: String(row.attempt_id),
    contextId: String(row.context_id),
    issueId: String(row.issue_id),
    outcome: row.outcome as JiraReplyAttempt['outcome'],
    bodyHash: String(row.body_hash),
    mentionedAccountIds: parseJson<string[]>(String(row.mentioned_ids_json)),
    returnedCommentId: typeof row.returned_comment_id === 'string' ? row.returned_comment_id : null,
    safeErrorCode: typeof row.safe_error_code === 'string' ? row.safe_error_code : null,
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    reconciledAt: row.reconciled_at === null ? null : Number(row.reconciled_at),
  }
}
