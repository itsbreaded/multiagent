import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import { AgentProcessSweeper } from './agentProcessSweeper'
import type { ProcessEntry } from './agentProcessDetect'

// Spec 047 phase 1c: the sweeper's transition/debounce logic. Driven with a controllable
// synthetic snapshot so we never spawn PowerShell. The two-observation debounce and the
// "only emit on transition" rule are the invariants under test.

function makeSweeper(snapshot: () => Promise<ProcessEntry[]>) {
  const pty = new EventEmitter()
  const sent: Array<{ ptyId: string; channel: string; args: unknown[] }> = []
  const sweeper = new AgentProcessSweeper({
    ptyManager: pty,
    sendToWindowForPty: (ptyId, channel, ...args) => {
      sent.push({ ptyId, channel, args })
      return true
    },
    snapshot,
  })
  return { pty, sweeper, sent }
}

describe('AgentProcessSweeper', () => {
  it('requires two consecutive observations before promoting', async () => {
    let snap: ProcessEntry[] = []
    const { pty, sweeper, sent } = makeSweeper(async () => snap)
    sweeper.trackShell('p1')
    pty.emit('ready', { id: 'p1', pid: 1000 })

    snap = [{ pid: 1000, parentPid: 0, name: 'powershell.exe', argv: ['powershell.exe'] }]
    await sweeper.tick()
    expect(sent).toHaveLength(0) // first observation — not yet confirmed

    snap = [
      { pid: 1000, parentPid: 0, name: 'powershell.exe', argv: ['powershell.exe'] },
      { pid: 1001, parentPid: 1000, name: 'claude.exe', argv: ['claude.exe'] },
    ]
    await sweeper.tick()
    expect(sent).toHaveLength(0) // changed from null→claude, only one observation of claude

    await sweeper.tick()
    expect(sent).toHaveLength(1) // second consecutive claude → promote
    expect(sent[0]).toMatchObject({ ptyId: 'p1', channel: 'pane:agent-detected' })
    expect(sent[0].args).toEqual(['p1', 'claude'])

    await sweeper.tick()
    expect(sent).toHaveLength(1) // still claude, no transition → no repeat emit
    sweeper.dispose()
  })

  it('requires two consecutive absences before demoting', async () => {
    const shell = [{ pid: 1000, parentPid: 0, name: 'powershell.exe', argv: ['powershell.exe'] }]
    const withClaude = [...shell, { pid: 1001, parentPid: 1000, name: 'claude.exe', argv: ['claude.exe'] }]
    let snap = withClaude
    const { pty, sweeper, sent } = makeSweeper(async () => snap)
    sweeper.trackShell('p1')
    pty.emit('ready', { id: 'p1', pid: 1000 })
    // promote
    await sweeper.tick()
    await sweeper.tick()
    expect(sent).toHaveLength(1)
    expect(sent[0].args).toEqual(['p1', 'claude'])

    // agent exits — first absence
    snap = shell
    await sweeper.tick()
    expect(sent).toHaveLength(1) // not yet demoted

    // second consecutive absence
    await sweeper.tick()
    expect(sent).toHaveLength(2)
    expect(sent[1].args).toEqual(['p1', null]) // demote
    sweeper.dispose()
  })

  it('does not flap on a one-tick transient (claude --version)', async () => {
    const shell = [{ pid: 1000, parentPid: 0, name: 'powershell.exe', argv: ['powershell.exe'] }]
    const withClaude = [...shell, { pid: 1001, parentPid: 1000, name: 'claude.exe', argv: ['claude.exe'] }]
    const snaps: ProcessEntry[][] = [withClaude, shell, shell, shell]
    let i = 0
    const { pty, sweeper, sent } = makeSweeper(async () => snaps[Math.min(i++, snaps.length - 1)])
    sweeper.trackShell('p1')
    pty.emit('ready', { id: 'p1', pid: 1000 })
    await sweeper.tick() // claude once → lastObserved=claude
    await sweeper.tick() // null → not consecutive, lastObserved=null, no emit
    await sweeper.tick() // null → consecutive null, but current emitted=null already → no emit
    expect(sent).toHaveLength(0) // never promoted, never demoted
    sweeper.dispose()
  })

  it('emits to the window that owns the pty (cross-window delivery path)', async () => {
    let snap: ProcessEntry[] = []
    const { pty, sweeper, sent } = makeSweeper(async () => snap)
    sweeper.trackShell('p9')
    pty.emit('ready', { id: 'p9', pid: 55 })
    snap = [
      { pid: 55, parentPid: 0, name: 'powershell.exe', argv: ['powershell.exe'] },
      { pid: 60, parentPid: 55, name: 'node.exe', argv: ['node.exe', 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'] },
    ]
    await sweeper.tick()
    await sweeper.tick()
    expect(sent[0].args).toEqual(['p9', 'codex'])
    sweeper.dispose()
  })

  it('untracks on pty exit and clears per-pane state', async () => {
    const { pty, sweeper, sent } = makeSweeper(async () => [])
    sweeper.trackShell('p1')
    pty.emit('ready', { id: 'p1', pid: 1000 })
    pty.emit('exit', 'p1')
    // No emit should ever occur for an exited pane.
    await sweeper.tick()
    expect(sent).toHaveLength(0)
    sweeper.dispose()
  })
})