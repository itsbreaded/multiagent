import { describe, it, expect } from 'vitest'
import { toEntries } from './processSnapshot'

// Spec 047 phase 1b: the JSON→ProcessEntry mapping is the only non-trivial logic in the
// snapshot seam (the rest is a powershell shell-out that fails closed). Test the parser
// directly so we don't need to spawn PowerShell in unit tests.

describe('processSnapshot.toEntries', () => {
  it('parses a single-object CIM response into one entry', () => {
    const entries = toEntries([
      { ProcessId: 123, ParentProcessId: 100, Name: 'claude.exe', CommandLine: '"C:\\x\\claude.exe" --resume abc' },
    ])
    expect(entries).toEqual([
      { pid: 123, parentPid: 100, name: 'claude.exe', argv: ['C:\\x\\claude.exe', '--resume', 'abc'] },
    ])
  })

  it('parses an array of records', () => {
    const entries = toEntries([
      { ProcessId: 1, ParentProcessId: 0, Name: 'powershell.exe', CommandLine: 'powershell.exe -NoProfile' },
      { ProcessId: 2, ParentProcessId: 1, Name: 'node.exe', CommandLine: 'node.exe "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"' },
    ])
    expect(entries).toHaveLength(2)
    expect(entries[1].parentPid).toBe(1)
    expect(entries[1].argv[1]).toBe('C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js')
  })

  it('falls back to Name when CommandLine is null', () => {
    const entries = toEntries([{ ProcessId: 9, ParentProcessId: 1, Name: 'git.exe', CommandLine: null }])
    expect(entries[0].argv).toEqual(['git.exe'])
    expect(entries[0].name).toBe('git.exe')
  })

  it('skips records missing pid/ppid', () => {
    const entries = toEntries([
      { ProcessId: 5, ParentProcessId: 1, Name: 'ok.exe', CommandLine: 'ok.exe' },
      { ProcessId: 6, ParentProcessId: null, Name: 'bad.exe', CommandLine: 'bad.exe' },
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0].pid).toBe(5)
  })
})