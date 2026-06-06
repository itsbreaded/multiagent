import React, { useState, useRef, useEffect } from 'react'
import type { PaneLeaf } from '../../../../shared/types'
import { usePanesStore } from '../../store/panes'
import { useSessionsStore } from '../../store/sessions'
import { paneLabelText } from '../../utils/tabLabels'

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
  const setPaneCustomName = usePanesStore((s) => s.setPaneCustomName)
  const setDraggedPane = usePanesStore((s) => s.setDraggedPane)
  const sessions = useSessionsStore((s) => s.sessions)

  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) inputRef.current?.select()
  }, [renaming])

  function startRename(e: React.MouseEvent): void {
    e.stopPropagation()
    setRenameValue(pane.customName ?? '')
    setRenaming(true)
  }

  function commitRename(): void {
    setPaneCustomName(pane.id, renameValue)
    setRenaming(false)
  }

  const label = paneLabelText(pane, sessions)
  const isZoomed = zoomedPaneId === pane.id
  const icon = pane.paneType === 'claude' ? 'C' : '>'
  const session = pane.sessionId ? sessions.find((s) => s.sessionId === pane.sessionId) : null
  const branch = session?.gitBranch ?? null

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
      {/* Drag handle */}
      <span
        draggable
        onDragStart={(e) => { e.stopPropagation(); setDraggedPane(pane.id) }}
        onDragEnd={() => setDraggedPane(null)}
        title="Drag to rearrange pane"
        style={{
          fontSize: 10,
          color: '#3a3b3e',
          cursor: 'grab',
          flexShrink: 0,
          lineHeight: 1,
          userSelect: 'none',
          paddingRight: 2,
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#6b7280' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#3a3b3e' }}
      >
        ⠿
      </span>

      {/* Type icon */}
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

      {/* Title — double-click to rename */}
      {renaming ? (
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitRename() }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenaming(false) }
          }}
          onClick={(e) => e.stopPropagation()}
          placeholder="Label (optional)"
          style={{
            background: '#141517',
            border: '1px solid #4ade80',
            borderRadius: 3,
            color: '#c9cdd1',
            fontSize: 12,
            padding: '1px 4px',
            outline: 'none',
            width: 120,
            flexShrink: 0,
          }}
        />
      ) : (
        <span
          onDoubleClick={startRename}
          title="Double-click to add a label"
          style={{
            fontSize: 12,
            color: isFocused ? '#d4d4d4' : '#6b7280',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flexShrink: 1,
            cursor: 'default',
          }}
        >
          {label}
        </span>
      )}

      {/* Git branch */}
      {branch && !renaming && (
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

      <div style={{ flex: 1 }} />

      {/* Status pill for claude panes */}
      {pane.paneType === 'claude' && !renaming && (
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
      <HeaderButton title="Split vertical (Ctrl+Shift+E)" onClick={() => splitPane(pane.id, 'vertical')}>⊞</HeaderButton>
      <HeaderButton title="Split horizontal (Ctrl+Shift+D)" onClick={() => splitPane(pane.id, 'horizontal')}>⊟</HeaderButton>
      <HeaderButton
        title={isZoomed ? 'Unzoom' : 'Zoom pane (Ctrl+Shift+Enter)'}
        onClick={() => (isZoomed ? unzoom() : zoomPane(pane.id))}
      >
        {isZoomed ? '⊟' : '⤢'}
      </HeaderButton>
      <HeaderButton title="Close pane (Ctrl+Shift+W)" onClick={() => closePane(pane.id)}>×</HeaderButton>
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
