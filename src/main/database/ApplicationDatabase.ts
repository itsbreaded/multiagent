import Database from 'better-sqlite3'

export const APPLICATION_DATABASE_VERSION = 3

export type ApplicationDatabaseErrorCode = 'unsupported_schema' | 'migration_failed' | 'database_unavailable'

export class ApplicationDatabaseError extends Error {
  constructor(readonly code: ApplicationDatabaseErrorCode) {
    super(code === 'unsupported_schema'
      ? 'The application database was created by a newer version.'
      : 'The application database could not be opened safely.')
    this.name = 'ApplicationDatabaseError'
  }
}

/** Owns the one on-disk database and its coordinated schema history. */
export class ApplicationDatabase {
  private closed = false

  private constructor(readonly database: Database.Database) {}

  static open(dbPath: string): ApplicationDatabase {
    let database: Database.Database | undefined
    try {
      database = new Database(dbPath)
      const version = database.pragma('user_version', { simple: true }) as number
      if (version > APPLICATION_DATABASE_VERSION) {
        throw new ApplicationDatabaseError('unsupported_schema')
      }

      database.pragma('busy_timeout = 5000')
      database.pragma('foreign_keys = ON')
      database.pragma('journal_mode = WAL')
      migrate(database, version)
      return new ApplicationDatabase(database)
    } catch (error) {
      try { database?.close() } catch { /* preserve the original failure */ }
      if (error instanceof ApplicationDatabaseError) throw error
      throw new ApplicationDatabaseError('migration_failed')
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try { this.database.close() } catch { /* already closed */ }
  }
}

/** Rebuild only the disposable session search projection, preserving every other table. */
export function rebuildSessionSearchIndex(database: Database.Database): void {
  database.exec(`
    DROP TRIGGER IF EXISTS sessions_ai;
    DROP TRIGGER IF EXISTS sessions_ad;
    DROP TRIGGER IF EXISTS sessions_au;
    DROP TABLE IF EXISTS sessions_fts;
    CREATE VIRTUAL TABLE sessions_fts USING fts5(
      agentKind UNINDEXED, sessionId UNINDEXED, projectName, displayName,
      firstMessage, lastMessage, content=sessions, content_rowid=rowid
    );
    CREATE TRIGGER sessions_ai AFTER INSERT ON sessions BEGIN
      INSERT INTO sessions_fts(rowid, agentKind, sessionId, projectName, displayName, firstMessage, lastMessage)
      VALUES (new.rowid, new.agentKind, new.sessionId, new.projectName, new.displayName, new.firstMessage, new.lastMessage);
    END;
    CREATE TRIGGER sessions_ad AFTER DELETE ON sessions BEGIN
      INSERT INTO sessions_fts(sessions_fts, rowid, agentKind, sessionId, projectName, displayName, firstMessage, lastMessage)
      VALUES ('delete', old.rowid, old.agentKind, old.sessionId, old.projectName, old.displayName, old.firstMessage, old.lastMessage);
    END;
    CREATE TRIGGER sessions_au AFTER UPDATE ON sessions BEGIN
      INSERT INTO sessions_fts(sessions_fts, rowid, agentKind, sessionId, projectName, displayName, firstMessage, lastMessage)
      VALUES ('delete', old.rowid, old.agentKind, old.sessionId, old.projectName, old.displayName, old.firstMessage, old.lastMessage);
      INSERT INTO sessions_fts(rowid, agentKind, sessionId, projectName, displayName, firstMessage, lastMessage)
      VALUES (new.rowid, new.agentKind, new.sessionId, new.projectName, new.displayName, new.firstMessage, new.lastMessage);
    END;
    INSERT INTO sessions_fts(sessions_fts) VALUES('rebuild');
  `)
}

function migrate(database: Database.Database, initialVersion: number): void {
  if (initialVersion === APPLICATION_DATABASE_VERSION) return

  database.transaction(() => {
    let version = initialVersion
    if (version < 1) {
      migrateSessionSchema(database)
      database.pragma('user_version = 1')
      version = 1
    }
    if (version < 2) {
      migrateJiraMentionsSchema(database)
      database.pragma('user_version = 2')
      version = 2
    }
    if (version < 3) {
      migrateJiraTrackingAnchorSchema(database)
      database.pragma('user_version = 3')
    }
  }).immediate()
}

function migrateJiraTrackingAnchorSchema(database: Database.Database): void {
  const columns = database.pragma('table_info(jira_cache_contexts)') as Array<{ name: string }>
  if (columns.some((column) => column.name === 'initial_scan_started')) return
  // Existing contexts already have a history boundary. Preserve it across upgrade;
  // only contexts created by the current version start uninitialized.
  database.exec(`ALTER TABLE jira_cache_contexts ADD COLUMN initial_scan_started INTEGER NOT NULL DEFAULT 1 CHECK(initial_scan_started IN (0,1))`)
}

function migrateSessionSchema(database: Database.Database): void {
  database.exec(`
    DROP TRIGGER IF EXISTS sessions_ai;
    DROP TRIGGER IF EXISTS sessions_ad;
    DROP TRIGGER IF EXISTS sessions_au;
    DROP TABLE IF EXISTS sessions_fts;
  `)

  const existing = database
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`)
    .get() as { sql: string } | undefined

  if (existing?.sql.includes('sessionId TEXT PRIMARY KEY')) {
    database.exec(`
      ALTER TABLE sessions RENAME TO sessions_old;
      CREATE TABLE sessions (
        agentKind TEXT NOT NULL DEFAULT 'claude', sessionId TEXT NOT NULL,
        cwd TEXT NOT NULL, projectName TEXT NOT NULL, displayName TEXT,
        gitBranch TEXT, firstMessage TEXT, lastMessage TEXT, firstActivity TEXT,
        lastActivity TEXT, messageCount INTEGER NOT NULL DEFAULT 0,
        filePath TEXT NOT NULL, mtimeMs REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'resumable', UNIQUE(agentKind, sessionId)
      );
      INSERT INTO sessions (
        agentKind, sessionId, cwd, projectName, displayName, gitBranch,
        firstMessage, lastMessage, firstActivity, lastActivity, messageCount,
        filePath, mtimeMs, status
      )
      SELECT 'claude', sessionId, cwd, projectName, NULL, gitBranch,
        firstMessage, lastMessage, firstActivity, lastActivity, messageCount,
        filePath, mtimeMs, status
      FROM sessions_old;
      DROP TABLE sessions_old;
    `)
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      agentKind TEXT NOT NULL DEFAULT 'claude', sessionId TEXT NOT NULL,
      cwd TEXT NOT NULL, projectName TEXT NOT NULL, displayName TEXT,
      gitBranch TEXT, firstMessage TEXT, lastMessage TEXT, firstActivity TEXT,
      lastActivity TEXT, messageCount INTEGER NOT NULL DEFAULT 0,
      filePath TEXT NOT NULL, mtimeMs REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'resumable', UNIQUE(agentKind, sessionId)
    );

    CREATE TABLE IF NOT EXISTS session_cwd_overrides (
      agentKind TEXT NOT NULL, sessionId TEXT NOT NULL, cwd TEXT NOT NULL,
      projectName TEXT NOT NULL, updatedAt REAL NOT NULL,
      PRIMARY KEY(agentKind, sessionId)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
      agentKind UNINDEXED, sessionId UNINDEXED, projectName, displayName,
      firstMessage, lastMessage, content=sessions, content_rowid=rowid
    );

    CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
      INSERT INTO sessions_fts(rowid, agentKind, sessionId, projectName, displayName, firstMessage, lastMessage)
      VALUES (new.rowid, new.agentKind, new.sessionId, new.projectName, new.displayName, new.firstMessage, new.lastMessage);
    END;
    CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
      INSERT INTO sessions_fts(sessions_fts, rowid, agentKind, sessionId, projectName, displayName, firstMessage, lastMessage)
      VALUES ('delete', old.rowid, old.agentKind, old.sessionId, old.projectName, old.displayName, old.firstMessage, old.lastMessage);
    END;
    CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE ON sessions BEGIN
      INSERT INTO sessions_fts(sessions_fts, rowid, agentKind, sessionId, projectName, displayName, firstMessage, lastMessage)
      VALUES ('delete', old.rowid, old.agentKind, old.sessionId, old.projectName, old.displayName, old.firstMessage, old.lastMessage);
      INSERT INTO sessions_fts(rowid, agentKind, sessionId, projectName, displayName, firstMessage, lastMessage)
      VALUES (new.rowid, new.agentKind, new.sessionId, new.projectName, new.displayName, new.firstMessage, new.lastMessage);
    END;
    CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
    CREATE INDEX IF NOT EXISTS idx_sessions_lastActivity ON sessions(lastActivity);
    INSERT INTO sessions_fts(sessions_fts) VALUES('rebuild');
  `)
}

function migrateJiraMentionsSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS jira_cache_contexts (
      context_id TEXT PRIMARY KEY, site_url TEXT NOT NULL, self_account_id TEXT NOT NULL,
      tracking_started_at INTEGER NOT NULL, history_from INTEGER NOT NULL,
      identity_verified_at INTEGER NOT NULL, rule_version INTEGER NOT NULL,
      discovery_version INTEGER NOT NULL, committed_generation INTEGER NOT NULL DEFAULT 0,
      UNIQUE(site_url, self_account_id)
    );
    CREATE TABLE IF NOT EXISTS jira_cached_issues (
      context_id TEXT NOT NULL, issue_id TEXT NOT NULL, issue_key TEXT NOT NULL,
      metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)), jira_updated_at INTEGER,
      metadata_fetched_at INTEGER NOT NULL, comment_snapshot_at INTEGER, comment_count INTEGER,
      access_state TEXT NOT NULL CHECK(access_state IN ('visible','partial','unavailable')),
      generation INTEGER NOT NULL, PRIMARY KEY(context_id, issue_id),
      FOREIGN KEY(context_id) REFERENCES jira_cache_contexts(context_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS jira_comments (
      context_id TEXT NOT NULL, issue_id TEXT NOT NULL, comment_id TEXT NOT NULL,
      author_account_id TEXT, author_name TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      body_json TEXT NOT NULL CHECK(json_valid(body_json)), excerpt TEXT NOT NULL,
      visibility_json TEXT NOT NULL CHECK(json_valid(visibility_json)), body_hash TEXT NOT NULL,
      fetched_at INTEGER NOT NULL, availability TEXT NOT NULL CHECK(availability IN ('visible','removed','unavailable')),
      generation INTEGER NOT NULL, PRIMARY KEY(context_id, issue_id, comment_id),
      FOREIGN KEY(context_id, issue_id) REFERENCES jira_cached_issues(context_id, issue_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS jira_comment_mentions (
      context_id TEXT NOT NULL, issue_id TEXT NOT NULL, comment_id TEXT NOT NULL, mentioned_account_id TEXT NOT NULL,
      PRIMARY KEY(context_id, issue_id, comment_id, mentioned_account_id),
      FOREIGN KEY(context_id, issue_id, comment_id) REFERENCES jira_comments(context_id, issue_id, comment_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS jira_issue_users (
      context_id TEXT NOT NULL, issue_id TEXT NOT NULL, account_id TEXT NOT NULL, display_name TEXT,
      avatar_url TEXT, active INTEGER, sources_json TEXT NOT NULL CHECK(json_valid(sources_json)), generation INTEGER NOT NULL,
      PRIMARY KEY(context_id, issue_id, account_id),
      FOREIGN KEY(context_id, issue_id) REFERENCES jira_cached_issues(context_id, issue_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS jira_mention_state (
      context_id TEXT NOT NULL, issue_id TEXT NOT NULL, incoming_comment_id TEXT NOT NULL,
      author_account_id TEXT, source_created_at INTEGER NOT NULL, source_updated_at INTEGER NOT NULL,
      source_hash TEXT NOT NULL, first_observed_at INTEGER NOT NULL, eligible_edit_at INTEGER,
      eligibility TEXT NOT NULL CHECK(eligibility IN ('initial','new','edit','ambiguous_edit','excluded')),
      state TEXT NOT NULL CHECK(state IN ('unanswered','answered','removed','unknown')),
      resolving_comment_id TEXT, resolving_created_at INTEGER, rule_version INTEGER NOT NULL,
      computed_at INTEGER NOT NULL, generation INTEGER NOT NULL,
      PRIMARY KEY(context_id, issue_id, incoming_comment_id),
      FOREIGN KEY(context_id, issue_id, incoming_comment_id) REFERENCES jira_comments(context_id, issue_id, comment_id) ON DELETE CASCADE,
      FOREIGN KEY(context_id, issue_id, resolving_comment_id) REFERENCES jira_comments(context_id, issue_id, comment_id)
    );
    CREATE TABLE IF NOT EXISTS jira_mention_actions (
      context_id TEXT NOT NULL, issue_id TEXT NOT NULL, incoming_comment_id TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK(disposition IN ('dismissed','snoozed')), snooze_until INTEGER,
      updated_at INTEGER NOT NULL, PRIMARY KEY(context_id, issue_id, incoming_comment_id),
      FOREIGN KEY(context_id) REFERENCES jira_cache_contexts(context_id) ON DELETE CASCADE,
      CHECK((disposition='dismissed' AND snooze_until IS NULL) OR (disposition='snoozed' AND snooze_until IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS jira_sync_runs (
      context_id TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL, lower_bound INTEGER NOT NULL,
      scan_started_at INTEGER NOT NULL, ended_at INTEGER, base_generation INTEGER NOT NULL,
      config_generation INTEGER NOT NULL, rule_version INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('running','success','partial','failed','interrupted')),
      discovery_complete INTEGER NOT NULL DEFAULT 0, expected_issues INTEGER NOT NULL DEFAULT 0,
      completed_issues INTEGER NOT NULL DEFAULT 0, safe_error_code TEXT, PRIMARY KEY(context_id, run_id),
      FOREIGN KEY(context_id) REFERENCES jira_cache_contexts(context_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS jira_sync_state (
      context_id TEXT PRIMARY KEY, last_attempt_run_id TEXT, last_success_run_id TEXT,
      last_success_started_at INTEGER, last_success_ended_at INTEGER, last_full_at INTEGER,
      checkpoint INTEGER, coverage_from INTEGER, coverage_through INTEGER,
      backfill_complete INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0,
      retry_not_before INTEGER,
      FOREIGN KEY(context_id) REFERENCES jira_cache_contexts(context_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS jira_sync_issue_work (
      context_id TEXT NOT NULL, run_id TEXT NOT NULL, issue_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('pending','complete','failed','access_lost')),
      fetched_at INTEGER, snapshot_json TEXT CHECK(snapshot_json IS NULL OR json_valid(snapshot_json)),
      PRIMARY KEY(context_id, run_id, issue_id),
      FOREIGN KEY(context_id, run_id) REFERENCES jira_sync_runs(context_id, run_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS jira_reply_attempts (
      context_id TEXT NOT NULL, attempt_id TEXT NOT NULL, issue_id TEXT NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER,
      outcome TEXT NOT NULL CHECK(outcome IN ('sending','confirmed','rejected','unknown')),
      body_hash TEXT NOT NULL, mentioned_ids_json TEXT NOT NULL CHECK(json_valid(mentioned_ids_json)),
      returned_comment_id TEXT, safe_error_code TEXT, reconciled_at INTEGER,
      PRIMARY KEY(context_id, attempt_id),
      FOREIGN KEY(context_id) REFERENCES jira_cache_contexts(context_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS jira_issues_updated ON jira_cached_issues(context_id, jira_updated_at);
    CREATE INDEX IF NOT EXISTS jira_comments_created ON jira_comments(context_id, issue_id, created_at, comment_id);
    CREATE INDEX IF NOT EXISTS jira_comments_author ON jira_comments(context_id, issue_id, author_account_id, created_at);
    CREATE INDEX IF NOT EXISTS jira_mentions_target ON jira_comment_mentions(context_id, mentioned_account_id, issue_id, comment_id);
    CREATE INDEX IF NOT EXISTS jira_states_active ON jira_mention_state(context_id, state, source_created_at DESC, issue_id);
    CREATE INDEX IF NOT EXISTS jira_states_reply ON jira_mention_state(context_id, issue_id, resolving_comment_id);
    CREATE INDEX IF NOT EXISTS jira_actions_expiry ON jira_mention_actions(context_id, disposition, snooze_until);
    CREATE INDEX IF NOT EXISTS jira_runs_outcome ON jira_sync_runs(context_id, outcome, scan_started_at);
    CREATE INDEX IF NOT EXISTS jira_work_outcome ON jira_sync_issue_work(context_id, run_id, outcome);
    CREATE INDEX IF NOT EXISTS jira_attempts_outcome ON jira_reply_attempts(context_id, issue_id, outcome);
  `)
}
