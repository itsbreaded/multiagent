import { describe, expect, it } from 'vitest'
import {
  CLAUDE_PRESET_DEFAULTS,
  CODEX_PRESET_DEFAULTS,
  draftMatchesDefaults,
} from './AgentProvidersSection'

// Spec 049: a built-in preset's "Reset to defaults" spreads the preset's defaults
// over the active draft. That is only safe to expose as a one-click action if the
// defaults maps can never carry a credential key — otherwise reset would silently
// wipe the user's authToken (Claude) / apiKey (Codex). These tests pin that
// invariant and the reset/compare mechanics.

const CLAUDE_BUILTINS = ['native', 'deepseek', 'alibaba', 'ollama', 'zai'] as const
const CODEX_BUILTINS = ['native', 'alibaba-token', 'alibaba-payg', 'ollama', 'zai'] as const

describe('preset defaults never include credential keys (reset safety)', () => {
  it.each(CLAUDE_BUILTINS)('Claude %s defaults omit authToken', (preset) => {
    expect(CLAUDE_PRESET_DEFAULTS[preset]).not.toHaveProperty('authToken')
  })
  it.each(CODEX_BUILTINS)('Codex %s defaults omit apiKey', (preset) => {
    expect(CODEX_PRESET_DEFAULTS[preset]).not.toHaveProperty('apiKey')
  })
})

describe('reset spread restores routing fields, preserves credentials', () => {
  it('Claude: baseUrl/model restore, authToken + extraEnvVars survive', () => {
    const draft = {
      ...CLAUDE_PRESET_DEFAULTS.alibaba,
      preset: 'alibaba',
      enabled: true,
      authToken: 'sk-secret',
      extraEnvVars: [{ id: 'x', key: 'FOO', value: 'bar', enabled: true }],
      baseUrl: '',           // wiped by the user
      model: 'wrong-model',  // edited
    } as any
    const reset = { ...draft, ...CLAUDE_PRESET_DEFAULTS.alibaba }
    expect(reset.baseUrl).toBe('https://dashscope-intl.aliyuncs.com/apps/anthropic')
    expect(reset.model).toBe('qwen3.5-plus')
    expect(reset.authToken).toBe('sk-secret')        // preserved
    expect(reset.extraEnvVars).toHaveLength(1)        // preserved
    expect(reset.enabled).toBe(true)                  // preserved
  })

  it('Codex: baseUrl/model/providerName/envKey/wireApi restore, apiKey survives', () => {
    const draft = {
      ...CODEX_PRESET_DEFAULTS['alibaba-token'],
      preset: 'alibaba-token',
      enabled: true,
      apiKey: 'sk-secret',
      extraEnvVars: [],
      baseUrl: '',
      model: 'wrong',
    } as any
    const reset = { ...draft, ...CODEX_PRESET_DEFAULTS['alibaba-token'] }
    expect(reset.baseUrl).toBe('https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1')
    expect(reset.model).toBe('qwen3.6-plus')
    expect(reset.providerName).toBe('alibaba_token')
    expect(reset.envKey).toBe('OPENAI_API_KEY')
    expect(reset.wireApi).toBe('responses')
    expect(reset.apiKey).toBe('sk-secret')            // preserved
  })
})

describe('draftMatchesDefaults drives the disabled state', () => {
  it('true when every defaulted field matches', () => {
    expect(draftMatchesDefaults({ ...CLAUDE_PRESET_DEFAULTS.alibaba }, CLAUDE_PRESET_DEFAULTS.alibaba)).toBe(true)
  })
  it('false when any defaulted field was edited', () => {
    expect(draftMatchesDefaults({ ...CLAUDE_PRESET_DEFAULTS.alibaba, model: 'edited' }, CLAUDE_PRESET_DEFAULTS.alibaba)).toBe(false)
  })
  it('ignores non-defaulted fields (authToken does not affect the comparison)', () => {
    expect(draftMatchesDefaults({ ...CLAUDE_PRESET_DEFAULTS.alibaba, authToken: 'sk-x' }, CLAUDE_PRESET_DEFAULTS.alibaba)).toBe(true)
  })
  // Regression for the Providers-tab freeze: a stale legacy preset value (e.g.
  // `"custom"` from pre-048 localStorage) is not a key in the defaults map, so the
  // reset comparison used to receive `undefined` and throw during render. It must
  // return false instead.
  it('returns false (does not throw) when defaults is undefined', () => {
    expect(() => draftMatchesDefaults({ preset: 'custom' }, undefined)).not.toThrow()
    expect(draftMatchesDefaults({ preset: 'custom' }, undefined)).toBe(false)
  })
})
