import type { IdleAgentSuspensionSettings } from './types'

export const DEFAULT_IDLE_AGENT_SUSPENSION_ENABLED = true
export const DEFAULT_IDLE_AGENT_SUSPENSION_TIMEOUT_MINUTES = 10
export const MIN_IDLE_AGENT_SUSPENSION_TIMEOUT_MINUTES = 1
export const MAX_IDLE_AGENT_SUSPENSION_TIMEOUT_MINUTES = 1_440

export const DEFAULT_IDLE_AGENT_SUSPENSION: IdleAgentSuspensionSettings = {
  enabled: DEFAULT_IDLE_AGENT_SUSPENSION_ENABLED,
  timeoutMinutes: DEFAULT_IDLE_AGENT_SUSPENSION_TIMEOUT_MINUTES,
}

export function normalizeIdleAgentSuspensionTimeout(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_IDLE_AGENT_SUSPENSION_TIMEOUT_MINUTES
  return Math.min(
    MAX_IDLE_AGENT_SUSPENSION_TIMEOUT_MINUTES,
    Math.max(MIN_IDLE_AGENT_SUSPENSION_TIMEOUT_MINUTES, Math.floor(numeric)),
  )
}

export function normalizeIdleAgentSuspensionSettings(value: unknown): IdleAgentSuspensionSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_IDLE_AGENT_SUSPENSION }
  const record = value as Record<string, unknown>
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULT_IDLE_AGENT_SUSPENSION_ENABLED,
    timeoutMinutes: normalizeIdleAgentSuspensionTimeout(record.timeoutMinutes),
  }
}
