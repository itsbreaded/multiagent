import type { AgentEventMeta, AgentKind, AgentWorkSnapshot, AgentWorkTerminalState } from './types'

export const MAX_AGENT_EVENT_BODY_BYTES = 128 * 1024
export const MAX_AGENT_WORK_ITEMS = 64
export const MAX_AGENT_ID_LENGTH = 256
export const MAX_AGENT_TRACKED_IDENTITIES = 256
export const MAX_AGENT_COUNT = MAX_AGENT_WORK_ITEMS

const TERMINAL_STATES: readonly AgentWorkTerminalState[] = [
  'completed', 'interrupted', 'failed', 'idle', 'busy', 'retry',
]
const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex', 'opencode']

function boundedId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= MAX_AGENT_ID_LENGTH ? trimmed : undefined
}

function boundedIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_AGENT_WORK_ITEMS) return undefined
  const ids: string[] = []
  for (const item of value) {
    const id = boundedId(item)
    if (!id || ids.includes(id)) return undefined
    ids.push(id)
  }
  return ids
}

export function normalizeAgentWorkSnapshot(value: unknown): AgentWorkSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<AgentWorkSnapshot>
  if (!AGENT_KINDS.includes(raw.provider as AgentKind)) return undefined
  if (raw.completeness !== 'complete' && raw.completeness !== 'incomplete') return undefined
  if (!TERMINAL_STATES.includes(raw.terminalState as AgentWorkTerminalState)) return undefined
  if (!Number.isInteger(raw.activeCount) || !Number.isInteger(raw.scheduledCount)) return undefined
  if ((raw.activeCount as number) < 0 || (raw.activeCount as number) > MAX_AGENT_COUNT) return undefined
  if ((raw.scheduledCount as number) < 0 || (raw.scheduledCount as number) > MAX_AGENT_COUNT) return undefined

  const activeIds = raw.activeIds === undefined ? undefined : boundedIds(raw.activeIds)
  const scheduledIds = raw.scheduledIds === undefined ? undefined : boundedIds(raw.scheduledIds)
  if (raw.activeIds !== undefined && !activeIds) return undefined
  if (raw.scheduledIds !== undefined && !scheduledIds) return undefined
  if ((activeIds?.length ?? 0) > MAX_AGENT_TRACKED_IDENTITIES || (scheduledIds?.length ?? 0) > MAX_AGENT_TRACKED_IDENTITIES) return undefined

  const sessionId = raw.sessionId === undefined ? undefined : boundedId(raw.sessionId)
  const turnId = raw.turnId === undefined ? undefined : boundedId(raw.turnId)
  if (raw.sessionId !== undefined && !sessionId) return undefined
  if (raw.turnId !== undefined && !turnId) return undefined
  if (activeIds && raw.activeCount !== activeIds.length) return undefined
  if (scheduledIds && raw.scheduledCount !== scheduledIds.length) return undefined

  return {
    provider: raw.provider as AgentKind,
    completeness: raw.completeness,
    terminalState: raw.terminalState as AgentWorkTerminalState,
    activeCount: raw.activeCount as number,
    scheduledCount: raw.scheduledCount as number,
    ...(activeIds ? { activeIds } : {}),
    ...(scheduledIds ? { scheduledIds } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(turnId ? { turnId } : {}),
  }
}

export function normalizeAgentEventMeta(value: unknown): AgentEventMeta | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<AgentEventMeta>
  const sessionId = raw.sessionId === undefined ? undefined : boundedId(raw.sessionId)
  if (raw.sessionId !== undefined && !sessionId) return undefined
  const evidence = raw.evidence === undefined ? undefined : normalizeAgentWorkSnapshot(raw.evidence)
  if (raw.evidence !== undefined && !evidence) return undefined
  if (sessionId && evidence?.sessionId && sessionId !== evidence.sessionId) return undefined
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(evidence ? { evidence } : {}),
  }
}

export function hasAgentEvidenceIdentityMismatch(input: {
  sessionId?: string
  turnId?: string
  evidence?: AgentWorkSnapshot
}): boolean {
  return Boolean(
    (input.sessionId && input.evidence?.sessionId && input.sessionId !== input.evidence.sessionId) ||
    (input.turnId && input.evidence?.turnId && input.turnId !== input.evidence.turnId),
  )
}
