import { shell } from 'electron'
import { isE2ERun, recordE2EExternalOpenAttempt } from './e2eIsolation'

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function openExternalUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }

  if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) return
  openExternalProtocol(parsed.toString())
}

/** Route intentional OS integrations through the E2E launch suppression policy too. */
export function openExternalProtocol(url: string): void {
  if (isE2ERun) {
    recordE2EExternalOpenAttempt(url)
    return
  }
  shell.openExternal(url).catch((err) => {
    console.error('[MultiAgent] Failed to open external URL:', err)
  })
}

export function openExternalPath(path: string): Promise<string> {
  if (isE2ERun) {
    recordE2EExternalOpenAttempt(path)
    return Promise.resolve('')
  }
  return shell.openPath(path)
}
