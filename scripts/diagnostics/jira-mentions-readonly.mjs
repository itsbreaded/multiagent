/**
 * One-off read-only Jira sandbox diagnostic for unanswered mentions.
 *
 * This deliberately stays outside Vitest and never mutates Jira or the app DB.
 * It replays the read side of JiraMentionsService/JiraMentionsClient with four
 * snapshot workers, matching the app's current page size and field selections.
 * Output contains aggregate counts, timings, and safe error codes only.
 *
 * Run after setting JIRA_DIAGNOSTIC_ENV to a local, untracked env-file path:
 * node scripts/diagnostics/jira-mentions-readonly.mjs
 * Required: JIRA_DIAGNOSTIC_ENV (path to a local, untracked env file).
 * Optional paths: JIRA_DIAGNOSTIC_SETTINGS,
 *                 JIRA_DIAGNOSTIC_DATABASE.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'

let diagnosticSite = null
const PAGE_SIZE = 100
const ISSUE_WORKERS = 4
const REQUEST_TIMEOUT_MS = 20_000
const MAX_SEARCH_PAGES = 100
const DISCOVERY_FIELDS = ['summary', 'updated', 'comment', 'project']
const DETAIL_FIELDS = [
  'summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter', 'creator', 'created', 'updated',
  'duedate', 'resolution', 'description', 'attachment', 'parent', 'subtasks', 'issuelinks',
]

class DiagnosticError extends Error {
  constructor(code, status = null) {
    super(code)
    this.code = code
    this.status = status
  }
}

const endpointMetrics = new Map()
let phase = 'configuration'

function metricFor(name) {
  if (!endpointMetrics.has(name)) endpointMetrics.set(name, { requests: 0, totalMs: 0, maxMs: 0, failures: {} })
  return endpointMetrics.get(name)
}

function parseDotEnv(text) {
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match) continue
    let value = match[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[match[1]] = value
  }
  return values
}

function readAppContext(databasePath, siteUrl) {
  const python = String.raw`
import json, sqlite3, sys
db_path, site_url = sys.argv[1], sys.argv[2]
db = sqlite3.connect('file:' + db_path.replace('\\', '/') + '?mode=ro', uri=True, timeout=5)
row = db.execute("""SELECT c.history_from, c.initial_scan_started,
  s.last_success_started_at, s.last_success_ended_at, s.last_full_at,
  s.retry_not_before,
  (SELECT COUNT(DISTINCT issue_id) FROM jira_mention_state m
   WHERE m.context_id=c.context_id AND m.eligibility <> 'excluded'
     AND m.state IN ('unanswered','answered','unknown'))
  FROM jira_cache_contexts c JOIN jira_sync_state s USING(context_id)
  WHERE c.site_url=?""", (site_url,)).fetchone()
if row is None:
    print(json.dumps({'found': False}))
else:
    all_known = [r[0] for r in db.execute("""SELECT DISTINCT issue_id FROM jira_mention_state
      WHERE context_id=(SELECT context_id FROM jira_cache_contexts WHERE site_url=?)
        AND eligibility <> 'excluded' AND state IN ('unanswered','answered','unknown')
      ORDER BY issue_id""", (site_url,))]
    unanswered = [r[0] for r in db.execute("""SELECT DISTINCT issue_id FROM jira_mention_state
      WHERE context_id=(SELECT context_id FROM jira_cache_contexts WHERE site_url=?)
        AND eligibility <> 'excluded' AND state='unanswered'
      ORDER BY issue_id""", (site_url,))]
    print(json.dumps({'found': True, 'historyFrom': row[0], 'initialScanStarted': bool(row[1]),
      'lastSuccessStartedAt': row[2], 'lastSuccessEndedAt': row[3], 'lastFullAt': row[4],
      'retryNotBefore': row[5], 'knownIssueCount': row[6], 'knownIssueIdsFull': all_known,
      'knownIssueIdsIncremental': unanswered}))
db.close()
`
  const result = spawnSync('python', ['-c', python, databasePath, siteUrl], { encoding: 'utf8', timeout: 10_000 })
  if (result.error || result.status !== 0) throw new DiagnosticError('local_context_unavailable')
  try { return JSON.parse(result.stdout.trim()) } catch { throw new DiagnosticError('local_context_unavailable') }
}

function appJqlTimestamp(timestamp, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  const parts = Object.fromEntries(formatter.formatToParts(timestamp).map((part) => [part.type, part.value]))
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`
}

function quoteJqlString(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function buildAppJql(timestamp, timeZone, accountId) {
  if (!accountId) throw new DiagnosticError('identity_unavailable')
  let effective = timestamp
  let zone = timeZone ?? 'UTC'
  if (!timeZone) effective -= 2 * 24 * 60 * 60 * 1000
  try {
    return { jql: `updated >= ${quoteJqlString(appJqlTimestamp(effective, zone))} AND comment ~ ${quoteJqlString(accountId)} ORDER BY updated ASC, key ASC`, effective }
  } catch {
    effective = timestamp - 2 * 24 * 60 * 60 * 1000
    return { jql: `updated >= ${quoteJqlString(appJqlTimestamp(effective, 'UTC'))} AND comment ~ ${quoteJqlString(accountId)} ORDER BY updated ASC, key ASC`, effective }
  }
}

function safeCodeForStatus(status) {
  if (status === 401) return 'auth'
  if (status === 403) return 'permission'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status === 400 || status === 422) return 'validation'
  return 'network'
}

function recordFailure(metric, code) {
  metric.failures[code] = (metric.failures[code] ?? 0) + 1
}

function assertReadRoute(route, method) {
  const allowed = (method === 'GET' && (
    route === '/rest/api/3/myself' || route === '/rest/api/3/field'
    || /^\/rest\/api\/3\/issue\/[^/]+(?:\/comment(?:\/[^/]+)?)?$/.test(route)
  )) || (method === 'POST' && route === '/rest/api/3/search/jql')
  if (!allowed) throw new DiagnosticError('route_not_allowlisted')
}

async function requestJson(name, route, { method = 'GET', body } = {}, email, token) {
  if (!diagnosticSite) throw new DiagnosticError('sandbox_config_unavailable')
  const url = new URL(route, diagnosticSite)
  assertReadRoute(url.pathname, method)
  const metric = metricFor(name)
  metric.requests++
  const started = performance.now()
  let failureCode = null
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new DiagnosticError(safeCodeForStatus(response.status), response.status)
    try { return await response.json() } catch { throw new DiagnosticError('invalid_response', response.status) }
  } catch (error) {
    failureCode = error instanceof DiagnosticError ? error.code : 'network'
    if (error instanceof DiagnosticError) throw error
    throw new DiagnosticError(failureCode)
  } finally {
    const elapsed = performance.now() - started
    metric.totalMs += elapsed
    metric.maxMs = Math.max(metric.maxMs, elapsed)
    if (failureCode) recordFailure(metric, failureCode)
  }
}

function parseSearchIssue(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.key !== 'string'
    || !raw.fields || typeof raw.fields !== 'object') throw new DiagnosticError('invalid_response')
  const comment = raw.fields.comment && typeof raw.fields.comment === 'object' ? raw.fields.comment : {}
  const project = raw.fields.project && typeof raw.fields.project === 'object' ? raw.fields.project : {}
  return {
    issueId: raw.id,
    issueKey: raw.key,
    updatedMarker: typeof raw.fields.updated === 'string' ? raw.fields.updated : null,
    updatedAt: typeof raw.fields.updated === 'string' ? Date.parse(raw.fields.updated) : null,
    commentTotal: Number.isInteger(comment.total) ? comment.total : null,
    inlineComments: Array.isArray(comment.comments) ? comment.comments : [],
    inlineStartAt: Number.isInteger(comment.startAt) ? comment.startAt : null,
    projectTypeKey: typeof project.projectTypeKey === 'string' ? project.projectTypeKey : null,
  }
}

function hasCompleteInlineComments(issue) {
  return issue.inlineStartAt === 0 && issue.commentTotal !== null
    && issue.inlineComments.length === issue.commentTotal
}

async function searchAll(jql, email, token) {
  const found = []
  const seenTokens = new Set()
  let nextPageToken
  let pages = 0
  while (true) {
    if (++pages > MAX_SEARCH_PAGES) throw new DiagnosticError('search_page_limit')
    const body = { jql, fields: DISCOVERY_FIELDS, maxResults: PAGE_SIZE }
    if (nextPageToken) body.nextPageToken = nextPageToken
    const page = await requestJson('search', '/rest/api/3/search/jql', { method: 'POST', body }, email, token)
    if (!Array.isArray(page.issues)) throw new DiagnosticError('invalid_response')
    found.push(...page.issues.map(parseSearchIssue))
    if (pages === 1 || pages % 10 === 0) console.log(`Search pages: ${pages}; issues received: ${found.length}`)
    const tokenValue = typeof page.nextPageToken === 'string' && page.nextPageToken ? page.nextPageToken : null
    if (!tokenValue) {
      if (page.isLast === false) throw new DiagnosticError('invalid_response')
      break
    }
    if (seenTokens.has(tokenValue)) throw new DiagnosticError('invalid_response')
    seenTokens.add(tokenValue)
    nextPageToken = tokenValue
  }
  const unique = new Map()
  for (const issue of found) unique.set(issue.issueId, issue)
  return { issues: [...unique.values()], pages, received: found.length }
}

async function getIssueCandidate(issueId, email, token) {
  const query = new URLSearchParams({ fields: 'summary,updated,comment,project' })
  const raw = await requestJson('candidate_recheck', `/rest/api/3/issue/${encodeURIComponent(issueId)}?${query}`, {}, email, token)
  return parseSearchIssue(raw)
}

async function getAllComments(issue, email, token) {
  if (hasCompleteInlineComments(issue)) return issue.inlineComments
  const comments = []
  const seenIds = new Set()
  let startAt = 0
  let total = null
  while (total === null || startAt < total) {
    const query = new URLSearchParams({ startAt: String(startAt), maxResults: String(PAGE_SIZE), orderBy: 'created' })
    const page = await requestJson('comments', `/rest/api/3/issue/${encodeURIComponent(issue.issueId)}/comment?${query}`, {}, email, token)
    if (!Array.isArray(page.comments) || !Number.isInteger(page.total)) throw new DiagnosticError('invalid_response')
    if (page.comments.length === 0 && startAt < page.total) throw new DiagnosticError('invalid_response')
    for (const comment of page.comments) {
      if (!comment || typeof comment.id !== 'string' || seenIds.has(comment.id)) throw new DiagnosticError('invalid_response')
      seenIds.add(comment.id)
      comments.push(comment)
    }
    if (total !== null && total !== page.total) throw new DiagnosticError('invalid_response')
    total = page.total
    if (Number.isInteger(page.startAt) && page.startAt !== startAt) throw new DiagnosticError('invalid_response')
    if (page.comments.length <= 0) throw new DiagnosticError('invalid_response')
    startAt += page.comments.length
    if (startAt > total) throw new DiagnosticError('invalid_response')
  }
  if (comments.length !== total) throw new DiagnosticError('invalid_response')
  return comments
}

function containsSelfMention(body, selfAccountId) {
  const visit = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    if (value.type === 'mention' && value.attrs && (value.attrs.id === selfAccountId || value.attrs.accountId === selfAccountId)) return true
    return Array.isArray(value.content) && value.content.some(visit)
  }
  return visit(body)
}

function validateComments(comments) {
  for (const comment of comments) {
    const created = typeof comment?.created === 'string' ? Date.parse(comment.created) : NaN
    const updated = typeof comment?.updated === 'string' ? Date.parse(comment.updated) : created
    if (typeof comment?.id !== 'string' || !Number.isFinite(created) || !Number.isFinite(updated)) {
      throw new DiagnosticError('invalid_response')
    }
  }
}

async function getDetails(issueId, userFieldIds, email, token) {
  const query = new URLSearchParams({ fields: [...DETAIL_FIELDS, ...userFieldIds].join(',') })
  const detail = await requestJson('issue_details', `/rest/api/3/issue/${encodeURIComponent(issueId)}?${query}`, {}, email, token)
  if (typeof detail?.id !== 'string' || typeof detail?.key !== 'string' || detail.id !== issueId) {
    throw new DiagnosticError('invalid_response')
  }
}

async function getIssueMarker(issueId, email, token) {
  const query = new URLSearchParams({ fields: 'updated,comment' })
  const marker = await requestJson('issue_marker', `/rest/api/3/issue/${encodeURIComponent(issueId)}?${query}`, {}, email, token)
  const fields = marker?.fields
  if (!fields || typeof fields !== 'object') throw new DiagnosticError('invalid_response')
  return {
    updatedMarker: typeof fields.updated === 'string' ? fields.updated : null,
    updatedAt: typeof fields.updated === 'string' ? Date.parse(fields.updated) : null,
    commentTotal: Number.isInteger(fields.comment?.total) ? fields.comment.total : null,
  }
}

async function snapshotIssue(issue, userFieldIds, selfAccountId, email, token) {
  const comments = await getAllComments(issue, email, token)
  validateComments(comments)
  const selfMentioned = comments.some((comment) => containsSelfMention(comment.body, selfAccountId))
  if (selfMentioned) await getDetails(issue.issueId, userFieldIds, email, token)
  const marker = hasCompleteInlineComments(issue) && issue.updatedMarker !== null && issue.updatedAt !== null
    ? { updatedMarker: issue.updatedMarker, updatedAt: issue.updatedAt, commentTotal: issue.commentTotal }
    : await getIssueMarker(issue.issueId, email, token)
  if ((issue.updatedAt !== null && marker.updatedAt !== null && issue.updatedAt !== marker.updatedAt)
    || (issue.commentTotal !== null && marker.commentTotal !== null && issue.commentTotal !== marker.commentTotal)) {
    throw new DiagnosticError('invalid_response')
  }
  return { selfMentioned, commentCount: comments.length, commentsComplete: marker.commentTotal === null || comments.length === marker.commentTotal }
}

function relativeTime(timestamp, now) {
  return timestamp === null ? null : Math.round((now - timestamp) / (60 * 60 * 1000) * 100) / 100
}

function printRequestMetrics() {
  console.log('Request totals:')
  for (const [name, metric] of endpointMetrics) {
    console.log(`  ${name}: ${JSON.stringify({ requests: metric.requests, totalMs: Math.round(metric.totalMs), maxMs: Math.round(metric.maxMs), failures: metric.failures })}`)
  }
}

async function run() {
  if (!process.env.JIRA_DIAGNOSTIC_ENV) throw new DiagnosticError('environment_file_path_required')
  const envPath = path.resolve(process.env.JIRA_DIAGNOSTIC_ENV)
  const settingsPath = path.resolve(process.env.JIRA_DIAGNOSTIC_SETTINGS ?? path.join(process.env.APPDATA ?? '', 'multiagent', 'jira-settings.json'))
  const databasePath = path.resolve(process.env.JIRA_DIAGNOSTIC_DATABASE ?? path.join(process.env.APPDATA ?? '', 'multiagent', 'session-index.db'))
  const env = parseDotEnv(fs.readFileSync(envPath, 'utf8'))
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  const sampleArg = process.argv.find((arg) => arg.startsWith('--snapshot-sample='))
  const requestedSample = sampleArg ? Number(sampleArg.slice('--snapshot-sample='.length)) : 0
  const snapshotSampleLimit = Number.isInteger(requestedSample) && requestedSample > 0
    ? Math.min(requestedSample, 250)
    : 0
  const email = env.JIRA_CLOUD_SANDBOX_USERNAME
  const token = env.JIRA_CLOUD_SANDBOX_APITOKEN
  const site = settings.baseUrl?.replace(/\/+$/, '')
  const sandboxSite = env.JIRA_CLOUD_SANDBOX_URL?.replace(/\/+$/, '')
  let sandboxOrigin
  try { sandboxOrigin = new URL(sandboxSite).origin } catch { throw new DiagnosticError('sandbox_config_unavailable') }
  if (!email || !token || !sandboxSite || site !== sandboxSite || sandboxOrigin !== sandboxSite
    || new URL(sandboxSite).protocol !== 'https:' || settings.mentionsEnabled !== true) {
    throw new DiagnosticError('sandbox_config_unavailable')
  }
  diagnosticSite = sandboxSite

  console.log('Read-only Jira sandbox diagnostic; Jira writes are disabled.')
  console.log('Authentication: GET /myself')
  phase = 'identity'
  const identity = await requestJson('identity', '/rest/api/3/myself', {}, email, token)
  if (typeof identity.accountId !== 'string') throw new DiagnosticError('invalid_response')
  console.log('Authentication: ok')

  phase = 'local_context'
  const context = readAppContext(databasePath, site)
  if (!context.found) throw new DiagnosticError('local_context_unavailable')
  const now = Date.now()
  const syncSucceeded = context.lastSuccessEndedAt !== null
  const fullDue = context.lastFullAt === null || now - context.lastFullAt >= 24 * 60 * 60 * 1000
  const full = !syncSucceeded || fullDue
  const initial = !syncSucceeded
  const historyFrom = initial && !context.initialScanStarted ? now - 7 * 24 * 60 * 60 * 1000 : context.historyFrom
  const retryInMs = context.retryNotBefore === null ? 0 : context.retryNotBefore - now
  if (retryInMs > 0) throw new DiagnosticError('existing_retry_backoff')
  const { jql, effective } = buildAppJql(historyFrom, typeof identity.timeZone === 'string' ? identity.timeZone : null, identity.accountId)
  console.log(`App window: about ${relativeTime(effective, now)} hours`)

  phase = 'search'
  const searchStarted = performance.now()
  const search = await searchAll(jql, email, token)
  const candidatesById = new Map(search.issues.map((issue) => [issue.issueId, issue]))
  const knownIssueIds = full ? context.knownIssueIdsFull : context.knownIssueIdsIncremental
  console.log(`Cached issue rechecks: ${knownIssueIds.length}`)
  for (const issueId of knownIssueIds) {
    if (candidatesById.has(issueId)) continue
    try { candidatesById.set(issueId, await getIssueCandidate(issueId, email, token)) }
    catch (error) { recordFailure(metricFor('candidate_recheck'), error instanceof DiagnosticError ? error.code : 'network') }
  }
  phase = 'user_fields'
  let rawFields
  try {
    rawFields = await requestJson('user_fields', '/rest/api/3/field', {}, email, token)
  } catch (error) {
    if (!(error instanceof DiagnosticError) || error.code !== 'permission') throw error
    rawFields = []
  }
  if (!Array.isArray(rawFields)) throw new DiagnosticError('invalid_response')
  const userFieldIds = rawFields.flatMap((field) => {
    const isUser = field?.schema?.type === 'user' || (field?.schema?.type === 'array' && field.schema.items === 'user')
    return isUser && typeof field.id === 'string' && field.id.startsWith('customfield_') ? [field.id] : []
  })
  console.log(`Custom user fields available: ${userFieldIds.length}`)
  phase = 'search'
  const candidates = [...candidatesById.values()]
  console.log(`Discovery: ${candidates.length} unique issues from ${search.pages} page(s) in ${Math.round(performance.now() - searchStarted)} ms`)
  if (candidates.length > 500 && snapshotSampleLimit === 0) {
    console.log('Snapshot pass stopped at the 500-issue safety limit; rerun with --snapshot-sample=N for a bounded sample.')
    return
  }

  phase = 'snapshots'
  const snapshotStarted = performance.now()
  const sampleSize = snapshotSampleLimit ? Math.min(snapshotSampleLimit, candidates.length) : candidates.length
  const snapshotCandidates = sampleSize === candidates.length ? candidates : Array.from({ length: sampleSize }, (_, index) =>
    candidates[Math.floor(index * candidates.length / sampleSize)],
  )
  if (sampleSize < candidates.length) {
    console.log(`Snapshot sample: ${sampleSize} issues spread across the ${candidates.length}-issue ordered result set`)
  }
  const stats = { completed: 0, failed: 0, selfMentioned: 0, comments: 0, incomplete: 0, retriedInvalidResponse: 0 }
  const failureCodes = {}
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(ISSUE_WORKERS, snapshotCandidates.length) }, async () => {
    while (cursor < snapshotCandidates.length) {
      const issue = snapshotCandidates[cursor++]
      try {
        let result
        try { result = await snapshotIssue(issue, userFieldIds, identity.accountId, email, token) }
        catch (error) {
          if (!(error instanceof DiagnosticError) || error.code !== 'invalid_response') throw error
          stats.retriedInvalidResponse++
          result = await snapshotIssue(issue, userFieldIds, identity.accountId, email, token)
        }
        stats.completed++
        stats.selfMentioned += Number(result.selfMentioned)
        stats.comments += result.commentCount
        stats.incomplete += Number(!result.commentsComplete)
      } catch (error) {
        stats.failed++
        const code = error instanceof DiagnosticError ? error.code : 'network'
        failureCodes[code] = (failureCodes[code] ?? 0) + 1
      }
      if (stats.completed + stats.failed === snapshotCandidates.length || (stats.completed + stats.failed) % 25 === 0) {
        console.log(`Snapshot progress: ${stats.completed + stats.failed}/${snapshotCandidates.length}`)
      }
    }
  }))
  const snapshotRequestCount = ['comments', 'issue_details', 'issue_marker']
    .reduce((sum, name) => sum + (endpointMetrics.get(name)?.requests ?? 0), 0)
  const estimatedSnapshotRequestsForAllCandidates = stats.completed > 0
    ? Math.round(candidates.length * snapshotRequestCount / stats.completed)
    : null
  console.log(`Snapshot pass: ${JSON.stringify({ sampledIssues: snapshotCandidates.length, totalCandidates: candidates.length, ...stats, elapsedMs: Math.round(performance.now() - snapshotStarted), snapshotRequestsInSample: snapshotRequestCount, estimatedSnapshotRequestsForAllCandidates, failureCodes })}`)
  printRequestMetrics()
}

run().catch((error) => {
  const code = error instanceof DiagnosticError ? error.code : 'diagnostic_failed'
  const status = error instanceof DiagnosticError ? error.status : null
  console.log(`Diagnostic stopped during ${phase}: ${JSON.stringify({ code, status })}`)
  printRequestMetrics()
  process.exitCode = 1
})
