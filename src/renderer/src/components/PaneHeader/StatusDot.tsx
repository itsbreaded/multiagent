import type { AgentStatus, PaneLeaf } from '../../../../shared/types'
import { ui } from '../../styles/theme'

// Spec 032: a small colored CSS dot in PaneHeader showing the agent's live status, driven
// entirely by lifecycle hook events (never screen scraping). Not a button -- no .png asset.
// New agent sessions are seeded idle before hook events arrive. Explicit `unknown` remains
// available for a genuinely unknown lifecycle state.

interface StatusDotProps {
  status: AgentStatus
  detail?: string
  disconnected?: boolean
}

export function isAgentPaneDisconnected(
  pane: Pick<PaneLeaf, 'paneType' | 'ptyId' | 'agentDisconnected' | 'agentSuspension'>,
): boolean {
  if (pane.paneType !== 'agent') return false
  const hasLivePty = typeof pane.ptyId === 'string' && pane.ptyId.trim().length > 0
  return !hasLivePty || !!pane.agentDisconnected || !!pane.agentSuspension
}

const COLOR: Record<AgentStatus, string> = {
  working: ui.color.statusWorking,
  waiting: ui.color.statusWaiting,
  error: ui.color.danger,
  idle: ui.color.textMuted,
  unknown: ui.color.textFaint,
}

function tooltip(status: AgentStatus, detail?: string, disconnected = false): string {
  if (disconnected) return 'Disconnected'
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

export function StatusDot({ status, detail, disconnected = false }: StatusDotProps): JSX.Element {
  return (
    <span
      title={tooltip(status, detail, disconnected)}
      style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        backgroundColor: disconnected ? 'transparent' : COLOR[status],
        border: disconnected ? '1px solid #7b8188' : undefined,
        flexShrink: 0,
        display: 'inline-block',
        // Breathe off the agent/shell icon it sits next to (PaneHeader + Sidebar both).
        marginLeft: 2,
      }}
    />
  )
}
