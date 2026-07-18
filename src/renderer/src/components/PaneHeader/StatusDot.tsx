import type { AgentStatus } from '../../../../shared/types'
import { ui } from '../../styles/theme'

// Spec 032: a small colored CSS dot in PaneHeader showing the agent's live status, driven
// entirely by lifecycle hook events (never screen scraping). Not a button -- no .png asset.
// `unknown` is the honest fallback when no hook events have arrived yet.

interface StatusDotProps {
  status: AgentStatus
  detail?: string
}

const COLOR: Record<AgentStatus, string> = {
  working: ui.color.statusWorking,
  waiting: ui.color.statusWaiting,
  error: ui.color.danger,
  idle: ui.color.textMuted,
  unknown: ui.color.textFaint,
}

function tooltip(status: AgentStatus, detail?: string): string {
  switch (status) {
    case 'working':
      // "Thinking" collapses into working -- state that explicitly so the badge stays honest.
      return detail ? `Working: ${detail} (includes thinking)` : 'Working (includes thinking)'
    case 'waiting':
      return detail ? `Waiting for permission: ${detail}` : 'Waiting for permission'
    case 'error':
      return detail ? `Error: ${detail}` : 'Error'
    case 'idle':
      return 'Idle'
    case 'unknown':
      return 'Status unknown'
  }
}

export function StatusDot({ status, detail }: StatusDotProps): JSX.Element {
  return (
    <span
      title={tooltip(status, detail)}
      style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        backgroundColor: COLOR[status],
        flexShrink: 0,
        display: 'inline-block',
        // Breathe off the agent/shell icon it sits next to (PaneHeader + Sidebar both).
        marginLeft: 2,
      }}
    />
  )
}