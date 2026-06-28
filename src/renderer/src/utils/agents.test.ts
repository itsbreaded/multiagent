import { describe, it, expect } from 'vitest'
import { agentLabel, agentAccent } from './agents'

describe('agentLabel', () => {
  it('labels claude', () => {
    expect(agentLabel('claude')).toBe('Claude')
  })

  it('labels codex', () => {
    expect(agentLabel('codex')).toBe('Codex')
  })
})

describe('agentAccent', () => {
  it('returns the claude accent', () => {
    expect(agentAccent('claude')).toBe('#4ade80')
  })

  it('returns the codex accent', () => {
    expect(agentAccent('codex')).toBe('#60a5fa')
  })
})
