import { describe, it, expect } from 'vitest'
import { toEntries, parsePsDarwin, parseProcStat, parseProcCmdline } from './processSnapshot'
import { selectForegroundAgent, identifyAgentFromProcess } from './agentProcessDetect'

// Spec 047 phase 1b: the platform snapshots' pure parsers are the only non-trivial logic in
// the snapshot seam (the rest is a shell-out / /proc read that fails closed). Test the
// parsers directly so we don't need to spawn `ps` or read `/proc` in unit tests, then assert
// the resulting entries classify correctly through the shared platform-agnostic selector.

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

describe('processSnapshot.parsePsDarwin', () => {
  it('parses pid/ppid/comm and the full command line', () => {
    const stdout = [
      '   1     0 launchd            /sbin/launchd',
      ' 123   100 claude             claude --resume abc',
      ' 456   123 node               node /usr/local/lib/node_modules/@openai/codex/bin/codex.js',
    ].join('\n')
    const entries = parsePsDarwin(stdout)
    expect(entries).toHaveLength(3)
    expect(entries[1]).toEqual({
      pid: 123,
      parentPid: 100,
      name: 'claude',
      argv: ['claude', '--resume', 'abc'],
    })
    expect(entries[2].parentPid).toBe(123)
    expect(entries[2].argv[1]).toBe('/usr/local/lib/node_modules/@openai/codex/bin/codex.js')
  })

  it('falls back to comm as argv when there is no command tail', () => {
    const entries = parsePsDarwin(' 789   100 git\n')
    expect(entries).toEqual([{ pid: 789, parentPid: 100, name: 'git', argv: ['git'] }])
  })

  it('skips blank / unparseable lines', () => {
    const entries = parsePsDarwin('\n  not a line  \n 123 100 claude claude\n')
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('claude')
  })

  it('classifies a direct claude and a node-wrapped codex through the selector', () => {
    const stdout = [
      ' 100     1 bash               bash',
      ' 123   100 claude             claude',
      ' 200   100 node               node /usr/local/lib/node_modules/@openai/codex/bin/codex.js',
      ' 300   100 git                git status',
    ].join('\n')
    const entries = parsePsDarwin(stdout)
    // Full tree has both claude AND codex as descendants of the shell → ambiguous.
    expect(selectForegroundAgent(100, entries)).toBeNull()
    // A shell whose only agent descendant is claude → claude.
    expect(selectForegroundAgent(100, [entries[0], entries[1], entries[3]])).toBe('claude')
    // A shell whose only agent descendant is the node-wrapped codex → codex.
    expect(selectForegroundAgent(100, [entries[0], entries[2], entries[3]])).toBe('codex')
    // git is not an agent.
    expect(identifyAgentFromProcess('git', ['git', 'status'])).toBeNull()
  })
})

describe('processSnapshot.parseProcStat', () => {
  it('parses pid, comm, and ppid', () => {
    // comm with no spaces, classic shape.
    const stat = '1234 (claude) S 100 100 100 0 -1 ...'
    expect(parseProcStat(stat)).toEqual({ pid: 1234, comm: 'claude', ppid: 100 })
  })

  it('handles a comm that contains a space', () => {
    // A program whose 15-char comm contains a space (e.g. "my agent"). The first ( ... last )
    // parse must keep the whole comm.
    const stat = '55 (my agent) S 7 7 7 0 -1 ...'
    expect(parseProcStat(stat)).toEqual({ pid: 55, comm: 'my agent', ppid: 7 })
  })

  it('returns null for malformed stat (no parens / non-numeric pid)', () => {
    expect(parseProcStat('notastat')).toBeNull()
    expect(parseProcStat('abc (comm) S 1')).toBeNull()
  })
})

describe('processSnapshot.parseProcCmdline', () => {
  it('splits a null-delimited argv', () => {
    const buf = Buffer.from('claude\0--resume\0abc\0', 'utf8')
    expect(parseProcCmdline(buf)).toEqual(['claude', '--resume', 'abc'])
  })

  it('returns [] for an empty buffer (kernel thread)', () => {
    expect(parseProcCmdline(Buffer.alloc(0))).toEqual([])
  })

  it('drops trailing empty tokens from a trailing NUL run', () => {
    const buf = Buffer.from('node\0\0\0', 'utf8')
    expect(parseProcCmdline(buf)).toEqual(['node'])
  })
})

describe('processSnapshot /proc → selector integration', () => {
  it('classifies a direct claude and a node-wrapped codex from parsed /proc entries', () => {
    const entries = [
      { pid: 100, parentPid: 1, name: 'bash', argv: ['/bin/bash'] },
      { pid: 123, parentPid: 100, name: 'claude', argv: ['/home/u/.local/bin/claude'] },
      {
        pid: 200,
        parentPid: 100,
        name: 'node',
        argv: ['node', '/usr/lib/node_modules/@openai/codex/bin/codex.js'],
      },
    ]
    expect(selectForegroundAgent(100, entries)).toBeNull() // two distinct agents → ambiguous
    expect(selectForegroundAgent(100, [entries[0], entries[1]])).toBe('claude')
    expect(selectForegroundAgent(100, [entries[0], entries[2]])).toBe('codex')
  })
})