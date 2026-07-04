import { describe, it, expect } from 'vitest'
import type { AgentProviderSettings } from '../../shared/types'
import {
  defaultAgentProviderSettings,
  sanitizeAgentProviderSettings,
} from './agentProviderSettings'

describe('sanitizeAgentProviderSettings', () => {
  it('returns exact defaults for non-object inputs', () => {
    const defaults = defaultAgentProviderSettings()
    for (const bad of [null, undefined, 42, 'x', [], true]) {
      expect(sanitizeAgentProviderSettings(bad)).toEqual(defaults)
    }
  })

  it('fills defaults for a partial file and keeps valid fields', () => {
    const result = sanitizeAgentProviderSettings({ claude: { enabled: true } })
    expect(result.claude.enabled).toBe(true)
    expect(result.claude.preset).toBe('native')
    expect(result.claude.model).toBe('')
    expect(Array.isArray(result.claude.extraEnvVars)).toBe(true)

    // codex fully defaulted — these are the spawn-crash vectors.
    expect(typeof result.codex.envKey).toBe('string')
    expect(result.codex.preset).toBe('native')
    expect(result.codex.wireApi).toBe('responses')
    expect(Array.isArray(result.codex.extraEnvVars)).toBe(true)

    // preset maps absent (the source did not have them).
    expect(result.claudePresets).toBeUndefined()
    expect(result.codexPresets).toBeUndefined()
  })

  it('drops wrong-typed and unknown-union fields, replacing with defaults', () => {
    const result = sanitizeAgentProviderSettings({
      codex: {
        envKey: 123,
        extraEnvVars: 'nope',
        preset: 'bogus',
        wireApi: 'soap',
        enabled: 'yes',
      },
    })
    expect(result.codex.envKey).toBe('')
    expect(result.codex.extraEnvVars).toEqual([])
    expect(result.codex.preset).toBe('native')
    expect(result.codex.wireApi).toBe('responses')
    expect(result.codex.enabled).toBe(false)
  })

  it('keeps only valid extraEnvVars entries', () => {
    const result = sanitizeAgentProviderSettings({
      claude: {
        extraEnvVars: [
          { id: '1', key: 'K', value: 'V', enabled: true },
          { id: '2', key: 'K', value: 'V' }, // missing enabled
          { id: 3, key: 'K', value: 'V', enabled: true }, // non-string id
          null,
          { id: '4', key: 'K', value: 1, enabled: true }, // non-string value
        ],
      },
    })
    expect(result.claude.extraEnvVars).toEqual([
      { id: '1', key: 'K', value: 'V', enabled: true },
    ])
  })

  it('passes a fully-valid object through unchanged (idempotent)', () => {
    const valid: AgentProviderSettings = {
      claude: {
        enabled: true,
        preset: 'deepseek',
        baseUrl: 'https://x',
        authToken: 'tok',
        model: 'm',
        opusModel: 'o',
        sonnetModel: 's',
        haikuModel: 'h',
        subagentModel: 'su',
        effortLevel: 'high',
        extraEnvVars: [{ id: '1', key: 'K', value: 'V', enabled: false }],
      },
      codex: {
        enabled: false,
        preset: 'custom',
        providerName: 'prov',
        model: 'cm',
        baseUrl: 'https://c',
        envKey: 'KEY',
        apiKey: 'ak',
        wireApi: 'chat',
        extraEnvVars: [],
      },
    }
    expect(sanitizeAgentProviderSettings(valid)).toEqual(valid)
  })

  it('drops invalid preset-map keys/values and keeps valid ones', () => {
    const result = sanitizeAgentProviderSettings({
      claudePresets: {
        deepseek: { enabled: true, preset: 'deepseek' },
        bogus: { enabled: true }, // unknown key — dropped
      },
      codexPresets: {
        custom: { preset: 'custom', wireApi: 'soap' }, // known key, bad wireApi coerced
      },
    })
    expect(Object.keys(result.claudePresets ?? {})).toEqual(['deepseek'])
    expect(result.claudePresets?.deepseek?.enabled).toBe(true)
    expect(Object.keys(result.codexPresets ?? {})).toEqual(['custom'])
    expect(result.codexPresets?.custom?.wireApi).toBe('responses')
  })
})
