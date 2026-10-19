import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { APPLICATION_DATABASE_VERSION, ApplicationDatabase, ApplicationDatabaseError } from '../src/main/database/ApplicationDatabase'
import { SessionIndex } from '../src/main/sessions/SessionIndex'
import { JIRA_MENTION_RULE_VERSION, JiraMentionsRepository } from '../src/main/jira/JiraMentionsRepository'
import type { JiraIssueSnapshot } from '../src/shared/jiraMentions'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagent-database-smoke-'))

function databasePath(name: string): string {
  return path.join(root, name, 'session-index.db')
}

function createParent(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function prepareE2eDatabaseFromArgs(): boolean {
  const modes = ['--prepare-newer', '--prepare-v1', '--prepare-failed', '--verify-failed', '--prepare-jira-v1', '--verify-jira-v1']
  const modeIndex = process.argv.findIndex((argument) => modes.includes(argument))
  if (modeIndex < 0) return false
  const mode = process.argv[modeIndex]
  const dbPath = process.argv[modeIndex + 1]
  if (!dbPath) throw new Error(`Missing database path for ${mode}`)

  createParent(dbPath)
  if (mode === '--prepare-jira-v1') {
    const owner = ApplicationDatabase.open(dbPath)
    try {
      owner.database.exec(`
        INSERT INTO jira_cache_contexts(context_id,site_url,self_account_id,tracking_started_at,history_from,
          identity_verified_at,rule_version,discovery_version,committed_generation)
          VALUES('legacy-context','https://legacy.example.test','legacy-account',10,2,10,1,1,4);
        INSERT INTO jira_cached_issues(context_id,issue_id,issue_key,metadata_json,metadata_fetched_at,access_state,generation)
          VALUES('legacy-context','legacy-issue','OLD-1','{}',20,'visible',4);
        INSERT INTO jira_comments(context_id,issue_id,comment_id,author_account_id,author_name,created_at,updated_at,
          body_json,excerpt,visibility_json,body_hash,fetched_at,availability,generation)
          VALUES('legacy-context','legacy-issue','legacy-comment','legacy-author','Old Author',15,15,'{}','Old request','null','hash',20,'visible',4);
        INSERT INTO jira_mention_state(context_id,issue_id,incoming_comment_id,author_account_id,source_created_at,
          source_updated_at,source_hash,first_observed_at,eligibility,state,rule_version,computed_at,generation)
          VALUES('legacy-context','legacy-issue','legacy-comment','legacy-author',15,15,'hash',15,'initial','unanswered',1,20,4);
        INSERT INTO jira_sync_state(context_id,last_success_started_at,last_success_ended_at,last_full_at,
          checkpoint,coverage_from,coverage_through,backfill_complete,generation)
          VALUES('legacy-context',15,20,20,20,2,20,1,4);
        PRAGMA user_version = 1;
      `)
    } finally {
      owner.close()
    }
    process.stdout.write(`Prepared ${mode} database at ${dbPath}.\n`)
    return true
  }

  const database = new Database(dbPath)
  try {
    if (mode === '--verify-failed') {
      assert.equal(database.pragma('user_version', { simple: true }), 0)
      assert.deepEqual(database.prepare(`SELECT sessionId FROM sessions`).all(), [{ sessionId: 'preserve-on-failure' }])
      assert.equal(database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='jira_cache_contexts'`).get(), undefined)
    } else if (mode === '--verify-jira-v1') {
      assert.equal(database.pragma('user_version', { simple: true }), APPLICATION_DATABASE_VERSION)
      assert.deepEqual(database.prepare(`SELECT issue_key FROM jira_cached_issues WHERE context_id='legacy-context'`).all(), [{ issue_key: 'OLD-1' }])
      assert.deepEqual(database.prepare(`SELECT state FROM jira_mention_state WHERE context_id='legacy-context'`).all(), [{ state: 'unanswered' }])
      assert.deepEqual(database.prepare(`SELECT checkpoint,generation,last_success_started_at FROM jira_sync_state WHERE context_id='legacy-context'`).get(), {
        checkpoint: 20, generation: 4, last_success_started_at: 15,
      })
      assert.deepEqual(database.prepare(`SELECT initial_scan_started,tracking_started_at,history_from FROM jira_cache_contexts WHERE context_id='legacy-context'`).get(), {
        initial_scan_started: 1, tracking_started_at: 10, history_from: 2,
      })
      assert.deepEqual(database.prepare(`PRAGMA foreign_key_check`).all(), [])
    } else if (mode === '--prepare-newer') {
      database.exec(`CREATE TABLE keep_me(value TEXT); INSERT INTO keep_me VALUES('preserved'); PRAGMA user_version = 99;`)
    } else if (mode === '--prepare-failed') {
      database.exec(`CREATE TABLE sessions(sessionId TEXT PRIMARY KEY); INSERT INTO sessions VALUES('preserve-on-failure');`)
    } else {
      database.exec(`
        CREATE TABLE sessions (
          agentKind TEXT NOT NULL DEFAULT 'claude', sessionId TEXT NOT NULL, cwd TEXT NOT NULL,
          projectName TEXT NOT NULL, displayName TEXT, gitBranch TEXT, firstMessage TEXT,
          lastMessage TEXT, firstActivity TEXT, lastActivity TEXT, messageCount INTEGER NOT NULL DEFAULT 0,
          filePath TEXT NOT NULL, mtimeMs REAL NOT NULL, status TEXT NOT NULL DEFAULT 'resumable',
          UNIQUE(agentKind, sessionId)
        );
        CREATE TABLE session_cwd_overrides (
          agentKind TEXT NOT NULL, sessionId TEXT NOT NULL, cwd TEXT NOT NULL,
          projectName TEXT NOT NULL, updatedAt REAL NOT NULL, PRIMARY KEY(agentKind, sessionId)
        );
        INSERT INTO sessions(agentKind,sessionId,cwd,projectName,firstMessage,filePath,mtimeMs)
          VALUES('claude','legacy-v1','C:/legacy','legacy','migrationneedle legacy summary','C:/legacy/session.jsonl',1);
        INSERT INTO session_cwd_overrides(agentKind,sessionId,cwd,projectName,updatedAt)
          VALUES('claude','legacy-v1','C:/legacy-fixed','legacy-fixed',2);
        PRAGMA user_version = 1;
      `)
    }
  } finally {
    database.close()
  }
  process.stdout.write(`Prepared ${mode} database at ${dbPath}.\n`)
  return true
}

function verifyFreshAndScopedRebuild(): void {
  const dbPath = databasePath('fresh')
  createParent(dbPath)
  const owner = ApplicationDatabase.open(dbPath)
  try {
    assert.equal(owner.database.pragma('user_version', { simple: true }), APPLICATION_DATABASE_VERSION)
    assert.equal(owner.database.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'jira_%'`).get()?.count, 11)
    owner.database.prepare(`INSERT INTO sessions(agentKind, sessionId, cwd, projectName, firstMessage, filePath, mtimeMs) VALUES('claude','s1','C:/work','work','search needle','C:/s1.jsonl',1)`).run()
    owner.database.prepare(`INSERT INTO session_cwd_overrides(agentKind, sessionId, cwd, projectName, updatedAt) VALUES('claude','s1','C:/fixed','fixed',2)`).run()
    owner.database.prepare(`INSERT INTO jira_cache_contexts(context_id,site_url,self_account_id,tracking_started_at,history_from,identity_verified_at,rule_version,discovery_version) VALUES('ctx','https://example.atlassian.net','account-1',10,0,10,1,1)`).run()
    owner.database.prepare(`INSERT INTO jira_sync_state(context_id, generation) VALUES('ctx',4)`).run()

    const index = new SessionIndex(owner.database)
    index.rebuildSearchIndex()
    assert.equal(index.search('needle').length, 1)
    new JiraMentionsRepository(owner.database).clearFetchedCache('ctx')
    assert.equal(index.search('needle').length, 1)
    index.close()
    assert.equal(owner.database.prepare(`SELECT cwd FROM session_cwd_overrides WHERE sessionId='s1'`).get()?.cwd, 'C:/fixed')
    assert.equal(owner.database.prepare(`SELECT generation FROM jira_sync_state WHERE context_id='ctx'`).get()?.generation, 5)
    assert.deepEqual(owner.database.prepare(`PRAGMA foreign_key_check`).all(), [])
  } finally {
    owner.close()
  }

  const reopened = ApplicationDatabase.open(dbPath)
  reopened.close()
}

function verifyVersionOneUpgrade(): void {
  const dbPath = databasePath('v1')
  createParent(dbPath)
  const legacy = new Database(dbPath)
  legacy.exec(`
    CREATE TABLE sessions (
      agentKind TEXT NOT NULL DEFAULT 'claude', sessionId TEXT NOT NULL, cwd TEXT NOT NULL,
      projectName TEXT NOT NULL, displayName TEXT, gitBranch TEXT, firstMessage TEXT,
      lastMessage TEXT, firstActivity TEXT, lastActivity TEXT, messageCount INTEGER NOT NULL DEFAULT 0,
      filePath TEXT NOT NULL, mtimeMs REAL NOT NULL, status TEXT NOT NULL DEFAULT 'resumable',
      UNIQUE(agentKind, sessionId)
    );
    CREATE TABLE session_cwd_overrides (
      agentKind TEXT NOT NULL, sessionId TEXT NOT NULL, cwd TEXT NOT NULL,
      projectName TEXT NOT NULL, updatedAt REAL NOT NULL, PRIMARY KEY(agentKind, sessionId)
    );
    INSERT INTO sessions(agentKind, sessionId, cwd, projectName, filePath, mtimeMs)
      VALUES('claude','kept','C:/work','work','C:/session.jsonl',3);
    INSERT INTO session_cwd_overrides(agentKind, sessionId, cwd, projectName, updatedAt)
      VALUES('claude','kept','C:/fixed','fixed',4);
    PRAGMA user_version = 1;
  `)
  legacy.close()

  const owner = ApplicationDatabase.open(dbPath)
  try {
    assert.equal(owner.database.pragma('user_version', { simple: true }), APPLICATION_DATABASE_VERSION)
    assert.deepEqual(owner.database.prepare(`SELECT sessionId,cwd,projectName FROM sessions`).get(), {
      sessionId: 'kept', cwd: 'C:/work', projectName: 'work',
    })
    assert.deepEqual(owner.database.prepare(`SELECT cwd,projectName FROM session_cwd_overrides`).get(), {
      cwd: 'C:/fixed', projectName: 'fixed',
    })
    assert.deepEqual(owner.database.prepare(`PRAGMA foreign_key_check`).all(), [])
  } finally {
    owner.close()
  }
}

function verifyLegacySingleKeyMigration(): void {
  const dbPath = databasePath('legacy')
  createParent(dbPath)
  const legacy = new Database(dbPath)
  legacy.exec(`
    CREATE TABLE sessions (
      sessionId TEXT PRIMARY KEY, cwd TEXT NOT NULL, projectName TEXT NOT NULL,
      gitBranch TEXT, firstMessage TEXT, lastMessage TEXT, firstActivity TEXT,
      lastActivity TEXT, messageCount INTEGER NOT NULL, filePath TEXT NOT NULL,
      mtimeMs REAL NOT NULL, status TEXT NOT NULL
    );
    INSERT INTO sessions(sessionId,cwd,projectName,firstMessage,messageCount,filePath,mtimeMs,status)
      VALUES('legacy-1','C:/old','old','legacy searchable',2,'C:/old.jsonl',8,'resumable');
  `)
  legacy.close()

  const owner = ApplicationDatabase.open(dbPath)
  try {
    assert.equal(owner.database.pragma('user_version', { simple: true }), APPLICATION_DATABASE_VERSION)
    assert.deepEqual(owner.database.prepare(`SELECT agentKind,sessionId,displayName,firstMessage FROM sessions`).get(), {
      agentKind: 'claude', sessionId: 'legacy-1', displayName: null, firstMessage: 'legacy searchable',
    })
    assert.equal(owner.database.prepare(`SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH 'searchable'`).all().length, 1)
  } finally {
    owner.close()
  }
}

function verifyRollbackAndNewerVersionPreservation(): void {
  const failedPath = databasePath('failed')
  createParent(failedPath)
  const broken = new Database(failedPath)
  broken.exec(`CREATE TABLE sessions(sessionId TEXT PRIMARY KEY); INSERT INTO sessions VALUES('kept');`)
  broken.close()
  assert.throws(() => ApplicationDatabase.open(failedPath), ApplicationDatabaseError)
  const preserved = new Database(failedPath)
  try {
    assert.equal(preserved.pragma('user_version', { simple: true }), 0)
    assert.deepEqual(preserved.prepare(`SELECT sessionId FROM sessions`).get(), { sessionId: 'kept' })
    assert.equal(preserved.prepare(`SELECT name FROM sqlite_master WHERE name='jira_cache_contexts'`).get(), undefined)
  } finally {
    preserved.close()
  }

  const newerPath = databasePath('newer')
  createParent(newerPath)
  const newer = new Database(newerPath)
  newer.exec(`CREATE TABLE keep_me(value TEXT); INSERT INTO keep_me VALUES('preserved'); PRAGMA user_version = 99;`)
  newer.close()
  const bytesBefore = fs.readFileSync(newerPath)
  assert.throws(
    () => ApplicationDatabase.open(newerPath),
    (error: unknown) => error instanceof ApplicationDatabaseError && error.code === 'unsupported_schema',
  )
  assert.equal(fs.readFileSync(newerPath).equals(bytesBefore), true)
}

function verifyMentionRepositoryPublicationAndClear(): void {
  const dbPath = databasePath('mentions-repository')
  createParent(dbPath)
  let contextId = ''
  const owner = ApplicationDatabase.open(dbPath)
  try {
    const repository = new JiraMentionsRepository(owner.database)
    const context = repository.ensureVerifiedContext('https://example.atlassian.net', 'self-id', 10_000)
    contextId = context.contextId
    assert.equal(owner.database.prepare(`SELECT initial_scan_started FROM jira_cache_contexts WHERE context_id=?`)
      .get(contextId)?.initial_scan_started, 0)
    const scanStartedAt = 20_000
    const run = repository.startRun(context.contextId, {
      kind: 'initial', lowerBound: context.historyFrom, scanStartedAt, baseGeneration: 0,
      configGeneration: 1, ruleVersion: context.ruleVersion,
    })
    assert.equal(run.lowerBound, scanStartedAt - 7 * 24 * 60 * 60 * 1000)
    assert.equal(repository.getContext(context.contextId)?.trackingStartedAt, scanStartedAt)
    assert.equal(repository.getContext(context.contextId)?.historyFrom, run.lowerBound)
    const sourceComment: JiraIssueSnapshot['comments'][number] = {
      commentId: 'comment-1', issueId: '100', authorAccountId: 'alice-id', authorDisplayName: 'Alice',
      createdAt: scanStartedAt, updatedAt: scanStartedAt,
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'self-id', text: '@Self' } }] }] },
      excerpt: '@Self', visibility: null, availability: 'visible',
    }
    const replyOne: JiraIssueSnapshot['comments'][number] = {
      ...sourceComment,
      commentId: 'reply-one', authorAccountId: 'self-id', authorDisplayName: 'Self',
      createdAt: scanStartedAt + 1, updatedAt: scanStartedAt + 1,
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'alice-id', text: '@Alice' } }] }] },
      excerpt: '@Alice',
    }
    const replyTwo: JiraIssueSnapshot['comments'][number] = {
      ...replyOne, commentId: 'reply-two', createdAt: scanStartedAt + 2, updatedAt: scanStartedAt + 2,
    }
    const bobSource: JiraIssueSnapshot['comments'][number] = {
      ...sourceComment, commentId: 'comment-bob', authorAccountId: 'bob-id', authorDisplayName: 'Bob',
      createdAt: scanStartedAt + 3, updatedAt: scanStartedAt + 3,
    }
    const issue: JiraIssueSnapshot = {
      issue: {
        issueId: '100', issueKey: 'APP-1', summary: 'Synthetic request', projectId: '10', projectKey: 'APP', projectName: 'App',
        statusId: '1', statusName: 'Open', statusCategory: 'To Do', issueType: 'Task', priority: null,
        assignee: null, reporter: null, creator: null, createdAt: null, updatedAt: scanStartedAt, dueDate: null, resolution: null,
        description: null, attachments: [], parent: null, subtasks: [], issueLinks: [],
      },
      comments: [sourceComment],
      users: [{ accountId: 'alice-id', displayName: 'Alice', sources: ['comment_author'] }],
      observedCommentCount: 1, commentsComplete: true, updatedMarker: new Date(scanStartedAt).toISOString(),
    }
    const otherIssue: JiraIssueSnapshot = {
      ...issue,
      issue: { ...issue.issue, issueId: '101', issueKey: 'APP-2', summary: 'Other issue' },
      comments: [{ ...sourceComment, commentId: 'other-issue-source', issueId: '101' }],
    }
    repository.setExpectedIssueCount(run, 2)
    repository.stageIssueSnapshot(run, issue)
    repository.stageIssueSnapshot(run, otherIssue)
    repository.commitRun(run, { endedAt: scanStartedAt + 10, full: true })
    const projection = repository.getProjection(context.contextId, true, true, scanStartedAt + 10)
    assert.equal(projection.status, 'ready')
    assert.equal(projection.activeCount, 2)
    assert.equal(projection.items[0].state.eligibility, 'new')
    assert.equal(repository.getProjection(context.contextId, true, true, scanStartedAt + 8 * 24 * 60 * 60 * 1000).activeCount, 2)
    assert.equal(repository.getContext(context.contextId)?.historyFrom, scanStartedAt - 7 * 24 * 60 * 60 * 1000)

    repository.setMentionAction(context.contextId, '100', 'comment-1', 'dismissed', null, scanStartedAt + 10)
    assert.equal(repository.getProjection(context.contextId, true, true, scanStartedAt + 11).activeCount, 1)
    const attempt = repository.startReplyAttempt(context.contextId, '100', { type: 'doc', content: [] }, ['alice-id'], scanStartedAt + 12)
    repository.finishReplyAttempt(context.contextId, attempt.attemptId, { outcome: 'unknown', endedAt: scanStartedAt + 13, errorCode: 'network' })
    assert.equal(repository.getUnknownReplyAttempts(context.contextId, '100').length, 1)

    const nextRun = repository.startRun(context.contextId, {
      kind: 'incremental', lowerBound: context.historyFrom, scanStartedAt: scanStartedAt + 100,
      baseGeneration: 1, configGeneration: 1, ruleVersion: context.ruleVersion,
    })
    repository.setExpectedIssueCount(nextRun, 1)
    repository.stageIssueSnapshot(nextRun, { ...issue, comments: [], observedCommentCount: 0, updatedMarker: new Date(scanStartedAt + 100).toISOString() })
    assert.equal(repository.getProjection(context.contextId, true, true, scanStartedAt + 101).items[0].state.state, 'unanswered')
    repository.failRun(nextRun, scanStartedAt + 102, 'network', scanStartedAt + 200, true)
    assert.equal(repository.getProjection(context.contextId, true, true, scanStartedAt + 103).items[0].state.state, 'unanswered')

    const publishSnapshot = (
      comments: JiraIssueSnapshot['comments'],
      observedAt: number,
      additionalSnapshots: JiraIssueSnapshot[] = [],
    ): void => {
      const baseGeneration = repository.getSyncState(context.contextId).generation
      const run = repository.startRun(context.contextId, {
        kind: 'incremental', lowerBound: context.historyFrom, scanStartedAt: observedAt,
        baseGeneration, configGeneration: 1, ruleVersion: context.ruleVersion,
      })
      const nextSnapshot: JiraIssueSnapshot = {
        ...issue,
        issue: { ...issue.issue, updatedAt: observedAt },
        comments,
        observedCommentCount: comments.length,
        updatedMarker: new Date(observedAt).toISOString(),
      }
      repository.setExpectedIssueCount(run, 1 + additionalSnapshots.length)
      repository.stageIssueSnapshot(run, nextSnapshot)
      for (const additional of additionalSnapshots) repository.stageIssueSnapshot(run, additional)
      repository.commitRun(run, { endedAt: observedAt + 1, full: false })
    }
    const stateFor = (issueId: string, commentId: string): { state: string; resolving_comment_id: string | null } => {
      const row = owner.database.prepare(`SELECT state,resolving_comment_id FROM jira_mention_state
        WHERE context_id=? AND issue_id=? AND incoming_comment_id=?`).get(context.contextId, issueId, commentId)
      assert.ok(row)
      return row as { state: string; resolving_comment_id: string | null }
    }

    publishSnapshot([sourceComment, replyOne, replyTwo, bobSource], scanStartedAt + 200, [otherIssue])
    assert.deepEqual(stateFor('100', 'comment-1'), { state: 'answered', resolving_comment_id: 'reply-one' })
    assert.deepEqual(stateFor('100', 'comment-bob'), { state: 'unanswered', resolving_comment_id: null })
    assert.deepEqual(stateFor('101', 'other-issue-source'), { state: 'unanswered', resolving_comment_id: null })

    const editedAnsweredSource = {
      ...sourceComment,
      updatedAt: scanStartedAt + 205,
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'Edited request ' }, { type: 'mention', attrs: { id: 'self-id', text: '@Self' } },
      ] }] },
      excerpt: 'Edited request @Self',
    }
    publishSnapshot([editedAnsweredSource, replyOne, replyTwo, bobSource], scanStartedAt + 205, [otherIssue])
    assert.deepEqual(stateFor('100', 'comment-1'), { state: 'answered', resolving_comment_id: 'reply-one' })

    repository.setMentionAction(context.contextId, '100', 'comment-bob', 'snoozed', scanStartedAt + 60_000, scanStartedAt + 201)

    const partialWhileAnswered = repository.startRun(context.contextId, {
      kind: 'incremental', lowerBound: context.historyFrom, scanStartedAt: scanStartedAt + 250,
      baseGeneration: repository.getSyncState(context.contextId).generation, configGeneration: 1, ruleVersion: context.ruleVersion,
    })
    repository.setExpectedIssueCount(partialWhileAnswered, 1)
    repository.stageIssueFailure(partialWhileAnswered, '100', false)
    repository.failRun(partialWhileAnswered, scanStartedAt + 251, 'network', scanStartedAt + 500, true)
    assert.deepEqual(stateFor('100', 'comment-1'), { state: 'answered', resolving_comment_id: 'reply-one' })

    publishSnapshot([sourceComment, replyTwo, bobSource], scanStartedAt + 275)
    assert.deepEqual(stateFor('100', 'comment-1'), { state: 'answered', resolving_comment_id: 'reply-two' })

    publishSnapshot([sourceComment, replyOne, replyTwo, bobSource], scanStartedAt + 280)
    assert.deepEqual(stateFor('100', 'comment-1'), { state: 'answered', resolving_comment_id: 'reply-one' })

    publishSnapshot([sourceComment, replyOne, bobSource], scanStartedAt + 300)
    assert.deepEqual(stateFor('100', 'comment-1'), { state: 'answered', resolving_comment_id: 'reply-one' })

    const editedReply = {
      ...replyOne,
      updatedAt: scanStartedAt + 401,
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'I will look into it.' }] }] },
      excerpt: 'I will look into it.',
    }
    publishSnapshot([sourceComment, editedReply, bobSource], scanStartedAt + 400)
    assert.deepEqual(stateFor('100', 'comment-1'), { state: 'unanswered', resolving_comment_id: null })
    const afterReplyEdit = repository.getProjection(context.contextId, true, true, scanStartedAt + 401)
    assert.equal(afterReplyEdit.items.find((item) => item.comment.commentId === 'comment-1')?.action?.disposition, 'dismissed')
    assert.equal(afterReplyEdit.activeCount, 1)

    publishSnapshot([sourceComment, replyOne, bobSource], scanStartedAt + 500)
    assert.deepEqual(stateFor('100', 'comment-1'), { state: 'answered', resolving_comment_id: 'reply-one' })

    publishSnapshot([sourceComment, bobSource], scanStartedAt + 600)
    assert.deepEqual(stateFor('100', 'comment-1'), { state: 'unanswered', resolving_comment_id: null })
    const afterReplyDelete = repository.getProjection(context.contextId, true, true, scanStartedAt + 601)
    assert.equal(afterReplyDelete.items.find((item) => item.comment.commentId === 'comment-1')?.action?.disposition, 'dismissed')
    assert.equal(afterReplyDelete.activeCount, 1)

    const sourceWithoutAuthor = { ...sourceComment, authorAccountId: null, authorDisplayName: null, updatedAt: scanStartedAt + 701 }
    publishSnapshot([sourceWithoutAuthor, bobSource], scanStartedAt + 700)
    assert.deepEqual(stateFor('100', 'comment-1'), { state: 'unknown', resolving_comment_id: null })
    assert.deepEqual(stateFor('100', 'comment-bob'), { state: 'unanswered', resolving_comment_id: null })
    assert.equal(repository.getProjection(context.contextId, true, true, scanStartedAt + 701).activeCount, 1)

    owner.database.prepare(`UPDATE jira_cache_contexts SET rule_version=? WHERE context_id=?`)
      .run(JIRA_MENTION_RULE_VERSION - 1, context.contextId)
    assert.equal(repository.getContext(context.contextId)?.ruleVersion, JIRA_MENTION_RULE_VERSION - 1)
    const beforeRuleUpgrade = repository.getSyncState(context.contextId)
    const interruptedRuleUpgrade = repository.startRun(context.contextId, {
      kind: 'full', lowerBound: context.historyFrom, scanStartedAt: scanStartedAt + 750,
      baseGeneration: beforeRuleUpgrade.generation, configGeneration: 1, ruleVersion: JIRA_MENTION_RULE_VERSION,
    })
    repository.setExpectedIssueCount(interruptedRuleUpgrade, 1)
    repository.stageIssueFailure(interruptedRuleUpgrade, '100', false)
    repository.failRun(interruptedRuleUpgrade, scanStartedAt + 751, 'network', scanStartedAt + 900, true)
    assert.equal(repository.getContext(context.contextId)?.ruleVersion, JIRA_MENTION_RULE_VERSION - 1)
    const ruleUpgrade = repository.startRun(context.contextId, {
      kind: 'full', lowerBound: context.historyFrom, scanStartedAt: scanStartedAt + 800,
      baseGeneration: beforeRuleUpgrade.generation, configGeneration: 1, ruleVersion: JIRA_MENTION_RULE_VERSION,
    })
    assert.ok(repository.getIssueIdsForRecheck(context.contextId, true).includes('100'))
    repository.setExpectedIssueCount(ruleUpgrade, 1)
    repository.stageIssueSnapshot(ruleUpgrade, {
      ...issue,
      issue: { ...issue.issue, updatedAt: scanStartedAt + 800 },
      comments: [sourceWithoutAuthor, bobSource], observedCommentCount: 2,
      updatedMarker: new Date(scanStartedAt + 800).toISOString(),
    })
    repository.commitRun(ruleUpgrade, { endedAt: scanStartedAt + 801, full: true })
    assert.equal(repository.getContext(context.contextId)?.ruleVersion, JIRA_MENTION_RULE_VERSION)
    assert.equal(owner.database.prepare(`SELECT COUNT(*) AS count FROM jira_mention_state
      WHERE context_id=? AND rule_version<>?`).get(context.contextId, JIRA_MENTION_RULE_VERSION)?.count, 0)

    assert.equal(repository.getProjection(context.contextId, true, true, scanStartedAt + 802).activeCount, 1)
    const generationBeforeAccessLoss = repository.getSyncState(context.contextId).generation
    repository.purgeIssueAccess(context.contextId, '100')
    const afterAccessLoss = repository.getProjection(context.contextId, true, true, scanStartedAt + 803)
    assert.equal(afterAccessLoss.activeCount, 1)
    assert.equal(afterAccessLoss.items.some((item) => item.issue.issueId === '100'), false)
    assert.deepEqual(afterAccessLoss.items.map((item) => item.issue.issueId), ['101'])
    assert.equal(owner.database.prepare(`SELECT COUNT(*) AS count FROM jira_cached_issues WHERE context_id=? AND issue_id='100'`)
      .get(context.contextId)?.count, 0)
    assert.equal(repository.getSyncState(context.contextId).generation, generationBeforeAccessLoss + 1)

    owner.database.pragma('ignore_check_constraints = ON')
    owner.database.prepare(`UPDATE jira_cached_issues SET metadata_json='{' WHERE context_id=? AND issue_id='101'`)
      .run(context.contextId)
    owner.database.pragma('ignore_check_constraints = OFF')
    assert.throws(() => repository.getProjection(context.contextId, true, true, scanStartedAt + 804),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'invalid_cache'))

    repository.clearFetchedCache(context.contextId)
    assert.equal(owner.database.prepare(`SELECT COUNT(*) AS count FROM jira_mention_actions WHERE context_id=?`).get(context.contextId)?.count, 2)
    assert.equal(repository.getUnknownReplyAttempts(context.contextId, '100').length, 1)
    assert.equal(repository.getProjection(context.contextId, true, true, scanStartedAt + 104).items.length, 0)
    const contextAfterClear = repository.getContext(context.contextId)!
    const refreshedAfterClear = repository.startRun(context.contextId, {
      kind: 'initial', lowerBound: contextAfterClear.historyFrom, scanStartedAt: scanStartedAt + 1000,
      baseGeneration: repository.getSyncState(context.contextId).generation, configGeneration: 1,
      ruleVersion: JIRA_MENTION_RULE_VERSION,
    })
    assert.equal(refreshedAfterClear.lowerBound, scanStartedAt - 7 * 24 * 60 * 60 * 1000)
    assert.equal(repository.getContext(context.contextId)?.trackingStartedAt, scanStartedAt)
    repository.failRun(refreshedAfterClear, scanStartedAt + 1001, 'network')
    assert.deepEqual(owner.database.prepare(`PRAGMA foreign_key_check`).all(), [])
  } finally {
    owner.close()
  }

  const reopened = ApplicationDatabase.open(dbPath)
  try {
    const reopenedRepository = new JiraMentionsRepository(reopened.database)
    const persistedActions = reopened.database.prepare(`SELECT issue_id,incoming_comment_id,disposition,snooze_until
      FROM jira_mention_actions WHERE context_id=? ORDER BY issue_id,incoming_comment_id`).all(contextId)
    assert.deepEqual(persistedActions, [
      { issue_id: '100', incoming_comment_id: 'comment-1', disposition: 'dismissed', snooze_until: null },
      { issue_id: '100', incoming_comment_id: 'comment-bob', disposition: 'snoozed', snooze_until: 80_000 },
    ])
    assert.equal(reopenedRepository.getContext(contextId)?.historyFrom, 20_000 - 7 * 24 * 60 * 60 * 1000)
    assert.equal(reopenedRepository.getUnknownReplyAttempts(contextId, '100').length, 1)
  } finally {
    reopened.close()
  }
}

function verifyAmbiguousOldEditedMention(): void {
  const dbPath = databasePath('ambiguous-old-mention')
  createParent(dbPath)
  const owner = ApplicationDatabase.open(dbPath)
  try {
    const repository = new JiraMentionsRepository(owner.database)
    const trackingStartedAt = 1_000_000_000_000
    const context = repository.ensureVerifiedContext('https://example.atlassian.net', 'self-id', trackingStartedAt)
    const issue: JiraIssueSnapshot = {
      issue: {
        issueId: '200', issueKey: 'APP-200', summary: 'Old edited request', projectId: '10', projectKey: 'APP', projectName: 'App',
        statusId: '1', statusName: 'Open', statusCategory: 'To Do', issueType: 'Task', priority: null,
        assignee: null, reporter: null, creator: null, createdAt: null, updatedAt: trackingStartedAt,
        dueDate: null, resolution: null, description: null, attachments: [], parent: null, subtasks: [], issueLinks: [],
      },
      comments: [], users: [], observedCommentCount: 0, commentsComplete: true,
      updatedMarker: new Date(trackingStartedAt).toISOString(),
    }
    const commit = (snapshot: JiraIssueSnapshot, startedAt: number): void => {
      const sync = repository.getSyncState(context.contextId)
      const run = repository.startRun(context.contextId, {
        kind: sync.lastSuccessAt === null ? 'initial' : 'incremental',
        lowerBound: context.historyFrom, scanStartedAt: startedAt, baseGeneration: sync.generation,
        configGeneration: 1, ruleVersion: context.ruleVersion,
      })
      repository.setExpectedIssueCount(run, 1)
      repository.stageIssueSnapshot(run, snapshot)
      repository.commitRun(run, { endedAt: startedAt + 1, full: sync.lastSuccessAt === null })
    }
    commit(issue, trackingStartedAt)

    const oldMention: JiraIssueSnapshot['comments'][number] = {
      commentId: 'old-edited', issueId: '200', authorAccountId: 'alice-id', authorDisplayName: 'Alice',
      createdAt: 1_000, updatedAt: trackingStartedAt + 10,
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'self-id', text: '@Self' } }] }] },
      excerpt: '@Self', visibility: null, availability: 'visible',
    }
    const users = [{ accountId: 'alice-id', displayName: 'Alice', sources: ['comment_author'] }]
    commit({ ...issue, issue: { ...issue.issue, updatedAt: trackingStartedAt + 20 }, comments: [oldMention], users,
      observedCommentCount: 1, updatedMarker: new Date(trackingStartedAt + 20).toISOString() }, trackingStartedAt + 20)
    const state = (owner.database.prepare(`SELECT eligibility,state FROM jira_mention_state
      WHERE context_id=? AND issue_id='200' AND incoming_comment_id='old-edited'`).get(context.contextId)) as { eligibility: string; state: string }
    assert.deepEqual(state, { eligibility: 'ambiguous_edit', state: 'unanswered' })
    repository.setMentionAction(context.contextId, '200', 'old-edited', 'dismissed', null, trackingStartedAt + 21)

    const reply: JiraIssueSnapshot['comments'][number] = {
      ...oldMention, commentId: 'reply-to-old', authorAccountId: 'self-id', authorDisplayName: 'Self',
      createdAt: trackingStartedAt + 30, updatedAt: trackingStartedAt + 30,
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'alice-id', text: '@Alice' } }] }] },
      excerpt: '@Alice',
    }
    commit({ ...issue, issue: { ...issue.issue, updatedAt: trackingStartedAt + 40 }, comments: [oldMention, reply], users,
      observedCommentCount: 2, updatedMarker: new Date(trackingStartedAt + 40).toISOString() }, trackingStartedAt + 40)
    const answered = owner.database.prepare(`SELECT state,resolving_comment_id FROM jira_mention_state
      WHERE context_id=? AND issue_id='200' AND incoming_comment_id='old-edited'`).get(context.contextId)
    assert.deepEqual(answered, { state: 'answered', resolving_comment_id: 'reply-to-old' })

    commit({ ...issue, issue: { ...issue.issue, updatedAt: trackingStartedAt + 50 }, comments: [oldMention], users,
      observedCommentCount: 1, updatedMarker: new Date(trackingStartedAt + 50).toISOString() }, trackingStartedAt + 50)
    const reopened = repository.getProjection(context.contextId, true, true, trackingStartedAt + 51).items
      .find((item) => item.comment.commentId === 'old-edited')
    assert.equal(reopened?.state.state, 'unanswered')
    assert.equal(reopened?.state.eligibility, 'ambiguous_edit')
    assert.equal(reopened?.action?.disposition, 'dismissed')
    assert.equal(repository.getProjection(context.contextId, true, true, trackingStartedAt + 51).activeCount, 0)
  } finally {
    owner.close()
  }
}

function verifyOldEditEligibilitySurvivesReopen(): void {
  const dbPath = databasePath('old-edit-restart')
  createParent(dbPath)
  const trackingStartedAt = 1_700_000_000_000
  let owner = ApplicationDatabase.open(dbPath)
  try {
    let repository = new JiraMentionsRepository(owner.database)
    const context = repository.ensureVerifiedContext('https://example.atlassian.net', 'self-id', trackingStartedAt)
    const issue: JiraIssueSnapshot = {
      issue: {
        issueId: '201', issueKey: 'APP-201', summary: 'Old edited request', projectId: '10', projectKey: 'APP', projectName: 'App',
        statusId: null, statusName: null, statusCategory: null, issueType: null, priority: null, assignee: null, reporter: null,
        creator: null, createdAt: null, updatedAt: trackingStartedAt, dueDate: null, resolution: null, description: null,
        attachments: [], parent: null, subtasks: [], issueLinks: [],
      },
      comments: [{
        commentId: 'old-comment', issueId: '201', authorAccountId: 'alice-id', authorDisplayName: 'Alice',
        createdAt: trackingStartedAt - 30 * 24 * 60 * 60 * 1000, updatedAt: trackingStartedAt - 30 * 24 * 60 * 60 * 1000,
        body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Please review this request.' }] }] },
        excerpt: 'Please review this request.', visibility: null, availability: 'visible',
      }],
      users: [{ accountId: 'alice-id', displayName: 'Alice', sources: ['comment_author'] }],
      observedCommentCount: 1, commentsComplete: true, updatedMarker: new Date(trackingStartedAt).toISOString(),
    }
    const publish = (snapshot: JiraIssueSnapshot, startedAt: number): void => {
      const sync = repository.getSyncState(context.contextId)
      const run = repository.startRun(context.contextId, {
        kind: sync.lastSuccessAt === null ? 'initial' : 'incremental', lowerBound: context.historyFrom,
        scanStartedAt: startedAt, baseGeneration: sync.generation, configGeneration: 1, ruleVersion: context.ruleVersion,
      })
      repository.setExpectedIssueCount(run, 1)
      repository.stageIssueSnapshot(run, snapshot)
      repository.commitRun(run, { endedAt: startedAt + 1, full: sync.lastSuccessAt === null })
    }

    publish(issue, trackingStartedAt)
    const editedComment = {
      ...issue.comments[0],
      updatedAt: trackingStartedAt + 10,
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'Please review this request, ' },
        { type: 'mention', attrs: { id: 'self-id', text: '@Self' } },
      ] }] },
      excerpt: 'Please review this request, @Self',
    }
    publish({ ...issue, issue: { ...issue.issue, updatedAt: trackingStartedAt + 10 }, comments: [editedComment],
      updatedMarker: new Date(trackingStartedAt + 10).toISOString() }, trackingStartedAt + 10)
    const beforeRestart = repository.getProjection(context.contextId, true, true, trackingStartedAt + 11).items
      .find((item) => item.comment.commentId === 'old-comment')
    assert.equal(beforeRestart?.state.eligibility, 'ambiguous_edit')
    assert.equal(beforeRestart?.state.state, 'unanswered')
    assert.equal(repository.getProjection(context.contextId, true, true, trackingStartedAt + 11).activeCount, 1)

    owner.close()
    owner = ApplicationDatabase.open(dbPath)
    repository = new JiraMentionsRepository(owner.database)
    const afterRestart = repository.getProjection(context.contextId, true, true, trackingStartedAt + 12).items
      .find((item) => item.comment.commentId === 'old-comment')
    assert.equal(afterRestart?.state.eligibility, 'ambiguous_edit')
    assert.equal(afterRestart?.state.state, 'unanswered')
    assert.equal(repository.getProjection(context.contextId, true, true, trackingStartedAt + 12).activeCount, 1)
  } finally {
    owner.close()
  }
}

function verifyActionPersistenceAndOfflineExpiry(): void {
  const dbPath = databasePath('action-restart-expiry')
  createParent(dbPath)
  const trackingStartedAt = 1_000
  const owner = ApplicationDatabase.open(dbPath)
  let contextId = ''
  try {
    const repository = new JiraMentionsRepository(owner.database)
    const context = repository.ensureVerifiedContext('https://example.atlassian.net', 'self-id', trackingStartedAt)
    contextId = context.contextId
    const comment = (commentId: string, authorAccountId: string, createdAt: number): JiraIssueSnapshot['comments'][number] => ({
      commentId, issueId: '300', authorAccountId, authorDisplayName: authorAccountId,
      createdAt, updatedAt: createdAt,
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'self-id', text: '@Self' } }] }] },
      excerpt: '@Self', visibility: null, availability: 'visible',
    })
    const issue: JiraIssueSnapshot = {
      issue: {
        issueId: '300', issueKey: 'APP-300', summary: 'Action persistence', projectId: '10', projectKey: 'APP', projectName: 'App',
        statusId: null, statusName: null, statusCategory: null, issueType: null, priority: null, assignee: null, reporter: null,
        creator: null, createdAt: null, updatedAt: trackingStartedAt, dueDate: null, resolution: null, description: null,
        attachments: [], parent: null, subtasks: [], issueLinks: [],
      },
      comments: [], users: [], observedCommentCount: 0, commentsComplete: true, updatedMarker: new Date(trackingStartedAt).toISOString(),
    }
    const publish = (comments: JiraIssueSnapshot['comments'], scanStartedAt: number, full: boolean): void => {
      const sync = repository.getSyncState(context.contextId)
      const run = repository.startRun(context.contextId, {
        kind: sync.lastSuccessAt === null ? 'initial' : 'incremental',
        lowerBound: context.historyFrom, scanStartedAt, baseGeneration: sync.generation,
        configGeneration: 1, ruleVersion: context.ruleVersion,
      })
      const snapshot: JiraIssueSnapshot = {
        ...issue,
        issue: { ...issue.issue, updatedAt: scanStartedAt },
        comments,
        observedCommentCount: comments.length,
        updatedMarker: new Date(scanStartedAt).toISOString(),
      }
      repository.setExpectedIssueCount(run, 1)
      repository.stageIssueSnapshot(run, snapshot)
      repository.commitRun(run, { endedAt: scanStartedAt + 1, full })
    }

    publish([comment('alice', 'alice-id', trackingStartedAt + 1), comment('bob', 'bob-id', trackingStartedAt + 2)], trackingStartedAt, true)
    repository.setMentionAction(context.contextId, '300', 'alice', 'dismissed', null, trackingStartedAt + 1)
    repository.setMentionAction(context.contextId, '300', 'bob', 'snoozed', 2_000, trackingStartedAt + 2)
    publish([
      comment('alice', 'alice-id', trackingStartedAt + 1),
      comment('bob', 'bob-id', trackingStartedAt + 2),
      comment('carol', 'carol-id', trackingStartedAt + 100),
    ], trackingStartedAt + 100, false)
  } finally {
    owner.close()
  }

  const reopened = ApplicationDatabase.open(dbPath)
  try {
    const repository = new JiraMentionsRepository(reopened.database)
    const beforeExpiry = repository.getProjection(contextId, true, true, 1_500)
    assert.equal(beforeExpiry.activeCount, 1)
    assert.deepEqual(beforeExpiry.items.map((item) => [item.comment.commentId, item.action?.disposition ?? null]), [
      ['alice', 'dismissed'], ['bob', 'snoozed'], ['carol', null],
    ])

    const afterExpiry = repository.getProjection(contextId, true, true, 2_000)
    assert.equal(afterExpiry.activeCount, 2)
    assert.ok(afterExpiry.items.some((item) => item.comment.commentId === 'bob' && item.action?.disposition === 'snoozed'))
    assert.ok(afterExpiry.items.some((item) => item.comment.commentId === 'carol'))
    repository.setMentionAction(contextId, '300', 'bob', 'restored', null, 2_001)
    const restored = repository.getProjection(contextId, true, true, 2_001)
    assert.equal(restored.activeCount, 2)
    assert.equal(restored.items.find((item) => item.comment.commentId === 'bob')?.action, null)
  } finally {
    reopened.close()
  }
}

function verifyUnknownReplyRecovery(): void {
  const dbPath = databasePath('unknown-reply-recovery')
  createParent(dbPath)
  const trackingStartedAt = 1_000_000
  let contextId = ''
  const sourceComment: JiraIssueSnapshot['comments'][number] = {
    commentId: 'incoming-1', issueId: '400', authorAccountId: 'alice-id', authorDisplayName: 'Alice',
    createdAt: trackingStartedAt + 1, updatedAt: trackingStartedAt + 1,
    body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'self-id', text: '@Self' } }] }] },
    excerpt: '@Self', visibility: null, availability: 'visible',
  }
  const issue: JiraIssueSnapshot = {
    issue: {
      issueId: '400', issueKey: 'APP-400', summary: 'Uncertain reply', projectId: '10', projectKey: 'APP', projectName: 'App',
      statusId: null, statusName: null, statusCategory: null, issueType: null, priority: null,
      assignee: null, reporter: null, creator: null, createdAt: null, updatedAt: trackingStartedAt + 1,
      dueDate: null, resolution: null, description: null, attachments: [], parent: null, subtasks: [], issueLinks: [],
    },
    comments: [sourceComment], users: [{ accountId: 'alice-id', displayName: 'Alice', sources: ['comment_author'] }],
    observedCommentCount: 1, commentsComplete: true, updatedMarker: new Date(trackingStartedAt + 1).toISOString(),
  }

  const owner = ApplicationDatabase.open(dbPath)
  try {
    const repository = new JiraMentionsRepository(owner.database)
    const context = repository.ensureVerifiedContext('https://example.atlassian.net', 'self-id', trackingStartedAt)
    contextId = context.contextId
    const run = repository.startRun(context.contextId, {
      kind: 'initial', lowerBound: context.historyFrom, scanStartedAt: trackingStartedAt + 1,
      baseGeneration: 0, configGeneration: 1, ruleVersion: JIRA_MENTION_RULE_VERSION,
    })
    repository.setExpectedIssueCount(run, 1)
    repository.stageIssueSnapshot(run, issue)
    repository.commitRun(run, { endedAt: trackingStartedAt + 2, full: true })
    const attempt = repository.startReplyAttempt(context.contextId, '400', { type: 'doc', content: [] }, [], trackingStartedAt + 3)
    repository.finishReplyAttempt(context.contextId, attempt.attemptId, { outcome: 'unknown', endedAt: trackingStartedAt + 4, errorCode: 'network' })
    assert.equal(repository.getProjection(context.contextId, true, true, trackingStartedAt + 5).items[0].replyUncertain, true)
  } finally {
    owner.close()
  }

  const reopened = ApplicationDatabase.open(dbPath)
  try {
    const repository = new JiraMentionsRepository(reopened.database)
    const context = repository.getContext(contextId)!
    assert.equal(repository.getProjection(contextId, true, true, trackingStartedAt + 5).items[0].replyUncertain, true)
    assert.equal(repository.getUnreconciledUnknownReplyAttempts(contextId, '400').length, 1)
    const sync = repository.getSyncState(contextId)
    const run = repository.startRun(contextId, {
      kind: 'incremental', lowerBound: context.historyFrom, scanStartedAt: trackingStartedAt + 10,
      baseGeneration: sync.generation, configGeneration: 1, ruleVersion: context.ruleVersion,
    })
    repository.setExpectedIssueCount(run, 1)
    repository.stageIssueSnapshot(run, { ...issue, issue: { ...issue.issue, updatedAt: trackingStartedAt + 10 } })
    repository.commitRun(run, { endedAt: trackingStartedAt + 11, full: false })
    assert.equal(repository.getProjection(contextId, true, true, trackingStartedAt + 12).items[0].replyUncertain, false)
    assert.equal(repository.getUnreconciledUnknownReplyAttempts(contextId, '400').length, 0)
    assert.equal(repository.getUnknownReplyAttempts(contextId, '400')[0]?.reconciledAt, trackingStartedAt + 11)
  } finally {
    reopened.close()
  }
}

let exitCode = 0
try {
  if (!prepareE2eDatabaseFromArgs()) {
    verifyFreshAndScopedRebuild()
    verifyVersionOneUpgrade()
    verifyLegacySingleKeyMigration()
    verifyRollbackAndNewerVersionPreservation()
    verifyMentionRepositoryPublicationAndClear()
    verifyAmbiguousOldEditedMention()
    verifyOldEditEligibilitySurvivesReopen()
    verifyActionPersistenceAndOfflineExpiry()
    verifyUnknownReplyRecovery()
    process.stdout.write('Electron SQLite migration smoke passed.\n')
  }
} catch (error) {
  console.error(error)
  exitCode = 1
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
process.exit(exitCode)
