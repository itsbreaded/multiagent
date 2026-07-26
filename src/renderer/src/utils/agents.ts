import type { AgentKind } from '../../../shared/types'

export function agentLabel(agentKind: AgentKind): string {
  return agentKind === 'claude' ? 'Claude' : agentKind === 'codex' ? 'Codex' : 'OpenCode'
}

export function agentAccent(agentKind: AgentKind): string {
  return agentKind === 'claude' ? '#4ade80' : agentKind === 'codex' ? '#60a5fa' : '#c084fc'
}