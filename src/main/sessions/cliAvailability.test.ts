import { describe, it, expect, beforeEach } from 'vitest'
import { detectProviderAvailability, applyAvailabilityToSettings, type StatLike } from './cliAvailability'
import { defaultAgentProviderSettings } from '../../shared/agentProviderSettings'
import type { AgentProviderSettings, ProviderAvailability } from '../../shared/types'

// spec 055: the startup availability check resolves the bare command token each
// SessionSpawner launches (`claude`/`codex`/`opencode`) against the app's PATH,
// applying PATHEXT on Windows. We inject a synthetic async stat function so the
// POSIX exec-bit branch is testable on any host (NTFS does not track Unix exec
// bits, so a real-file POSIX test would be host-dependent). Detection is async
// (never fs.statSync) so a large PATH never blocks the main-process event loop.

type Entry = { isFile: boolean; mode: number }
let files: Map<string, Entry>

beforeEach(() => {
  files = new Map()
})

// Injectable async statFn: resolves a StatLike for any path in the synthetic FS,
// else rejects with an ENOENT-style error the way fs.promises.stat does.
async function statFn(p: string): Promise<StatLike> {
  const entry = files.get(String(p))
  if (!entry) {
    const err = new Error('ENOENT') as NodeJS.ErrnoException
    err.code = 'ENOENT'
    throw err
  }
  return { isFile: () => entry.isFile, mode: entry.mode }
}

function setFile(fullPath: string, opts: Partial<Entry> = {}): void {
  files.set(fullPath, { isFile: true, mode: 0o755, ...opts })
}

describe('detectProviderAvailability (spec 055)', () => {
  it('marks a kind available when its binary is on PATH (POSIX, exec bit set)', async () => {
    setFile('/bin/claude', { mode: 0o755 })
    setFile('/usr/local/bin/codex', { mode: 0o755 })
    const result = await detectProviderAvailability(
      { path: '/bin:/usr/local/bin', platform: 'linux' },
      statFn,
    )
    expect(result.claude).toBe(true)
    expect(result.codex).toBe(true)
    expect(result.opencode).toBe(false)
  })

  it('applies PATHEXT on Windows and resolves claude.cmd', async () => {
    setFile('C:\\tools\\claude.CMD')
    const result = await detectProviderAvailability(
      { path: 'C:\\tools;D:\\missing', platform: 'win32', patheext: '.COM;.EXE;.BAT;.CMD' },
      statFn,
    )
    expect(result.claude).toBe(true)
    expect(result.codex).toBe(false)
    expect(result.opencode).toBe(false)
  })

  it('falls back to a default PATHEXT list when PATHEXT is absent on win32', async () => {
    setFile('C:\\tools\\opencode.EXE')
    const result = await detectProviderAvailability(
      { path: 'C:\\tools', platform: 'win32' },
      statFn,
    )
    expect(result.opencode).toBe(true)
  })

  it('reports all unavailable when PATH is empty', async () => {
    const result = await detectProviderAvailability({ path: '', platform: 'linux' }, statFn)
    expect(result).toEqual({ claude: false, codex: false, opencode: false })
  })

  it('reports all unavailable when PATH is undefined', async () => {
    const result = await detectProviderAvailability({ path: undefined, platform: 'linux' }, statFn)
    expect(result).toEqual({ claude: false, codex: false, opencode: false })
  })

  it('ignores a non-executable file on POSIX', async () => {
    setFile('/bin/claude', { mode: 0o644 }) // present but not executable
    const result = await detectProviderAvailability({ path: '/bin', platform: 'linux' }, statFn)
    expect(result.claude).toBe(false)
  })

  it('treats a regular file as executable on Windows (no exec bit needed)', async () => {
    setFile('C:\\tools\\codex.BAT')
    const result = await detectProviderAvailability(
      { path: 'C:\\tools', platform: 'win32', patheext: '.BAT' },
      statFn,
    )
    expect(result.codex).toBe(true)
  })

  it('ignores a directory shadowing the binary name', async () => {
    setFile('/bin/claude', { isFile: false, mode: 0o755 })
    const result = await detectProviderAvailability({ path: '/bin', platform: 'linux' }, statFn)
    expect(result.claude).toBe(false)
  })

  it('is stateless — detection follows the filesystem, not saved state', async () => {
    // The one-way "never re-enable" rule is enforced by the caller only ever
    // writing enabled=false. Here we confirm the detector reports the FS as-is.
    const first = await detectProviderAvailability({ path: '', platform: 'linux' }, statFn)
    setFile('/bin/codex', { mode: 0o755 })
    const second = await detectProviderAvailability({ path: '/bin', platform: 'linux' }, statFn)
    expect(first.codex).toBe(false)
    expect(second.codex).toBe(true)
  })
})

describe('applyAvailabilityToSettings (spec 055 Req 2/3)', () => {
  function allEnabled(): AgentProviderSettings {
    const s = defaultAgentProviderSettings() // enabled: true by default now
    return s
  }

  it('force-disables enabled providers that were not detected', () => {
    const s = allEnabled()
    const avail: ProviderAvailability = { claude: false, codex: true, opencode: false }
    const next = applyAvailabilityToSettings(s, avail)
    expect(next.claude.enabled).toBe(false)
    expect(next.codex.enabled).toBe(true)
    expect(next.opencode.enabled).toBe(false)
  })

  it('returns the same reference when nothing changed (no needless persist)', () => {
    const s = allEnabled()
    const avail: ProviderAvailability = { claude: true, codex: true, opencode: true }
    expect(applyAvailabilityToSettings(s, avail)).toBe(s)
  })

  it('never re-enables a provider that was disabled, even when detected (one-way)', () => {
    const s = allEnabled()
    s.claude.enabled = false // user-disabled
    const avail: ProviderAvailability = { claude: true, codex: true, opencode: true }
    const next = applyAvailabilityToSettings(s, avail)
    expect(next.claude.enabled).toBe(false) // still disabled — detection never turns it on
    expect(next).toBe(s) // no change → same reference
  })

  it('disables only the undetected kinds, leaving other config fields intact', () => {
    const s = allEnabled()
    s.codex.preset = 'deepseek'
    s.codex.apiKey = 'sk-secret'
    const avail: ProviderAvailability = { claude: true, codex: false, opencode: true }
    const next = applyAvailabilityToSettings(s, avail)
    expect(next.codex.enabled).toBe(false)
    expect(next.codex.preset).toBe('deepseek') // preserved
    expect(next.codex.apiKey).toBe('sk-secret') // preserved (no credential wipe)
  })
})
