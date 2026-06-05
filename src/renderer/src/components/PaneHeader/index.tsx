import React from 'react'
import type { PaneLeaf } from '../../../../shared/types'
import { usePanesStore } from '../../store/panes'
import { useSessionsStore } from '../../store/sessions'

interface PaneHeaderProps {
  pane: PaneLeaf
  isFocused: boolean
}

export function PaneHeader({ pane, isFocused }: PaneHeaderProps): JSX.Element {
  const splitPane = usePanesStore((s) => s.splitPane)
  const closePane = usePanesStore((s) => s.closePane)
  const zoomPane = usePanesStore((s) => s.zoomPane)
  const unzoom = usePanesStore((s) => s.unzoom)
  const zoomedPaneId = usePanesStore((s) => s.zoomedPaneId)
  const sessions = useSessionsStore((s) => s.sessions)

  const session = pane.sessionId
    ? sessions.find((s) => s.sessionId === pane.sessionId)
    : null

  const title = pane.title ??
    session?.projectName ??
    pane.cwd.replace(/\\/g, '/').split('/').pop() ??
    pane.cwd

  const branch = session?.gitBranch ?? null
  const isZoomed = zoomedPaneId === pane.id
  const icon = pane.paneType === 'claude' ? 'C' : '>'

  return (
    <div
      style={{
        height: 28,
        backgroundColor: isFocused ? '#1e2022' : '#161819',
        borderTop: isFocused ? '2px solid #4ade80' : '2px solid transparent',
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 8,
        paddingRight: 4,
        gap: 6,
        flexShrink: 0,
        userSelect: 'none',
        overflow: 'hidden',
      }}
    >
      {/* Icon */}
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: pane.paneType === 'claude' ? '#4ade80' : '#6b7280',
          flexShrink: 0,
          fontFamily: 'monospace',
          width: 14,
          textAlign: 'center',
        }}
      >
        {icon}
      </span>

      {/* Title */}
      <span
        style={{
          fontSize: 12,
          color: isFocused ? '#d4d4d4' : '#6b7280',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flexShrink: 1,
        }}
      >
        {title}
      </span>

      {/* Git branch */}
      {branch && (
        <span
          style={{
            fontSize: 11,
            color: '#4a4b4e',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flexShrink: 1,
          }}
        >
          {branch}
        </span>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Status pill for claude panes */}
      {pane.paneType === 'claude' && (
        <span
          style={{
            fontSize: 10,
            color: '#6b7280',
            backgroundColor: '#1e2022',
            border: '1px solid #2a2b2e',
            borderRadius: 3,
            padding: '1px 5px',
            flexShrink: 0,
          }}
        >
          waiting
        </span>
      )}

      {/* Action buttons */}
      <HeaderButton
        title="Split vertical (Ctrl+Shift+E)"
        onClick={() => splitPane(pane.id, 'vertical')}
      >
        ⊟
      </HeaderButton>
      <HeaderButton
        title="Split horizontal (Ctrl+Shift+D)"
        onClick={() => splitPane(pane.id, 'horizontal')}
      >
        ⊞
      </HeaderButton>
      <HeaderButton
        title={isZoomed ? 'Unzoom' : 'Zoom pane (Ctrl+Shift+Enter)'}
        onClick={() => (isZoomed ? unzoom() : zoomPane(pane.id))}
      >
        {isZoomed ? '⊟' : '⤢'}
      </HeaderButton>
      <HeaderButton
        title="Close pane (Ctrl+Shift+W)"
        onClick={() => closePane(pane.id)}
      >
        ×
      </HeaderButton>
    </div>
  )
}

function HeaderButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: 'none',
        border: 'none',
        color: '#5a5c61',
        cursor: 'pointer',
        padding: '2px 3px',
        fontSize: 13,
        lineHeight: 1,
        borderRadius: 3,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.color = '#d4d4d4'
        ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = '#2a2b2e'
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.color = '#5a5c61'
        ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'
      }}
    >
      {children}
    </button>
  )
}
