import { describe, it, expect, afterEach } from 'vitest'
import {
  normalizePath,
  codexCandidateMatchesPending,
  selectCodexAssignments,
  SESSION_DETECTION_GRACE_MS,
  type CodexPendingLike,
  type CodexCandidateLike,
} from './codexDetection'

// Codex session-detection invariants (spec 003/008): a pane claims a rollout
// only on an unambiguous cwd/time match, and ambiguous matches are IGNORED
// rather than guessed. These guard against latching a pane onto the wrong
// rollout when several sessions share a cwd.

interface Pending extends CodexPendingLike {}
interface Candidate extends CodexCandidateLike {}

const startedAt = 1_000_000

const mkPending = (over: Partial<Pending>): Pending => ({
  ptyId: 'p1',
  normalizedCwd: normalizePath('C:\\proj'),
  startedAt,
  firstMessageAt: startedAt + 1,
  resumedSessionId: undefined,
  baselinePaths: new Set<string>(),
  ...over,
})

const mkCandidate = (over: Partial<Candidate>): Candidate => ({
  filePath: 'C:\\codex\\rollout-1.jsonl',
  sessionId: 'rollout-1',
  normalizedCwd: normalizePath('C:\\proj'),
  timestampMs: startedAt + 2,
  ...over,
})

describe('normalizePath', () => {
  const original = process.platform
  afterEach(() => Object.defineProperty(process, 'platform', { value: original }))

  // Use a single-segment input so the assertion isolates the case behavior from
  // path.normalize's separator flipping (which follows the HOST path module, not
  // a stubbed process.platform — both dev and CI are win32).
  it('lowercases on win32 for case-insensitive cwd comparison', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(normalizePath('Proj')).toBe('proj')
  })
  it('preserves case off win32', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    expect(normalizePath('Proj')).toBe('Proj')
  })
})

describe('codexCandidateMatchesPending', () => {
  it('matches a fresh, same-cwd candidate', () => {
    expect(codexCandidateMatchesPending(mkCandidate({}), mkPending({}))).toBe(true)
  })
  it('rejects a baseline (pre-existing) file', () => {
    const candidate = mkCandidate({})
    const pending = mkPending({ baselinePaths: new Set([candidate.filePath]) })
    expect(codexCandidateMatchesPending(candidate, pending)).toBe(false)
  })
  it('rejects a different cwd', () => {
    expect(
      codexCandidateMatchesPending(
        mkCandidate({ normalizedCwd: normalizePath('C:\\other') }),
        mkPending({})
      )
    ).toBe(false)
  })
  it('rejects the rollout a resumed pane explicitly resumed from', () => {
    expect(
      codexCandidateMatchesPending(
        mkCandidate({ sessionId: 'resumed-id' }),
        mkPending({ resumedSessionId: 'resumed-id' })
      )
    ).toBe(false)
  })
  it('rejects a candidate that predates spawn beyond the grace window', () => {
    const tooOld = startedAt - SESSION_DETECTION_GRACE_MS - 1
    expect(codexCandidateMatchesPending(mkCandidate({ timestampMs: tooOld }), mkPending({}))).toBe(false)
  })
  it('accepts a candidate within the grace window', () => {
    const within = startedAt - SESSION_DETECTION_GRACE_MS
    expect(codexCandidateMatchesPending(mkCandidate({ timestampMs: within }), mkPending({}))).toBe(true)
  })
})

describe('selectCodexAssignments', () => {
  it('claims a single messaged pending against a single matching candidate', () => {
    const pending = [mkPending({ ptyId: 'p1' })]
    const candidates = [mkCandidate({ sessionId: 'r1' })]
    const { claims, ambiguities } = selectCodexAssignments(pending, candidates, new Set())
    expect(claims).toHaveLength(1)
    expect(claims[0].pending.ptyId).toBe('p1')
    expect(claims[0].candidate.sessionId).toBe('r1')
    expect(ambiguities).toHaveLength(0)
  })

  it('does not claim when the single pending has not been messaged yet', () => {
    const pending = [mkPending({ ptyId: 'p1', firstMessageAt: null })]
    const candidates = [mkCandidate({})]
    const { claims, ambiguities } = selectCodexAssignments(pending, candidates, new Set())
    expect(claims).toHaveLength(0)
    expect(ambiguities).toHaveLength(0)
  })

  it('reports ambiguity (no claim) when one pending matches two candidates', () => {
    const pending = [mkPending({ ptyId: 'p1' })]
    const candidates = [
      mkCandidate({ filePath: 'a.jsonl', sessionId: 'r-a' }),
      mkCandidate({ filePath: 'b.jsonl', sessionId: 'r-b' }),
    ]
    const { claims, ambiguities } = selectCodexAssignments(pending, candidates, new Set())
    expect(claims).toHaveLength(0)
    expect(ambiguities).toHaveLength(1)
    expect(ambiguities[0].candidates).toHaveLength(2)
  })

  it('claims when multiple pendings exist but exactly one is messaged and one candidate matches', () => {
    const pending = [
      mkPending({ ptyId: 'p1', firstMessageAt: null }),
      mkPending({ ptyId: 'p2', firstMessageAt: startedAt + 5 }),
    ]
    const candidates = [mkCandidate({ sessionId: 'r1' })]
    const { claims, ambiguities } = selectCodexAssignments(pending, candidates, new Set())
    expect(claims).toHaveLength(1)
    expect(claims[0].pending.ptyId).toBe('p2')
    expect(ambiguities).toHaveLength(0)
  })

  it('reports ambiguity when two pendings are both messaged', () => {
    const pending = [
      mkPending({ ptyId: 'p1', firstMessageAt: 1 }),
      mkPending({ ptyId: 'p2', firstMessageAt: 2 }),
    ]
    const candidates = [mkCandidate({ sessionId: 'r1' })]
    const { claims, ambiguities } = selectCodexAssignments(pending, candidates, new Set())
    expect(claims).toHaveLength(0)
    expect(ambiguities).toHaveLength(1)
  })

  it('skips candidates already claimed', () => {
    const candidate = mkCandidate({ filePath: 'claimed.jsonl', sessionId: 'r1' })
    const pending = [mkPending({ ptyId: 'p1' })]
    const { claims, ambiguities } = selectCodexAssignments(
      pending,
      [candidate],
      new Set(['claimed.jsonl'])
    )
    expect(claims).toHaveLength(0)
    expect(ambiguities).toHaveLength(0)
  })

  it('ignores candidates whose cwd does not match any pending', () => {
    const pending = [mkPending({ ptyId: 'p1' })]
    const candidates = [mkCandidate({ normalizedCwd: normalizePath('C:\\elsewhere'), sessionId: 'r1' })]
    const { claims, ambiguities } = selectCodexAssignments(pending, candidates, new Set())
    expect(claims).toHaveLength(0)
    expect(ambiguities).toHaveLength(0)
  })
})
