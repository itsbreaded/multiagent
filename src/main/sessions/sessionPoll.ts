import type { Session } from '../../shared/types'
import type { ScannedSession } from './TranscriptScanner'

export function createSessionPoller(deps: {
  scanAll(): Promise<ScannedSession[]>
  index: { upsertMany(sessions: ScannedSession[]): { changed: number }; getAll(): Session[] }
  broadcast(sessions: Session[]): void
}): { poll(force?: boolean): Promise<void> } {
  let inFlight = false
  let forcePending = false
  let lastCwdFingerprint = ''
  return {
    async poll(force = false): Promise<void> {
      if (inFlight) {
        forcePending ||= force
        return
      }
      inFlight = true
      try {
        const effectiveForce = force || forcePending
        forcePending = false
        const scanned = await deps.scanAll()
        const { changed } = deps.index.upsertMany(scanned)
        const all = deps.index.getAll()
        const cwdFingerprint = [...new Map(all.map((session) => [session.cwd, session.cwdExists])).entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([cwd, exists]) => `${cwd}\0${exists ? 1 : 0}`)
          .join('\0')
        if (effectiveForce || changed > 0 || cwdFingerprint !== lastCwdFingerprint) deps.broadcast(all)
        lastCwdFingerprint = cwdFingerprint
      } finally {
        inFlight = false
      }
    },
  }
}
