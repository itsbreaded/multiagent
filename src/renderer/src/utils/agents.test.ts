import { describe, it, expect } from 'vitest'
import { agentLabel, agentAccent } from './agents'
import { ui } from '../styles/theme'

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
    expect(agentAccent('claude')).toBe(ui.color.providerClaudeAccent)
  })

  it('returns the codex accent', () => {
    expect(agentAccent('codex')).toBe(ui.color.providerCodexAccent)
  })

  it('returns the OpenCode identity accent', () => {
    expect(agentAccent('opencode')).toBe(ui.color.providerOpenCodeAccent)
  })
})
