import * as path from 'path'

/**
 * Pure Codex session-detection logic — extracted from `SessionSpawner.ts` so the
 * candidate-matching and ambiguity-resolution invariants (spec 003/008) can be
 * tested without a live PTY / BrowserWindow.
 *
 * Detection works against already-read rollout candidates and pending pane
 * detections. The non-negotiable invariant: an ambiguous match is IGNORED, never
 * assigned — a pane must not latch onto the wrong rollout.
 */

export const SESSION_DETECTION_GRACE_MS = 5_000

/** Structural subset of a pending Codex pane detection. */
export interface CodexPendingLike {
  ptyId: string
  normalizedCwd: string
  startedAt: number
  firstMessageAt: number | null
  resumedSessionId?: string
  baselinePaths: Set<string>
}

/** Structural subset of a discovered Codex rollout candidate file. */
export interface CodexCandidateLike {
  filePath: string
  sessionId: string
  normalizedCwd: string
  timestampMs: number
}

/** Normalize a path for cwd comparison (case-insensitive on win32). Pin process.platform in tests. */
export function normalizePath(value: string): string {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * Does this rollout candidate plausibly belong to this pending detection?
 * - It must not be a pre-existing (baseline) file captured before the pane spawned.
 * - cwd must match (normalized).
 * - For a resumed pane, the candidate must not be the rollout we resumed from.
 * - The candidate must not predate the pane's spawn by more than the grace window.
 */
export function codexCandidateMatchesPending<C extends CodexCandidateLike>(
  candidate: C,
  pending: CodexPendingLike
): boolean {
  if (pending.baselinePaths.has(candidate.filePath)) return false
  if (candidate.normalizedCwd !== pending.normalizedCwd) return false
  if (pending.resumedSessionId && candidate.sessionId === pending.resumedSessionId) return false
  if (candidate.timestampMs > 0 && candidate.timestampMs < pending.startedAt - SESSION_DETECTION_GRACE_MS)
    return false
  return true
}

export interface CodexAssignmentClaim<P, C> {
  pending: P
  candidate: C
}

export interface CodexAssignmentAmbiguity<P, C> {
  cwdKey: string
  pending: P[]
  candidates: C[]
}

export interface CodexAssignmentResult<P, C> {
  claims: CodexAssignmentClaim<P, C>[]
  ambiguities: CodexAssignmentAmbiguity<P, C>[]
}

/**
 * Decide which pending detection claims which rollout candidate. Mirrors the
 * SessionSpawner decision tree exactly:
 *
 *  - Group pending + candidates by normalized cwd.
 *  - Single pending, single candidate that matches and has been messaged → claim.
 *  - Single pending, multiple matching candidates → ambiguous (do NOT claim).
 *  - Multiple pendings → claim only if exactly one has been messaged AND exactly
 *    one candidate matches it; otherwise ambiguous.
 *
 * Ambiguous groups are returned, never silently assigned. The caller applies
 * claims (and logs ambiguities) against live state.
 */
export function selectCodexAssignments<
  P extends CodexPendingLike,
  C extends CodexCandidateLike
>(pending: P[], candidates: C[], claimedFiles: Set<string>): CodexAssignmentResult<P, C> {
  const claims: CodexAssignmentClaim<P, C>[] = []
  const ambiguities: CodexAssignmentAmbiguity<P, C>[] = []

  const cwdKeys = new Set<string>([
    ...pending.map((p) => p.normalizedCwd),
    ...candidates.map((c) => c.normalizedCwd),
  ])

  for (const cwdKey of cwdKeys) {
    const cwdPending = pending.filter((p) => p.normalizedCwd === cwdKey)
    if (cwdPending.length === 0) continue
    const cwdCandidates = candidates.filter(
      (c) =>
        !claimedFiles.has(c.filePath) &&
        c.normalizedCwd === cwdKey &&
        cwdPending.some((p) => codexCandidateMatchesPending(c, p))
    )
    if (cwdCandidates.length === 0) continue

    if (cwdPending.length === 1) {
      if (cwdPending[0].firstMessageAt === null) continue
      if (
        cwdCandidates.length === 1 &&
        codexCandidateMatchesPending(cwdCandidates[0], cwdPending[0])
      ) {
        claims.push({ pending: cwdPending[0], candidate: cwdCandidates[0] })
      } else {
        ambiguities.push({ cwdKey, pending: cwdPending, candidates: cwdCandidates })
      }
      continue
    }

    const messagedPending = cwdPending.filter((p) => p.firstMessageAt !== null)
    if (messagedPending.length !== 1 || cwdCandidates.length !== 1) {
      ambiguities.push({ cwdKey, pending: messagedPending, candidates: cwdCandidates })
      continue
    }

    const target = messagedPending[0]
    const candidate = cwdCandidates[0]
    if (codexCandidateMatchesPending(candidate, target)) {
      claims.push({ pending: target, candidate })
    } else {
      ambiguities.push({ cwdKey, pending: messagedPending, candidates: cwdCandidates })
    }
  }

  return { claims, ambiguities }
}
