import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentKind, Session, SessionRepairCwdResult } from '../../../shared/types'
import { installMockIpc, type MockIpc } from '../../../../tests/mockIpc'
import { useSessionsStore } from './sessions'

let ipc: MockIpc

beforeEach(() => {
  ipc = installMockIpc()
})

function session(
  sessionId: string,
  overrides: Partial<Session> = {},
  agentKind: AgentKind = 'claude'
): Session {
  return {
    agentKind,
    sessionId,
    cwd: `C:\\projects\\${sessionId}`,
    cwdExists: true,
    projectName: `projects/${sessionId}`,
    displayName: null,
    gitBranch: null,
    firstMessage: null,
    lastMessage: null,
    firstActivity: null,
    lastActivity: null,
    messageCount: 0,
    transcriptPath: `${sessionId}.jsonl`,
    status: 'resumable',
    ...overrides,
  }
}

describe('useSessionsStore - loading and project selection', () => {
  it('setSessions replaces the collection and finishes loading', () => {
    const sessions = [session('one'), session('two')]

    useSessionsStore.getState().setSessions(sessions)

    expect(useSessionsStore.getState().sessions).toEqual(sessions)
    expect(useSessionsStore.getState().loading).toBe(false)
  })

  it('getByProject uses an exact cwd match', () => {
    useSessionsStore.getState().setSessions([
      session('one', { cwd: 'C:\\work\\app' }),
      session('two', { cwd: 'C:\\work\\app' }, 'codex'),
      session('three', { cwd: 'C:\\work\\APP' }),
    ])

    expect(useSessionsStore.getState().getByProject('C:\\work\\app').map((item) => item.sessionId)).toEqual([
      'one',
      'two',
    ])
  })
})

describe('useSessionsStore - search', () => {
  it('returns IPC search results when the host search succeeds', async () => {
    const remote = [session('remote')]
    ipc.invoke.mockResolvedValue(remote)

    await expect(useSessionsStore.getState().searchSessions('needle')).resolves.toEqual(remote)
    expect(ipc.invoke).toHaveBeenCalledWith('sessions:search', 'needle')
  })

  it('falls back to a case-insensitive local project/message search when IPC fails', async () => {
    useSessionsStore.getState().setSessions([
      session('project', { projectName: 'Acme/Console' }),
      session('first', { firstMessage: 'Investigate NEEDLE handling' }),
      session('last', { lastMessage: 'needle fixed' }),
      session('miss', { projectName: 'unrelated', firstMessage: 'nothing here' }),
    ])
    ipc.invoke.mockRejectedValue(new Error('host unavailable'))

    const results = await useSessionsStore.getState().searchSessions('Needle')

    expect(results.map((item) => item.sessionId)).toEqual(['first', 'last'])
  })
})

describe('useSessionsStore - mutation reconciliation', () => {
  it('deleteSession invokes the host and removes only the matching agent/session pair', async () => {
    useSessionsStore.getState().setSessions([
      session('shared'),
      session('shared', {}, 'codex'),
      session('other'),
    ])

    await useSessionsStore.getState().deleteSession('claude', 'shared')

    expect(ipc.invoke).toHaveBeenCalledWith('sessions:delete', 'claude', 'shared')
    expect(useSessionsStore.getState().sessions.map((item) => `${item.agentKind}:${item.sessionId}`)).toEqual([
      'codex:shared',
      'claude:other',
    ])
  })

  it('repairSessionCwd replaces returned sessions by composite identity and preserves the rest', async () => {
    const claudeBefore = session('shared', { cwd: 'C:\\old', projectName: 'old' })
    const codexBefore = session('shared', { cwd: 'C:\\old', projectName: 'old' }, 'codex')
    const untouched = session('other', { cwd: 'C:\\elsewhere' })
    useSessionsStore.getState().setSessions([claudeBefore, codexBefore, untouched])

    const repaired = session('shared', { cwd: 'D:\\new', projectName: 'new' })
    const result: SessionRepairCwdResult = {
      ok: true,
      sessions: [repaired],
      mapping: { oldCwd: 'C:\\old', newCwd: 'D:\\new' },
    }
    ipc.invoke.mockResolvedValue(result)

    await expect(useSessionsStore.getState().repairSessionCwd('C:\\old', 'D:\\new')).resolves.toEqual(result)

    expect(ipc.invoke).toHaveBeenCalledWith('sessions:repair-cwd', 'C:\\old', 'D:\\new')
    const after = useSessionsStore.getState().sessions
    expect(after[0]).toEqual(repaired)
    expect(after[1]).toEqual(codexBefore)
    expect(after[2]).toEqual(untouched)
  })

  it('leaves local sessions unchanged when repair returns no updated sessions', async () => {
    const existing = session('one')
    useSessionsStore.getState().setSessions([existing])
    const result: SessionRepairCwdResult = { ok: false, sessions: [], error: 'not found' }
    ipc.invoke.mockResolvedValue(result)

    await useSessionsStore.getState().repairSessionCwd('C:\\old', 'D:\\new')

    expect(useSessionsStore.getState().sessions).toEqual([existing])
  })
})
