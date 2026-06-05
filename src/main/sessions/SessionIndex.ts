import Database from 'better-sqlite3'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import type { Session } from '../../shared/types'
import type { ScannedSession } from './TranscriptScanner'

const DB_PATH = path.join(os.homedir(), '.claude', 'multiagent-index.db')

function scannedToSession(row: DbRow): Session {
  return {
    sessionId: row.sessionId,
    cwd: row.cwd,
    projectName: row.projectName,
    gitBranch: row.gitBranch ?? null,
    firstMessage: row.firstMessage ?? null,
    lastMessage: row.lastMessage ?? null,
    firstActivity: row.firstActivity ?? null,
    lastActivity: row.lastActivity ?? null,
    messageCount: row.messageCount,
    status: (row.status as Session['status']) ?? 'resumable',
  }
}

interface DbRow {
  sessionId: string
  cwd: string
  projectName: string
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
      CREATE TABLE IF NOT EXISTS sessions (
        sessionId TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        projectName TEXT NOT NULL,
        gitBranch TEXT,
        firstMessage TEXT,
        lastMessage TEXT,
        firstActivity TEXT,
        lastActivity TEXT,
        messageCount INTEGER NOT NULL DEFAULT 0,
        filePath TEXT NOT NULL,
        mtimeMs REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'resumable'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        sessionId UNINDEXED,
        firstMessage,
        lastMessage,
        content=sessions,
        content_rowid=rowid
      );

      CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
        INSERT INTO sessions_fts(rowid, sessionId, firstMessage, lastMessage)
        VALUES (new.rowid, new.sessionId, new.firstMessage, new.lastMessage);
      END;

      CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
        INSERT INTO sessions_fts(sessions_fts, rowid, sessionId, firstMessage, lastMessage)
        VALUES ('delete', old.rowid, old.sessionId, old.firstMessage, old.lastMessage);
      END;

      CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE ON sessions BEGIN
        INSERT INTO sessions_fts(sessions_fts, rowid, sessionId, firstMessage, lastMessage)
        VALUES ('delete', old.rowid, old.sessionId, old.firstMessage, old.lastMessage);
        INSERT INTO sessions_fts(rowid, sessionId, firstMessage, lastMessage)
        VALUES (new.rowid, new.sessionId, new.firstMessage, new.lastMessage);
      END;
    `)
  }

  upsert(session: ScannedSession): void {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (
        sessionId, cwd, projectName, gitBranch, firstMessage, lastMessage,
        firstActivity, lastActivity, messageCount, filePath, mtimeMs, status
      ) VALUES (
        @sessionId, @cwd, @projectName, @gitBranch, @firstMessage, @lastMessage,
        @firstActivity, @lastActivity, @messageCount, @filePath, @mtimeMs, 'resumable'
      )
      ON CONFLICT(sessionId) DO UPDATE SET
        cwd = excluded.cwd,
        projectName = excluded.projectName,
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
      sessionId: session.sessionId,
      cwd: session.cwd,
      projectName: session.projectName,
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

  has(sessionId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM sessions WHERE sessionId = ?').get(sessionId)
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

  delete(sessionId: string): void {
    // Get filePath before deleting
    const row = this.db
      .prepare(`SELECT filePath FROM sessions WHERE sessionId = ?`)
      .get(sessionId) as { filePath: string } | undefined

    this.db.prepare(`DELETE FROM sessions WHERE sessionId = ?`).run(sessionId)

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
