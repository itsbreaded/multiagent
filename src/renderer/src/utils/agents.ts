import { ui } from '../styles/theme'
import type { AgentKind } from '../../../shared/types'

export function agentLabel(agentKind: AgentKind): string {
  return agentKind === 'claude' ? 'Claude' : agentKind === 'codex' ? 'Codex' : 'OpenCode'
}

export function agentAccent(agentKind: AgentKind): string {
  return agentKind === 'claude'
    ? ui.color.providerClaudeAccent
    : agentKind === 'codex'
      ? ui.color.providerCodexAccent
      : ui.color.providerOpenCodeAccent
}
