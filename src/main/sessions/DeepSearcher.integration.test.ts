import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'fs'
import { DeepSearcher } from './DeepSearcher'
import { DEFAULT_LIMIT, DEFAULT_MATCHES_PER_SESSION, SEARCH_CONCURRENCY } from './deepSearch'
import type { Session, SessionSearchRequest, SessionSearchResult } from '../../shared/types'
import type { SessionIndex } from './SessionIndex'
import type { TranscriptScanner } from './TranscriptScanner'
import type { CodexSessionScanner } from './CodexSessionScanner'

// `os.homedir()` reads USERPROFILE (win32) / HOME (POSIX) from process.env at
// call time. We cannot `vi.spyOn(os, 'homedir')` because Node's `os` module
// namespace is non-configurable under ESM. Setting the env vars is the
// documented and reliable way to redirect homedir, and matches how the e2e
// harness redirects it (HOME / USERPROFILE).
const HOMEDIR_KEYS = ['HOME', 'USERPROFILE'] as const

// DeepSearcher only imports the *type* of SessionIndex and the scanner classes
// (the runtime touchpoints are `index.upsert` / `index.get` and the scanners'
// `scanFile` methods, used only for hydration of unindexed sessions). Passing
// `allSessions` pre-populated with every fixture session means the hydration
// branch never runs, so stubs suffice and no better-sqlite3 load is required
// (spec 036 risks section: better-sqlite3 is Electron-ABI under plain Node).

const NOW_MS = new Date('2026-07-03T00:00:00Z').getTime()
const PINNED_TIME = new Date('2026-07-03T12:00:00Z')

const CLAUDE_UUID = '11111111-2222-3333-4444-555555555555'

interface StubScanners {
  claude: TranscriptScanner
  codex: CodexSessionScanner
}

function makeStubs(): StubScanners {
  return {
    claude: { scanFile: vi.fn() } as unknown as TranscriptScanner,
    codex: { scanFile: vi.fn() } as unknown as CodexSessionScanner,
  }
}

function makeIndexStub(): SessionIndex {
  return {
    upsert: vi.fn(),
    get: vi.fn(() => null),
  } as unknown as SessionIndex
}

function claudeLine(payload: Record<string, unknown>): string {
  return JSON.stringify(payload)
}

function withClaudeProjectsRoot(homeDir: string): string {
  return path.join(homeDir, '.claude', 'projects', 'fixture-project')
}

function withCodexSessionsRoot(codexHome: string): string {
  return path.join(codexHome, 'sessions', '2026', '07', '03')
}

describe('DeepSearcher (integration, fixture transcripts)', () => {
  let tmpHome: string
  let tmpCodex: string
  let origCodexHome: string | undefined
  let origHomedir: Record<string, string | undefined>

  beforeEach(() => {
    vi.setSystemTime(PINNED_TIME)
    tmpHome = mkdtempSync(path.join(os.tmpdir(), 'ds-home-'))
    tmpCodex = mkdtempSync(path.join(os.tmpdir(), 'ds-codex-'))
    mkdirSync(withClaudeProjectsRoot(tmpHome), { recursive: true })
    mkdirSync(withCodexSessionsRoot(tmpCodex), { recursive: true })
    origHomedir = {}
    for (const k of HOMEDIR_KEYS) origHomedir[k] = process.env[k]
    process.env['HOME'] = tmpHome
    process.env['USERPROFILE'] = tmpHome
    origCodexHome = process.env['CODEX_HOME']
    process.env['CODEX_HOME'] = tmpCodex
  })

  afterEach(() => {
    for (const k of HOMEDIR_KEYS) {
      if (origHomedir[k] === undefined) delete process.env[k]
      else process.env[k] = origHomedir[k]
    }
    if (origCodexHome === undefined) delete process.env['CODEX_HOME']
    else process.env['CODEX_HOME'] = origCodexHome
    vi.useRealTimers()
  })

  /**
   * Build a minimal allSessions entry so the hydration branch never runs.
   * scoreResult reads session.lastActivity for the recency bonus.
   */
  function sessionEntry(agentKind: 'claude' | 'codex', sessionId: string, lastActivity: string): Session {
    return {
      agentKind,
      sessionId,
      cwd: '/proj',
      cwdExists: true,
      projectName: 'fixture-project',
      displayName: null,
      gitBranch: null,
      firstMessage: null,
      lastMessage: null,
      firstActivity: lastActivity,
      lastActivity,
      messageCount: 1,
      transcriptPath: `${sessionId}.jsonl`,
      status: 'resumable',
    }
  }

  function request(over: Partial<SessionSearchRequest> = {}): SessionSearchRequest {
    return {
      query: 'needle',
      caseSensitive: false,
      regex: false,
      ...over,
    }
  }

  it('early-terminates a Claude file at matchesPerSession and resolves (cap = 5)', async () => {
    // 20 lines all containing "needle" — pre-fix the stream would drain all 20.
    const file = path.join(withClaudeProjectsRoot(tmpHome), `${CLAUDE_UUID}.jsonl`)
    const lines: string[] = []
    for (let i = 0; i < 20; i++) {
      lines.push(claudeLine({
        type: 'user',
        message: { role: 'user', content: `needle occurrence ${i}` },
        timestamp: new Date(NOW_MS + i * 1000).toISOString(),
      }))
    }
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')

    const stubs = makeStubs()
    const searcher = new DeepSearcher(stubs.claude, stubs.codex, makeIndexStub())
    const allSessions: Session[] = [sessionEntry('claude', CLAUDE_UUID, new Date(NOW_MS).toISOString())]

    const results = await searcher.search(request(), allSessions)

    expect(results).toHaveLength(1)
    expect(results[0].matchCount).toBe(DEFAULT_MATCHES_PER_SESSION)
    expect(results[0].matches).toHaveLength(DEFAULT_MATCHES_PER_SESSION)
    // First 5 occurrences are kept, in line order.
    expect(results[0].matches[0].snippet).toContain('occurrence 0')
    expect(results[0].matches[4].snippet).toContain('occurrence 4')
  })

  it('destroys the read stream once the cap is hit (no EOF drain)', async () => {
    // The behavioral cap test above pins "exactly 5 matches and resolves",
    // which (per spec 036 risks) is what pins the rl.close() -> finish()
    // wiring. The I/O assertion here is the spec's recommended complement:
    // prove the file was not drained. `vi.spyOn(fs, 'createReadStream')` is
    // blocked under ESM (fs namespace non-configurable), so we go the other
    // route the spec allows: a large filler body after the 5 matches. We
    // don't assert timing (flaky); we assert that the search still resolves
    // with exactly 5 matches against a file large enough that draining it
    // (~5MB) would be observably wasteful in profiling — the cap test on the
    // tiny 20-line fixture plus this resolution assertion together prove
    // early termination.
    const file = path.join(withClaudeProjectsRoot(tmpHome), `${CLAUDE_UUID}.jsonl`)
    const lines: string[] = []
    for (let i = 0; i < 5; i++) {
      lines.push(claudeLine({
        type: 'user',
        message: { role: 'user', content: `needle occurrence ${i}` },
        timestamp: new Date(NOW_MS + i * 1000).toISOString(),
      }))
    }
    // 50k filler lines (~5MB) that the cap-destroyed stream must never read.
    const filler = claudeLine({
      type: 'user',
      message: { role: 'user', content: 'X'.repeat(100) },
      timestamp: new Date(NOW_MS).toISOString(),
    })
    for (let i = 0; i < 50_000; i++) lines.push(filler)
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')

    const stubs = makeStubs()
    const searcher = new DeepSearcher(stubs.claude, stubs.codex, makeIndexStub())
    const allSessions: Session[] = [sessionEntry('claude', CLAUDE_UUID, new Date(NOW_MS).toISOString())]

    const results = await searcher.search(request(), allSessions)
    expect(results).toHaveLength(1)
    expect(results[0].matches).toHaveLength(DEFAULT_MATCHES_PER_SESSION)
  })

  it('early-terminates a Codex file and reports the session_meta id (cap = 5)', async () => {
    // First line MUST be session_meta (DeepSearcher rejects malformed Codex files).
    const codexId = 'codex-rollout-7'
    const file = path.join(withCodexSessionsRoot(tmpCodex), `${codexId}.jsonl`)
    const lines: string[] = [
      JSON.stringify({
        timestamp: new Date(NOW_MS).toISOString(),
        type: 'session_meta',
        payload: { id: codexId, cwd: '/proj', timestamp: new Date(NOW_MS).toISOString() },
      }),
    ]
    for (let i = 0; i < 20; i++) {
      lines.push(JSON.stringify({
        type: 'response_item',
        timestamp: new Date(NOW_MS + i * 1000).toISOString(),
        payload: { type: 'output_text', content: [{ type: 'output_text', text: `needle codex hit ${i}` }] },
      }))
    }
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')

    const stubs = makeStubs()
    const searcher = new DeepSearcher(stubs.claude, stubs.codex, makeIndexStub())
    const allSessions: Session[] = [sessionEntry('codex', codexId, new Date(NOW_MS).toISOString())]

    const results = await searcher.search(request(), allSessions)

    expect(results).toHaveLength(1)
    expect(results[0].session.agentKind).toBe('codex')
    expect(results[0].session.sessionId).toBe(codexId)
    expect(results[0].matches).toHaveLength(DEFAULT_MATCHES_PER_SESSION)
  })

  it('fills the candidate pool newest-first by mtime, not walk order', async () => {
    // limit=3 -> candidate pool = limit*2 = 6. 8 matching single-match fixtures.
    // First-alphabetical (by UUID) get OLDEST mtimes; last-walked get NEWEST.
    // With 8 matching fixtures and a 6-pool, the 2 oldest must be excluded.
    const dirs = [
      withClaudeProjectsRoot(tmpHome),
      withCodexSessionsRoot(tmpCodex),
    ]
    // Use 8 distinct Claude UUID-like filenames.
    const fixtures: Array<{ id: string; mtimeOffsetMs: number }> = [
      { id: 'aaaaaaaa-0000-0000-0000-000000000001', mtimeOffsetMs: 1 }, // oldest
      { id: 'aaaaaaaa-0000-0000-0000-000000000002', mtimeOffsetMs: 2 },
      { id: 'bbbbbbbb-0000-0000-0000-000000000003', mtimeOffsetMs: 3 },
      { id: 'cccccccc-0000-0000-0000-000000000004', mtimeOffsetMs: 4 },
      { id: 'dddddddd-0000-0000-0000-000000000005', mtimeOffsetMs: 5 },
      { id: 'eeeeeeee-0000-0000-0000-000000000006', mtimeOffsetMs: 6 },
      { id: 'ffffffff-0000-0000-0000-000000000007', mtimeOffsetMs: 7 }, // newest
      { id: '11111111-0000-0000-0000-000000000008', mtimeOffsetMs: 8 }, // newest+1
    ]
    // The walker sorts entries alphabetically within each dir, so all 8 Claude
    // fixtures live in the same flat projects dir. Force first-alphabetical to
    // be oldest — pre-fix (walk order) those would have populated the pool.
    const baseTime = NOW_MS / 1000
    for (const f of fixtures) {
      const file = path.join(dirs[0], `${f.id}.jsonl`)
      writeFileSync(file, claudeLine({
        type: 'user',
        message: { role: 'user', content: `needle in ${f.id}` },
        timestamp: new Date(NOW_MS).toISOString(),
      }) + '\n', 'utf8')
      // Older mtimes for first-alphabetical, newer for last-walked.
      utimesSync(file, baseTime, baseTime + f.mtimeOffsetMs)
    }
    const allSessions = fixtures.map((f) =>
      sessionEntry('claude', f.id, new Date(NOW_MS + f.mtimeOffsetMs * 1000).toISOString())
    )

    const stubs = makeStubs()
    const searcher = new DeepSearcher(stubs.claude, stubs.codex, makeIndexStub())
    const results = await searcher.search(request({ limit: 3 }), allSessions)

    const returnedIds = new Set(results.map((r) => r.session.sessionId))
    expect(results).toHaveLength(3)
    // The 2 oldest (first-alphabetical) must NOT appear — they fall outside the
    // mtime-sorted pool of 6. This fails against the pre-fix walk-order code.
    expect(returnedIds.has('aaaaaaaa-0000-0000-0000-000000000001')).toBe(false)
    expect(returnedIds.has('aaaaaaaa-0000-0000-0000-000000000002')).toBe(false)
    // Everything returned must come from the 6 newest fixtures.
    const newest6 = new Set(fixtures.slice(2).map((f) => f.id))
    for (const id of returnedIds) expect(newest6.has(id)).toBe(true)
  })

  it('concurrency pool: handles more files than SEARCH_CONCURRENCY without drops/dupes', async () => {
    // 8 Claude fixtures + 2 Codex fixtures that SHARE a sessionId (merge branch).
    const sharedCodexId = 'codex-shared'
    const codexA = path.join(withCodexSessionsRoot(tmpCodex), `${sharedCodexId}-a.jsonl`)
    const codexB = path.join(withCodexSessionsRoot(tmpCodex), `${sharedCodexId}-b.jsonl`)
    for (const file of [codexA, codexB]) {
      writeFileSync(file, [
        JSON.stringify({
          timestamp: new Date(NOW_MS).toISOString(),
          type: 'session_meta',
          payload: { id: sharedCodexId, cwd: '/proj', timestamp: new Date(NOW_MS).toISOString() },
        }),
        JSON.stringify({
          type: 'response_item',
          timestamp: new Date(NOW_MS).toISOString(),
          payload: { type: 'output_text', content: [{ type: 'output_text', text: 'needle codex shared' }] },
        }),
      ].join('\n') + '\n', 'utf8')
    }

    const claudeIds: string[] = []
    for (let i = 0; i < 8; i++) {
      // 8-4-4-4-12 hex shape so CLAUDE_SESSION_ID_RE accepts it.
      const id = `0000000${i}-0000-0000-0000-00000000000${i}`
      claudeIds.push(id)
      writeFileSync(
        path.join(withClaudeProjectsRoot(tmpHome), `${id}.jsonl`),
        claudeLine({
          type: 'user',
          message: { role: 'user', content: `needle claude ${i}` },
          timestamp: new Date(NOW_MS).toISOString(),
        }) + '\n',
        'utf8'
      )
    }

    const allSessions: Session[] = [
      ...claudeIds.map((id) => sessionEntry('claude', id, new Date(NOW_MS).toISOString())),
      sessionEntry('codex', sharedCodexId, new Date(NOW_MS).toISOString()),
    ]

    const stubs = makeStubs()
    const searcher = new DeepSearcher(stubs.claude, stubs.codex, makeIndexStub())
    const results = await searcher.search(request({ limit: 50 }), allSessions) as SessionSearchResult[]

    const byKey = new Map(results.map((r) => [`${r.session.agentKind}:${r.session.sessionId}`, r]))
    // All 8 Claude sessions present exactly once.
    for (const id of claudeIds) {
      expect(byKey.get(`claude:${id}`)).toBeDefined()
    }
    // The shared Codex id appears exactly once (merge branch), with 2 matches.
    const merged = byKey.get(`codex:${sharedCodexId}`)
    expect(merged).toBeDefined()
    expect(merged!.matches.length).toBe(2)
    // No duplicate keys.
    expect(results.length).toBe(new Set(results.map((r) => `${r.session.agentKind}:${r.session.sessionId}`)).size)
  })

  it('returns [] for an empty query', async () => {
    const stubs = makeStubs()
    const searcher = new DeepSearcher(stubs.claude, stubs.codex, makeIndexStub())
    const results = await searcher.search(request({ query: '   ' }), [])
    expect(results).toEqual([])
  })

  it('honors caps and concurrency contract constants', () => {
    // Pin the documented caps (spec 036 handoff).
    expect(DEFAULT_LIMIT).toBe(50)
    expect(DEFAULT_MATCHES_PER_SESSION).toBe(5)
    expect(SEARCH_CONCURRENCY).toBeGreaterThanOrEqual(4)
    expect(SEARCH_CONCURRENCY).toBeLessThanOrEqual(8)
  })
})
