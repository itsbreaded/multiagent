import Database from 'better-sqlite3'
import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'
import type { AgentKind, Session } from '../../shared/types'
import type { ScannedSession } from './TranscriptScanner'

const DB_PATH = path.join(app.getPath('userData'), 'session-index.db')

function scannedToSession(row: DbRow): Session {
  return {
    agentKind: row.agentKind as AgentKind,
    sessionId: row.sessionId,
    cwd: row.cwd,
    projectName: row.projectName,
    displayName: row.displayName ?? null,
    gitBranch: row.gitBranch ?? null,
    firstMessage: row.firstMessage ?? null,
    lastMessage: row.lastMessage ?? null,
    firstActivity: row.firstActivity ?? null,
    lastActivity: row.lastActivity ?? null,
    messageCount: row.messageCount,
    transcriptPath: row.filePath,
    status: (row.status as Session['status']) ?? 'resumable',
  }
}

interface DbRow {
  agentKind: string
  sessionId: string
  cwd: string
  projectName: string
  displayName: string | null
  gitBranch: string | null
  firstMessage: string | null
  lastMessage: string | null
  firstActivity: string | null
  lastActivity: string | null
  messageCount: number
  filePath: string
  mtimeMs: number
  status: string
}

export class SessionIndex {
  private db: Database.Database

  constructor() {
    this.db = new Database(DB_PATH)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      DROP TRIGGER IF EXISTS sessions_ai;
      DROP TRIGGER IF EXISTS sessions_ad;
      DROP TRIGGER IF EXISTS sessions_au;
      DROP TABLE IF EXISTS sessions_fts;
    `)

    const existing = this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`)
      .get() as { sql: string } | undefined

    if (existing?.sql.includes('sessionId TEXT PRIMARY KEY')) {
      this.db.exec(`
        ALTER TABLE sessions RENAME TO sessions_old;

        CREATE TABLE sessions (
          agentKind TEXT NOT NULL DEFAULT 'claude',
          sessionId TEXT NOT NULL,
          cwd TEXT NOT NULL,
          projectName TEXT NOT NULL,
          displayName TEXT,
          gitBranch TEXT,
          firstMessage TEXT,
          lastMessage TEXT,
          firstActivity TEXT,
          lastActivity TEXT,
          messageCount INTEGER NOT NULL DEFAULT 0,
          filePath TEXT NOT NULL,
          mtimeMs REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'resumable',
          UNIQUE(agentKind, sessionId)
        );

        INSERT INTO sessions (
          agentKind, sessionId, cwd, projectName, displayName, gitBranch,
          firstMessage, lastMessage, firstActivity, lastActivity, messageCount,
          filePath, mtimeMs, status
        )
        SELECT
          'claude', sessionId, cwd, projectName, NULL, gitBranch,
          firstMessage, lastMessage, firstActivity, lastActivity, messageCount,
          filePath, mtimeMs, status
        FROM sessions_old;

        DROP TABLE sessions_old;
      `)
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        agentKind TEXT NOT NULL DEFAULT 'claude',
        sessionId TEXT NOT NULL,
        cwd TEXT NOT NULL,
        projectName TEXT NOT NULL,
        displayName TEXT,
        gitBranch TEXT,
        firstMessage TEXT,
        lastMessage TEXT,
        firstActivity TEXT,
        lastActivity TEXT,
        messageCount INTEGER NOT NULL DEFAULT 0,
        filePath TEXT NOT NULL,
        mtimeMs REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'resumable',
        UNIQUE(agentKind, sessionId)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        agentKind UNINDEXED,
        sessionId UNINDEXED,
        projectName,
        displayName,
        firstMessage,
        lastMessage,
        content=sessions,
        content_rowid=rowid
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

      INSERT INTO sessions_fts(sessions_fts) VALUES('rebuild');
    `)
  }

  upsert(session: ScannedSession): void {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (
        agentKind, sessionId, cwd, projectName, displayName, gitBranch, firstMessage, lastMessage,
        firstActivity, lastActivity, messageCount, filePath, mtimeMs, status
      ) VALUES (
        @agentKind, @sessionId, @cwd, @projectName, @displayName, @gitBranch, @firstMessage, @lastMessage,
        @firstActivity, @lastActivity, @messageCount, @filePath, @mtimeMs, 'resumable'
      )
      ON CONFLICT(agentKind, sessionId) DO UPDATE SET
        cwd = excluded.cwd,
        projectName = excluded.projectName,
        displayName = excluded.displayName,
        gitBranch = excluded.gitBranch,
        firstMessage = excluded.firstMessage,
        lastMessage = excluded.lastMessage,
        firstActivity = excluded.firstActivity,
        lastActivity = excluded.lastActivity,
        messageCount = excluded.messageCount,
        filePath = excluded.filePath,
        mtimeMs = excluded.mtimeMs
    `)

    stmt.run({
      agentKind: session.agentKind,
      sessionId: session.sessionId,
      cwd: session.cwd,
      projectName: session.projectName,
      displayName: session.displayName,
      gitBranch: session.gitBranch,
      firstMessage: session.firstMessage,
      lastMessage: session.lastMessage,
      firstActivity: session.firstActivity,
      lastActivity: session.lastActivity,
      messageCount: session.messageCount,
      filePath: session.filePath,
      mtimeMs: session.mtimeMs
    })
  }

  has(agentKind: AgentKind, sessionId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM sessions WHERE agentKind = ? AND sessionId = ?').get(agentKind, sessionId)
  }

  getAll(): Session[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions ORDER BY lastActivity DESC NULLS LAST`
      )
      .all() as DbRow[]
    return rows.map(scannedToSession)
  }

  getByProject(cwd: string): Session[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE cwd = ? ORDER BY lastActivity DESC NULLS LAST`)
      .all(cwd) as DbRow[]
    return rows.map(scannedToSession)
  }

  search(query: string): Session[] {
    if (!query.trim()) return this.getAll()

    // FTS5 search - join back to sessions for full row data
    const rows = this.db
      .prepare(
        `
        SELECT s.*
        FROM sessions s
        JOIN sessions_fts fts ON s.rowid = fts.rowid
        WHERE sessions_fts MATCH ?
        ORDER BY rank
      `
      )
      .all(query) as DbRow[]
    return rows.map(scannedToSession)
  }

  delete(agentKind: AgentKind, sessionId: string): void {
    // Get filePath before deleting
    const row = this.db
      .prepare(`SELECT filePath FROM sessions WHERE agentKind = ? AND sessionId = ?`)
      .get(agentKind, sessionId) as { filePath: string } | undefined

    this.db.prepare(`DELETE FROM sessions WHERE agentKind = ? AND sessionId = ?`).run(agentKind, sessionId)

    if (row?.filePath) {
      try {
        fs.unlinkSync(row.filePath)
      } catch {
        // File may already be gone - ignore
      }
    }
  }

  close(): void {
    this.db.close()
  }
}
