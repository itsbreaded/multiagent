import type { AgentKind } from '../../../shared/types'

export function agentLabel(agentKind: AgentKind): string {
  return agentKind === 'claude' ? 'Claude' : 'Codex'
}

export function agentAccent(agentKind: AgentKind): string {
  return agentKind === 'claude' ? '#4ade80' : '#60a5fa'
}
