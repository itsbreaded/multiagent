import { describe, expect, it } from 'vitest'
import { normalizeAgentEventMeta, normalizeAgentWorkSnapshot } from './agentStatusEvidence'

describe('agent status evidence normalization', () => {
  const base = {
    provider: 'claude' as const,
    completeness: 'complete' as const,
    terminalState: 'completed' as const,
    activeCount: 0,
    scheduledCount: 0,
    sessionId: 'session-1',
    turnId: 'turn-1',
  }

  it('accepts a bounded empty authoritative snapshot', () => {
    expect(normalizeAgentWorkSnapshot(base)).toEqual(base)
  })

  it('rejects identity/count/duplicate-id mismatches', () => {
    expect(normalizeAgentWorkSnapshot({ ...base, activeCount: 1, activeIds: [] })).toBeUndefined()
    expect(normalizeAgentWorkSnapshot({ ...base, activeCount: 2, activeIds: ['a', 'a'] })).toBeUndefined()
    expect(normalizeAgentEventMeta({ sessionId: 'session-1', evidence: { ...base, sessionId: 'session-2' } })).toBeUndefined()
  })

  it('preserves incomplete active work as valid protective evidence', () => {
    expect(normalizeAgentWorkSnapshot({
      ...base,
      completeness: 'incomplete',
      terminalState: 'busy',
      activeCount: 1,
    })).toMatchObject({ completeness: 'incomplete', activeCount: 1 })
  })

  it('rejects oversized work and identity lists', () => {
    expect(normalizeAgentWorkSnapshot({ ...base, activeCount: 65 })).toBeUndefined()
    expect(normalizeAgentWorkSnapshot({ ...base, sessionId: 'x'.repeat(257) })).toBeUndefined()
  })
})
