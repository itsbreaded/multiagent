import { describe, it, expect } from 'vitest'
import type { AgentProviderSettings } from './types'
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

    // preset maps + custom arrays absent (the source did not have them).
    expect(result.claudePresets).toBeUndefined()
    expect(result.codexPresets).toBeUndefined()
    expect(result.claudeCustomProviders).toBeUndefined()
    expect(result.codexCustomProviders).toBeUndefined()
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

  it('accepts ollama and zai as valid built-in Claude presets', () => {
    const result = sanitizeAgentProviderSettings({
      claude: { enabled: true, preset: 'ollama', baseUrl: 'http://localhost:11434', model: 'glm-5.2:cloud' },
    })
    expect(result.claude.preset).toBe('ollama')
    expect(result.claude.baseUrl).toBe('http://localhost:11434')

    const zai = sanitizeAgentProviderSettings({
      claude: { enabled: true, preset: 'zai', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-5.2' },
    })
    expect(zai.claude.preset).toBe('zai')
  })

  it('accepts a built-in name and rejects garbage / bare "custom" to native', () => {
    // built-in
    expect(sanitizeAgentProviderSettings({ claude: { preset: 'deepseek' } }).claude.preset).toBe('deepseek')
    // bare "custom" (legacy marker) is NOT a valid active preset → native
    expect(sanitizeAgentProviderSettings({ claude: { preset: 'custom' } }).claude.preset).toBe('native')
    // garbage
    expect(sanitizeAgentProviderSettings({ claude: { preset: 'wat' } }).claude.preset).toBe('native')
    // malformed custom (no id after the colon) → native
    expect(sanitizeAgentProviderSettings({ claude: { preset: 'custom:' } }).claude.preset).toBe('native')
    // a custom:<id> is accepted by the validator (survives when its provider exists —
    // covered by "keeps the active custom:<id>")
    const withProvider = sanitizeAgentProviderSettings({
      claude: { preset: 'custom:abc', extraEnvVars: [] },
      claudeCustomProviders: [{ id: 'custom:abc', name: 'A', config: { preset: 'custom:abc', extraEnvVars: [] } }],
    })
    expect(withProvider.claude.preset).toBe('custom:abc')
  })

  it('sanitizes custom-provider arrays: drops bad ids, de-dupes by id (last wins)', () => {
    const result = sanitizeAgentProviderSettings({
      claudeCustomProviders: [
        { id: 'custom:a', name: 'A', config: { enabled: true, preset: 'custom:a', baseUrl: 'http://a', extraEnvVars: [] } },
        { id: 'not-custom', name: 'Bad', config: { preset: 'x' } }, // bad id → dropped
        { id: 'custom:b', name: ' ', config: { preset: 'custom:b' } }, // blank name → dropped
        { id: 'custom:a', name: 'A2', config: { enabled: false, preset: 'custom:a', baseUrl: 'http://a2', extraEnvVars: [] } }, // dup id → last wins
      ],
    })
    const customs = result.claudeCustomProviders ?? []
    expect(customs).toHaveLength(1)
    expect(customs[0].id).toBe('custom:a')
    expect(customs[0].name).toBe('A2')
    expect(customs[0].config.baseUrl).toBe('http://a2')
    // stored config preset is forced self-referential
    expect(customs[0].config.preset).toBe('custom:a')
  })

  it('drops a custom entry whose config preset was hand-edited away and re-pins it', () => {
    const result = sanitizeAgentProviderSettings({
      claudeCustomProviders: [
        { id: 'custom:a', name: 'A', config: { preset: 'native', baseUrl: 'http://a', extraEnvVars: [] } },
      ],
    })
    expect(result.claudeCustomProviders?.[0].config.preset).toBe('custom:a')
    expect(result.claudeCustomProviders?.[0].config.baseUrl).toBe('http://a')
  })

  it('resets a dangling active custom:<id> to native instead of spawning a misconfigured pane', () => {
    const result = sanitizeAgentProviderSettings({
      claude: { enabled: true, preset: 'custom:ghost', baseUrl: 'http://x', extraEnvVars: [] },
      // no matching custom provider in the array
    })
    expect(result.claude.preset).toBe('native')
    expect(result.claude.enabled).toBe(false)
    expect(result.claude.baseUrl).toBe('')
  })

  it('keeps the active custom:<id> when its provider still exists', () => {
    const result = sanitizeAgentProviderSettings({
      claude: { enabled: true, preset: 'custom:a', baseUrl: 'http://x', extraEnvVars: [] },
      claudeCustomProviders: [
        { id: 'custom:a', name: 'A', config: { preset: 'custom:a', baseUrl: 'http://a', extraEnvVars: [] } },
      ],
    })
    expect(result.claude.preset).toBe('custom:a')
  })

  it('migrates a legacy single-custom slot to a custom:legacy provider and rewires active', () => {
    const result = sanitizeAgentProviderSettings({
      claude: { enabled: true, preset: 'custom', extraEnvVars: [] },
      claudePresets: {
        custom: { preset: 'custom', baseUrl: 'http://gw', model: 'm', authToken: 'tok', extraEnvVars: [] },
        deepseek: { preset: 'deepseek', baseUrl: 'https://deep', extraEnvVars: [] },
      },
    })
    // legacy `custom` key gone from the built-in map
    expect(Object.keys(result.claudePresets ?? {}).sort()).toEqual(['deepseek'])
    // lifted into a named custom provider
    expect(result.claudeCustomProviders).toEqual([
      { id: 'custom:legacy', name: 'Custom', config: expect.objectContaining({ preset: 'custom:legacy', baseUrl: 'http://gw', model: 'm', authToken: 'tok' }) },
    ])
    // active preset rewired from 'custom' to 'custom:legacy'
    expect(result.claude.preset).toBe('custom:legacy')
  })

  it('migration is idempotent and stable across launches (deterministic id)', () => {
    const legacy = {
      claude: { enabled: true, preset: 'custom', extraEnvVars: [] },
      claudePresets: { custom: { preset: 'custom', baseUrl: 'http://gw', extraEnvVars: [] } },
    }
    const once = sanitizeAgentProviderSettings(legacy)
    // Re-running on the migrated shape must not stack duplicate customs or dangle.
    const twice = sanitizeAgentProviderSettings(once)
    expect(twice.claudeCustomProviders).toEqual(once.claudeCustomProviders)
    expect(twice.claude.preset).toBe('custom:legacy')
  })

  it('drops an empty legacy custom draft silently (no provider created)', () => {
    const result = sanitizeAgentProviderSettings({
      claudePresets: { custom: { preset: 'custom', extraEnvVars: [] } },
    })
    expect(result.claudeCustomProviders).toBeUndefined()
    expect((result.claudePresets as Record<string, unknown> | undefined)?.custom).toBeUndefined()
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
        preset: 'native',
        providerName: '',
        model: '',
        baseUrl: '',
        envKey: '',
        apiKey: '',
        wireApi: 'responses',
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
        // `custom` is no longer a built-in; a body-less legacy slot is dropped silently
        custom: { preset: 'custom', wireApi: 'soap' },
        'alibaba-token': { preset: 'alibaba-token', wireApi: 'soap' }, // bad wireApi coerced
      },
    })
    expect(Object.keys(result.claudePresets ?? {})).toEqual(['deepseek'])
    expect(result.claudePresets?.deepseek?.enabled).toBe(true)
    expect(Object.keys(result.codexPresets ?? {}).sort()).toEqual(['alibaba-token'])
    expect(result.codexPresets?.['alibaba-token']?.wireApi).toBe('responses')
  })
})
