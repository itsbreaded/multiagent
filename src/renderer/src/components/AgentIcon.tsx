import type { CSSProperties } from 'react'
import type { AgentKind } from '../../../shared/types'
import { agentLabel } from '../utils/agents'
import claudeCodeIcon from '../assets/claudecode.png'
import codexIcon from '../assets/codex.png'
import terminalIcon from '../assets/terminal.png'

interface AgentIconProps {
  agentKind: AgentKind
  size?: number
  style?: CSSProperties
}

export function AgentIcon({ agentKind, size = 14, style }: AgentIconProps): JSX.Element {
  return (
    <img
      src={agentKind === 'claude' ? claudeCodeIcon : codexIcon}
      alt={agentLabel(agentKind)}
      title={agentLabel(agentKind)}
      style={{
        width: size,
        height: size,
        display: 'inline-block',
        objectFit: 'contain',
        flexShrink: 0,
        verticalAlign: 'middle',
        ...style,
      }}
    />
  )
}

export function ShellIcon({ size = 14, style }: Omit<AgentIconProps, 'agentKind'>): JSX.Element {
  return (
    <img
      src={terminalIcon}
      alt="Shell"
      title="Shell"
      style={{
        width: size,
        height: size,
        display: 'inline-block',
        objectFit: 'contain',
        flexShrink: 0,
        verticalAlign: 'middle',
        ...style,
      }}
    />
  )
}
