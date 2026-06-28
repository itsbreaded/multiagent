import * as path from 'path'
import * as os from 'os'

/**
 * Pure path helpers for the on-disk Claude transcript layout.
 *
 * Claude Code stores transcripts under `~/.claude/projects/<encoded-cwd>/`, where
 * the encoded form replaces every path separator and colon with a dash. Extracted
 * from `SessionIndex.ts` so the encoding is testable without better-sqlite3
 * (which is Electron-ABI only and cannot load under the plain-Node test runner —
 * see spec 030).
 */

/** Encode a cwd into the Claude projects-directory segment (separators + colons → dashes). */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/\\/g, '-').replace(/\//g, '-').replace(/:/g, '-')
}

/** The projects directory Claude uses for a given cwd. */
export function claudeProjectDirForCwd(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodeClaudeProjectDir(cwd))
}

/** The transcript file path for a specific session within a cwd's project dir. */
export function claudeTranscriptPathForCwd(sessionId: string, cwd: string): string {
  return path.join(claudeProjectDirForCwd(cwd), `${sessionId}.jsonl`)
}
