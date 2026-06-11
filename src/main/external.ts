import { shell } from 'electron'

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function openExternalUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }

  if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) return
  shell.openExternal(parsed.toString()).catch((err) => {
    console.error('[MultiAgent] Failed to open external URL:', err)
  })
}
