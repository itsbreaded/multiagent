import { describe, it, expect } from 'vitest'
import {
  identifyAgentFromProcess,
  selectForegroundAgent,
  splitCommandLine,
  type ProcessEntry,
} from './agentProcessDetect'

// Spec 047 phase 1: pure agent identification from the process tree. These tests mirror
// the assertions in herdr's src/detect/mod.rs and src/platform/windows.rs on our data.
// Pin process.platform is not needed here — the module is platform-agnostic by design,
// but the real snapshot path is Windows-only (see processSnapshot.ts).

describe('identifyAgentFromProcess', () => {
  it('classifies a direct claude.exe / codex.exe', () => {
    expect(identifyAgentFromProcess('claude.exe', ['claude.exe'])).toBe('claude')
    expect(identifyAgentFromProcess('codex.exe', ['codex.exe'])).toBe('codex')
  })

  it('classifies claude-code and codex after suffix stripping', () => {
    expect(identifyAgentFromProcess('claude-code', ['claude-code'])).toBe('claude')
    expect(identifyAgentFromProcess('codex.cmd', ['codex.cmd'])).toBe('codex')
    expect(identifyAgentFromProcess('claude.bat', ['claude.bat'])).toBe('claude')
  })

  it('classifies node running the @openai/codex package path', () => {
    const argv = [
      'node.exe',
      'C:\\Users\\cdhan\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
    ]
    expect(identifyAgentFromProcess('node.exe', argv)).toBe('codex')
  })

  it('classifies node running the @anthropic-ai/claude-code package path', () => {
    const argv = [
      'node.exe',
      'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
    ]
    expect(identifyAgentFromProcess('node.exe', argv)).toBe('claude')
  })

  it('classifies cmd /c codex.cmd', () => {
    expect(identifyAgentFromProcess('cmd.exe', ['cmd.exe', '/c', 'codex.cmd'])).toBe('codex')
    expect(identifyAgentFromProcess('cmd.exe', ['cmd.exe', '/c', 'claude'])).toBe('claude')
  })

  it('classifies powershell -File claude.ps1', () => {
    expect(identifyAgentFromProcess('powershell.exe', ['powershell.exe', '-File', 'claude.ps1'])).toBe('claude')
  })

  it('does NOT classify python -c with an agent-named script body', () => {
    expect(identifyAgentFromProcess('python.exe', ['python.exe', '-c', 'import codex'])).toBeNull()
    expect(identifyAgentFromProcess('python.exe', ['python.exe', '-c', 'print("codex")', '/tmp/codex'])).toBeNull()
  })

  it('does NOT classify node -e with an agent name in the eval body', () => {
    expect(identifyAgentFromProcess('node.exe', ['node.exe', '-e', 'console.log("codex")'])).toBeNull()
    expect(identifyAgentFromProcess('node.exe', ['node.exe', '--eval', 'require("codex")'])).toBeNull()
  })

  it('returns null for plain shell commands', () => {
    expect(identifyAgentFromProcess('git.exe', ['git.exe', 'status'])).toBeNull()
    expect(identifyAgentFromProcess('vim.exe', ['vim.exe', 'README.md'])).toBeNull()
    expect(identifyAgentFromProcess('node.exe', ['node.exe', 'build.js'])).toBeNull()
    expect(identifyAgentFromProcess('python.exe', ['python.exe', 'scripts/train.py'])).toBeNull()
  })

  it('returns null for the plain shell itself (powershell / sh / cmd with no agent)', () => {
    expect(identifyAgentFromProcess('powershell.exe', ['powershell.exe', '-NoProfile'])).toBeNull()
    expect(identifyAgentFromProcess('bash', ['bash', '-l'])).toBeNull()
    expect(identifyAgentFromProcess('cmd.exe', ['cmd.exe', '/k'])).toBeNull()
  })

  it('classifies npx-wrapped agents', () => {
    expect(identifyAgentFromProcess('npx.exe', ['npx.exe', '@openai/codex'])).toBe('codex')
  })
})

describe('selectForegroundAgent', () => {
  const shell = 1000

  it('returns null when no agent descendant exists', () => {
    const entries: ProcessEntry[] = [
      { pid: shell, parentPid: 0, name: 'powershell.exe', argv: ['powershell.exe'] },
      { pid: 1001, parentPid: shell, name: 'git.exe', argv: ['git.exe', 'status'] },
    ]
    expect(selectForegroundAgent(shell, entries)).toBeNull()
  })

  it('returns null when shellPid is null or entries empty', () => {
    expect(selectForegroundAgent(null, [])).toBeNull()
    expect(selectForegroundAgent(shell, [])).toBeNull()
  })

  it('picks a single direct claude child', () => {
    const entries: ProcessEntry[] = [
      { pid: shell, parentPid: 0, name: 'powershell.exe', argv: ['powershell.exe'] },
      { pid: 1001, parentPid: shell, name: 'claude.exe', argv: ['claude.exe'] },
    ]
    expect(selectForegroundAgent(shell, entries)).toBe('claude')
  })

  it('picks a single codex chain (node wrapper) — topmost ancestor of the chain', () => {
    const entries: ProcessEntry[] = [
      { pid: shell, parentPid: 0, name: 'powershell.exe', argv: ['powershell.exe'] },
      { pid: 1001, parentPid: shell, name: 'cmd.exe', argv: ['cmd.exe', '/c', 'codex.cmd'] },
      { pid: 1002, parentPid: 1001, name: 'node.exe', argv: ['node.exe', 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'] },
    ]
    expect(selectForegroundAgent(shell, entries)).toBe('codex')
  })

  it('returns null for two distinct agents in one pane', () => {
    const entries: ProcessEntry[] = [
      { pid: shell, parentPid: 0, name: 'powershell.exe', argv: ['powershell.exe'] },
      { pid: 1001, parentPid: shell, name: 'claude.exe', argv: ['claude.exe'] },
      { pid: 1002, parentPid: shell, name: 'node.exe', argv: ['node.exe', 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'] },
    ]
    expect(selectForegroundAgent(shell, entries)).toBeNull()
  })

  it('returns null for same-agent siblings (two claude processes)', () => {
    const entries: ProcessEntry[] = [
      { pid: shell, parentPid: 0, name: 'powershell.exe', argv: ['powershell.exe'] },
      { pid: 1001, parentPid: shell, name: 'claude.exe', argv: ['claude.exe'] },
      { pid: 1002, parentPid: shell, name: 'claude.exe', argv: ['claude.exe', '--resume', 'abc'] },
    ]
    expect(selectForegroundAgent(shell, entries)).toBeNull()
  })

  it('does not treat the shell pid itself as a candidate', () => {
    // The shell is named powershell, which is a wrapper — but it is the root, not a
    // descendant, so it must never classify even if its argv happened to mention an agent.
    const entries: ProcessEntry[] = [
      { pid: shell, parentPid: 0, name: 'powershell.exe', argv: ['powershell.exe', '-c', 'codex'] },
    ]
    expect(selectForegroundAgent(shell, entries)).toBeNull()
  })

  it('is cycle-safe: a self-referential parentPid does not loop', () => {
    // A real parent cycle cannot form (one parentPid each), but a malformed snapshot
    // could list a process as its own parent. The visited set must terminate the walk.
    const entries: ProcessEntry[] = [
      { pid: shell, parentPid: 0, name: 'powershell.exe', argv: ['powershell.exe'] },
      { pid: 1001, parentPid: shell, name: 'claude.exe', argv: ['claude.exe'] },
      { pid: 1002, parentPid: 1002, name: 'stuck.exe', argv: ['stuck.exe'] },
    ]
    expect(selectForegroundAgent(shell, entries)).toBe('claude')
  })
})

describe('splitCommandLine', () => {
  it('splits a simple Windows command line honoring quotes', () => {
    expect(splitCommandLine('node.exe "C:\\path with space\\codex.js" --foo')).toEqual([
      'node.exe',
      'C:\\path with space\\codex.js',
      '--foo',
    ])
  })
})