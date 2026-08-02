import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IDLE_AGENT_SUSPENSION,
  MAX_IDLE_AGENT_SUSPENSION_TIMEOUT_MINUTES,
  MIN_IDLE_AGENT_SUSPENSION_TIMEOUT_MINUTES,
  normalizeIdleAgentSuspensionSettings,
  normalizeIdleAgentSuspensionTimeout,
} from './idleAgentSuspension'

describe('idle agent suspension settings', () => {
  it('uses disabled 30-minute defaults for missing or malformed values', () => {
    expect(normalizeIdleAgentSuspensionSettings(undefined)).toEqual(DEFAULT_IDLE_AGENT_SUSPENSION)
    expect(normalizeIdleAgentSuspensionSettings({ enabled: 'yes', timeoutMinutes: Infinity })).toEqual(DEFAULT_IDLE_AGENT_SUSPENSION)
  })

  it('clamps timeout to whole minutes in the safe range', () => {
    expect(normalizeIdleAgentSuspensionTimeout(-5)).toBe(MIN_IDLE_AGENT_SUSPENSION_TIMEOUT_MINUTES)
    expect(normalizeIdleAgentSuspensionTimeout(2.9)).toBe(2)
    expect(normalizeIdleAgentSuspensionTimeout(9_999)).toBe(MAX_IDLE_AGENT_SUSPENSION_TIMEOUT_MINUTES)
  })

  it('preserves a valid opt-in policy', () => {
    expect(normalizeIdleAgentSuspensionSettings({ enabled: true, timeoutMinutes: 45 })).toEqual({
      enabled: true,
      timeoutMinutes: 45,
    })
  })
})
