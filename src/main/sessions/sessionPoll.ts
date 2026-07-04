import type { Session } from '../../shared/types'
import type { ScannedSession } from './TranscriptScanner'

export function createSessionPoller(deps: {
  scanAll(): Promise<ScannedSession[]>
  index: { upsertMany(sessions: ScannedSession[]): { changed: number }; getAll(): Session[] }
  broadcast(sessions: Session[]): void
}): { poll(force?: boolean): Promise<void>; markDirty(): void } {
  let inFlight: Promise<void> | null = null
  let queuedForce: Promise<void> | null = null
  let externalDirty = false
  let lastCwdFingerprint = ''
  async function run(force: boolean): Promise<void> {
    const task = (async () => {
      try {
        const scanned = await deps.scanAll()
        const { changed } = deps.index.upsertMany(scanned)
        const all = deps.index.getAll()
        const cwdFingerprint = [...new Map(all.map((session) => [session.cwd, session.cwdExists])).entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([cwd, exists]) => `${cwd}\0${exists ? 1 : 0}`)
          .join('\0')
        if (force || changed > 0 || externalDirty || cwdFingerprint !== lastCwdFingerprint) {
          deps.broadcast(all)
          externalDirty = false
        }
        lastCwdFingerprint = cwdFingerprint
      } finally {
        inFlight = null
      }
    })()
    inFlight = task
    await task
  }
  return {
    async poll(force = false): Promise<void> {
      if (!inFlight) return run(force)
      if (!force) return
      if (!queuedForce) {
        const active = inFlight
        queuedForce = (async () => {
          await active
          await run(true)
        })().finally(() => { queuedForce = null })
      }
      await queuedForce
    },
    markDirty(): void { externalDirty = true },
  }
}
