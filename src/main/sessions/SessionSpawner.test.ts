import { describe, it, expect, vi } from 'vitest'
import type { PtyManager } from '../pty/PtyManager'
import type { CodexAppServerManager } from '../integration/codexAppServer'
import { SessionSpawner, newSessionCommand, resumeSessionCommand, agentEnv } from './SessionSpawner'

// Spec 047 phase 4: app-launched Codex links via the managed SessionStart hook, the same
// mechanism a CLI-launched Codex uses — the user accepts the managed hook once via
// `codex /hooks`, and the persisted trust covers every future launch. We deliberately do
// NOT pass --dangerously-bypass-hook-trust. App-launched Claude keeps --session-id and sets
// MULTIAGENT_SESSION_ID so the global Claude hook bails instead of re-reporting. These
// guard those invariants.

describe('SessionSpawner launch commands (spec 047 phase 4)', () => {
  it('app-launched Codex does NOT bypass hook trust on a new session', () => {
    expect(newSessionCommand('codex')).not.toContain('--dangerously-bypass-hook-trust')
  })

  it('app-launched Codex resume does NOT bypass hook trust', () => {
    const cmd = resumeSessionCommand('codex', 'abc-123', 'C:\\proj')
    expect(cmd).not.toContain('--dangerously-bypass-hook-trust')
    expect(cmd).toContain('resume')
  })

  it('app-launched Claude keeps --session-id on a new session', () => {
    const cmd = newSessionCommand('claude', '11111111-2222-3333-4444-555555555555')
    expect(cmd).toContain('--session-id')
    expect(cmd).not.toContain('--dangerously-bypass-hook-trust')
  })

  it('app-launched Claude resume uses --resume and no trust flag', () => {
    const cmd = resumeSessionCommand('claude', '11111111-2222-3333-4444-555555555555', 'C:\\proj')
    expect(cmd).not.toContain('--dangerously-bypass-hook-trust')
    expect(cmd).toContain('--resume')
  })

  it('keeps a prepared Codex observer on the direct CLI instead of --remote', async () => {
    const createDeferred = vi.fn((_cwd: string, _command: string[], ..._rest: unknown[]) => 'pty-1')
    const prepare = vi.fn(async () => ({ observerReady: true as const }))
    const ptyManager = { createDeferred } as unknown as PtyManager
    const codexAppServer = { prepare } as unknown as CodexAppServerManager
    const spawner = new SessionSpawner(ptyManager, { codexAppServer })

    await spawner.spawnNew('codex', process.cwd())

    const command = createDeferred.mock.calls[0]?.[1] as string[]
    expect(prepare).toHaveBeenCalled()
    expect(command.join(' ')).not.toContain('--remote')
    expect(command.join(' ')).toContain('codex')
  })
})

describe('agentEnv MULTIAGENT_SESSION_ID bail (spec 047 phase 4)', () => {
  it('sets MULTIAGENT_SESSION_ID on an app-launched Claude pane so the hook bails', () => {
    const env = agentEnv('claude', '11111111-2222-3333-4444-555555555555')
    expect(env['MULTIAGENT_SESSION_ID']).toBe('11111111-2222-3333-4444-555555555555')
  })

  it('does NOT set MULTIAGENT_SESSION_ID on an app-launched Codex pane (Codex relies on the hook)', () => {
    const env = agentEnv('codex')
    expect(env['MULTIAGENT_SESSION_ID']).toBeUndefined()
  })

  it('omits MULTIAGENT_SESSION_ID for Claude when no session id is known', () => {
    const env = agentEnv('claude')
    expect(env['MULTIAGENT_SESSION_ID']).toBeUndefined()
  })
})
