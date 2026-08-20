import { describe, expect, it, vi } from 'vitest'
import { forwardAgentEvent } from './agentEventForwarder'

describe('forwardAgentEvent', () => {
  it('keeps session, turn, and evidence together across the main boundary', () => {
    const target = vi.fn()
    const evidence = { provider: 'codex' as const, completeness: 'incomplete' as const, terminalState: 'interrupted' as const, activeCount: 1, scheduledCount: 0, sessionId: 's', turnId: 't' }
    forwardAgentEvent({ ptyId: 'p', agentKind: 'codex', event: 'work_snapshot', sessionId: 's', turnId: 't', evidence }, target)
    expect(target).toHaveBeenCalledWith('p', 'work_snapshot', undefined, 't', undefined, { sessionId: 's', evidence })
  })
})
