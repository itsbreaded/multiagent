import { describe, it, expect } from 'vitest'
import { offeredAgentKinds, isProviderOffered } from './providerOffering'
import { defaultAgentProviderSettings } from '../../../shared/agentProviderSettings'
import type { AgentKind, AgentProviderSettings, ProviderAvailability } from '../../../shared/types'

function settings(overrides: Partial<Record<AgentKind, { enabled: boolean }>>): AgentProviderSettings {
  const base = defaultAgentProviderSettings()
  if (overrides.claude) base.claude = { ...base.claude, ...overrides.claude }
  if (overrides.codex) base.codex = { ...base.codex, ...overrides.codex }
  if (overrides.opencode) base.opencode = { ...base.opencode, ...overrides.opencode }
  return base
}

const ALL: ProviderAvailability = { claude: true, codex: true, opencode: true }
const NONE: ProviderAvailability = { claude: false, codex: false, opencode: false }

describe('offeredAgentKinds (spec 055)', () => {
  it('offers a kind only when enabled AND detected', () => {
    const s = settings({ claude: { enabled: true }, codex: { enabled: false }, opencode: { enabled: true } })
    const avail: ProviderAvailability = { claude: true, codex: true, opencode: false }
    expect(offeredAgentKinds(s, avail)).toEqual(['claude'])
  })

  it('offers all three when all enabled and detected, in stable order', () => {
    const s = settings({ claude: { enabled: true }, codex: { enabled: true }, opencode: { enabled: true } })
    expect(offeredAgentKinds(s, ALL)).toEqual(['claude', 'codex', 'opencode'])
  })

  it('offers nothing when nothing is detected, even if enabled', () => {
    const s = settings({ claude: { enabled: true }, codex: { enabled: true }, opencode: { enabled: true } })
    expect(offeredAgentKinds(s, NONE)).toEqual([])
  })

  it('offers nothing when all are disabled, even if detected', () => {
    const s = defaultAgentProviderSettings()
    s.claude.enabled = false
    s.codex.enabled = false
    s.opencode.enabled = false
    expect(offeredAgentKinds(s, ALL)).toEqual([])
  })

  it('isProviderOffered matches the list membership', () => {
    const s = settings({ claude: { enabled: true }, codex: { enabled: false }, opencode: { enabled: true } })
    const avail: ProviderAvailability = { claude: true, codex: true, opencode: false }
    expect(isProviderOffered(s, avail, 'claude')).toBe(true)
    expect(isProviderOffered(s, avail, 'codex')).toBe(false) // disabled
    expect(isProviderOffered(s, avail, 'opencode')).toBe(false) // undetected
  })
})