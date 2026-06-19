import Database from 'better-sqlite3'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { app } from 'electron'
import type { AgentKind, Session } from '../../shared/types'
import type { ScannedSession } from './TranscriptScanner'

const DB_PATH = path.join(app.getPath('userData'), 'session-index.db')

function normalizeStatus(status: string | null | undefined): Session['status'] {
  return status === 'live-attached' ? 'live-attached' : 'resumable'
}

function scannedToSession(row: DbRow): Session {
  return {
    agentKind: row.agentKind as AgentKind,
    sessionId: row.sessionId,
    cwd: row.cwd,
    cwdExists: fs.existsSync(row.cwd),
    projectName: row.projectName,
    displayName: row.displayName ?? null,
    gitBranch: row.gitBranch ?? null,
    firstMessage: row.firstMessage ?? null,
    lastMessage: row.lastMessage ?? null,
    firstActivity: row.firstActivity ?? null,
    lastActivity: row.lastActivity ?? null,
    messageCount: row.messageCount,
    transcriptPath: row.filePath,
    status: normalizeStatus(row.status),
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

function deriveProjectName(cwd: string): string {
  const normalized = cwd.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length >= 2) return parts.slice(-2).join('/')
  return parts[parts.length - 1] ?? cwd
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

      CREATE TABLE IF NOT EXISTS session_cwd_overrides (
        agentKind TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        cwd TEXT NOT NULL,
        projectName TEXT NOT NULL,
        updatedAt REAL NOT NULL,
        PRIMARY KEY(agentKind, sessionId)
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
    const override = this.getCwdOverride(session.agentKind, session.sessionId)
    const cwd = override?.cwd ?? session.cwd
    const projectName = override?.projectName ?? session.projectName
    const filePath = override && session.agentKind === 'claude'
      ? existingClaudeTranscriptPathForCwd(session.sessionId, cwd) ?? session.filePath
      : session.filePath
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
      cwd,
      projectName,
      displayName: session.displayName,
      gitBranch: session.gitBranch,
      firstMessage: session.firstMessage,
      lastMessage: session.lastMessage,
      firstActivity: session.firstActivity,
      lastActivity: session.lastActivity,
      messageCount: session.messageCount,
      filePath,
      mtimeMs: session.mtimeMs
    })
  }

  private getCwdOverride(agentKind: AgentKind, sessionId: string): { cwd: string; projectName: string } | null {
    const row = this.db
      .prepare(`SELECT cwd, projectName FROM session_cwd_overrides WHERE agentKind = ? AND sessionId = ?`)
      .get(agentKind, sessionId) as { cwd: string; projectName: string } | undefined
    return row ?? null
  }

  repairCwd(oldCwd: string, newCwd: string): Session[] {
    const affectedRows = this.db
      .prepare(`SELECT * FROM sessions WHERE cwd = ?`)
      .all(oldCwd) as DbRow[]
    if (affectedRows.length === 0) return []

    const projectName = deriveProjectName(newCwd)
    const claudeFilePaths = copyClaudeProjectDirectories(affectedRows, newCwd)
    const updatedAt = Date.now()
    const tx = this.db.transaction(() => {
      const upsertOverride = this.db.prepare(`
        INSERT INTO session_cwd_overrides (agentKind, sessionId, cwd, projectName, updatedAt)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(agentKind, sessionId) DO UPDATE SET
          cwd = excluded.cwd,
          projectName = excluded.projectName,
          updatedAt = excluded.updatedAt
      `)

      const updateSession = this.db.prepare(`
        UPDATE sessions
        SET cwd = ?, projectName = ?, filePath = ?
        WHERE agentKind = ? AND sessionId = ?
      `)

      for (const row of affectedRows) {
        const agentKind = row.agentKind as AgentKind
        const filePath = claudeFilePaths.get(row.sessionId) ?? row.filePath
        upsertOverride.run(agentKind, row.sessionId, newCwd, projectName, updatedAt)
        updateSession.run(newCwd, projectName, filePath, agentKind, row.sessionId)
      }
    })
    tx()

    const updatedRows = this.db
      .prepare(`SELECT * FROM sessions WHERE cwd = ? ORDER BY lastActivity DESC NULLS LAST`)
      .all(newCwd) as DbRow[]
    return updatedRows.map(scannedToSession)
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

function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/\\/g, '-').replace(/\//g, '-').replace(/:/g, '-')
}

function claudeProjectDirForCwd(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodeClaudeProjectDir(cwd))
}

function claudeTranscriptPathForCwd(sessionId: string, cwd: string): string {
  return path.join(claudeProjectDirForCwd(cwd), `${sessionId}.jsonl`)
}

function existingClaudeTranscriptPathForCwd(sessionId: string, cwd: string): string | null {
  const targetPath = claudeTranscriptPathForCwd(sessionId, cwd)
  return fs.existsSync(targetPath) ? targetPath : null
}

function copyClaudeProjectDirectories(rows: DbRow[], newCwd: string): Map<string, string> {
  const claudeRows = rows.filter((row) => row.agentKind === 'claude')
  const targetPaths = new Map<string, string>()
  if (claudeRows.length === 0) return targetPaths

  const targetDir = claudeProjectDirForCwd(newCwd)
  const sourceDirs = new Set<string>()
  for (const row of claudeRows) {
    if (row.filePath && fs.existsSync(row.filePath)) sourceDirs.add(path.dirname(row.filePath))
    targetPaths.set(row.sessionId, path.join(targetDir, `${row.sessionId}.jsonl`))
  }

  for (const sourceDir of sourceDirs) {
    if (path.resolve(sourceDir) === path.resolve(targetDir)) continue
    copyDirectoryContents(sourceDir, targetDir)
  }

  return targetPaths
}

function copyDirectoryContents(sourceDir: string, targetDir: string): void {
  if (!fs.existsSync(sourceDir)) return
  fs.mkdirSync(targetDir, { recursive: true })
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      copyDirectoryContents(sourcePath, targetPath)
      continue
    }
    if (!entry.isFile()) continue
    if (fs.existsSync(targetPath)) {
      if (filesAreEqual(sourcePath, targetPath)) continue
      fs.copyFileSync(targetPath, `${targetPath}.bak.${Date.now()}`)
    }
    fs.copyFileSync(sourcePath, targetPath)
  }
}

function filesAreEqual(aPath: string, bPath: string): boolean {
  const aStat = fs.statSync(aPath)
  const bStat = fs.statSync(bPath)
  if (aStat.size !== bStat.size) return false

  const chunkSize = 64 * 1024
  const aBuffer = Buffer.allocUnsafe(chunkSize)
  const bBuffer = Buffer.allocUnsafe(chunkSize)
  const aFd = fs.openSync(aPath, 'r')
  const bFd = fs.openSync(bPath, 'r')
  try {
    let position = 0
    while (position < aStat.size) {
      const length = Math.min(chunkSize, aStat.size - position)
      const aRead = fs.readSync(aFd, aBuffer, 0, length, position)
      const bRead = fs.readSync(bFd, bBuffer, 0, length, position)
      if (aRead !== bRead) return false
      if (!aBuffer.subarray(0, aRead).equals(bBuffer.subarray(0, bRead))) return false
      position += aRead
    }
    return true
  } finally {
    fs.closeSync(aFd)
    fs.closeSync(bFd)
  }
}
