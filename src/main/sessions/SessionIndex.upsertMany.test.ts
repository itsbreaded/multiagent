import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScannedSession } from './TranscriptScanner'
import { SessionIndex } from './SessionIndex'

function scanned(sessionId: string): ScannedSession {
  return {
    agentKind: 'claude',
    sessionId,
    cwd: `C:\\repo\\${sessionId}`,
    projectName: sessionId,
    displayName: null,
    gitBranch: null,
    firstMessage: null,
    lastMessage: null,
    firstActivity: null,
    lastActivity: null,
    messageCount: 1,
    transcriptPath: `C:\\transcripts\\${sessionId}.jsonl`,
    filePath: `C:\\transcripts\\${sessionId}.jsonl`,
    mtimeMs: 1,
  }
}

describe('SessionIndex.upsertMany malformed-row tolerance', () => {
  afterEach(() => vi.restoreAllMocks())

  it('commits valid rows while logging and skipping a malformed row', () => {
    const index = Object.create(SessionIndex.prototype) as SessionIndex
    const internals = index as unknown as {
      db: { transaction<T extends () => void>(fn: T): T }
      mtimesStmt: { all(): unknown[] }
      upsert(session: ScannedSession): void
    }
    internals.db = { transaction: (fn) => fn }
    internals.mtimesStmt = { all: () => [] }
    const committed: string[] = []
    internals.upsert = (session) => {
      if (!session.sessionId) throw new Error('missing session id')
      committed.push(session.sessionId)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const malformed = { ...scanned('bad'), sessionId: undefined } as unknown as ScannedSession

    expect(index.upsertMany([scanned('good-1'), malformed, scanned('good-2')])).toEqual({ changed: 2 })
    expect(committed).toEqual(['good-1', 'good-2'])
    expect(warn).toHaveBeenCalledOnce()
  })
})
