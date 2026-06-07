import React, { useState, useRef } from 'react'
import type { Session } from '../../../../shared/types'
import { formatRelativeTime } from '../../utils/time'
import { usePanesStore } from '../../store/panes'
import { useSessionsStore } from '../../store/sessions'

interface SessionRowProps {
  session: Session
}

interface ContextMenuState {
  x: number
  y: number
}

export function SessionRow({ session }: SessionRowProps): JSX.Element {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [hovered, setHovered] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const resumeSession = usePanesStore((s) => s.resumeSession)

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  function handleClick() {
    resumeSession(session.sessionId, session.cwd)
  }

  function closeMenu() {
    setContextMenu(null)
  }

  const statusDot = getStatusDot(session)
  const projectLabel = session.projectName.split('/').pop() ?? session.projectName
  const preview = session.firstMessage
    ? session.firstMessage.replace(/^\/\w+\s*/, '').trim().slice(0, 55) || null
    : null

  return (
    <>
      <div
        ref={rowRef}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={session.cwd}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          padding: '5px 12px 5px 16px',
          cursor: 'pointer',
          borderRadius: 4,
          margin: '1px 4px',
          backgroundColor: hovered ? '#242528' : 'transparent',
          transition: 'background-color 0.1s',
          position: 'relative',
        }}
      >
        {/* Status dot — offset down to align with first text line */}
        <span style={{ flexShrink: 0, marginTop: 2 }}>{statusDot}</span>

        {/* Content column */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Line 1: project name + relative time */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span
              style={{
                flex: 1,
                fontSize: 12,
                color: '#c9cdd1',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {projectLabel}
            </span>
            <span style={{ fontSize: 11, color: '#6b7280', flexShrink: 0 }}>
              {formatRelativeTime(session.lastActivity)}
            </span>
          </div>

          {/* Line 2: git branch badge + first message preview */}
          {(session.gitBranch || preview) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
              {session.gitBranch && (
                <span
                  style={{
                    fontSize: 10,
                    color: '#4a4b4e',
                    backgroundColor: '#191a1d',
                    border: '1px solid #2a2b2e',
                    borderRadius: 3,
                    padding: '0 4px',
                    lineHeight: '14px',
                    flexShrink: 0,
                    maxWidth: 64,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {session.gitBranch}
                </span>
              )}
              {preview && (
                <span
                  style={{
                    fontSize: 11,
                    color: '#5a5c61',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                    lineHeight: '14px',
                  }}
                >
                  {preview}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          session={session}
          onClose={closeMenu}
        />
      )}
    </>
  )
}

function getStatusDot(session: Session): React.ReactNode {
  if (session.status === 'live-attached') {
    return (
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: '#4ade80',
          display: 'inline-block',
          flexShrink: 0,
        }}
      />
    )
  }
  // resumable or archived
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        border: '1.5px solid #6b7280',
        display: 'inline-block',
        flexShrink: 0,
        opacity: session.status === 'archived' ? 0.4 : 0.8,
      }}
    />
  )
}

interface ContextMenuProps {
  x: number
  y: number
  session: Session
  onClose: () => void
}

function ContextMenu({ x, y, session, onClose }: ContextMenuProps): JSX.Element {
  const resumeSession = usePanesStore((s) => s.resumeSession)
  const deleteSession = useSessionsStore((s) => s.deleteSession)

  const items = [
    {
      label: 'Resume in new split',
      action: () => resumeSession(session.sessionId, session.cwd),
    },
    {
      label: 'Open folder',
      action: () => {
        if (typeof window !== 'undefined' && window.ipc) {
          window.ipc.invoke('shell:open-folder', session.cwd).catch(() => {})
        }
      },
    },
    {
      label: 'Copy session ID',
      action: () => {
        if (typeof window !== 'undefined' && window.ipc) {
          window.ipc.invoke('shell:copy-to-clipboard', session.sessionId).catch(() => {})
        } else {
          navigator.clipboard.writeText(session.sessionId)
        }
      },
    },
    null, // divider
    {
      label: 'Delete',
      action: () => deleteSession(session.sessionId),
      danger: true,
    },
  ]

  return (
    <>
      {/* Backdrop */}
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 100 }}
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose() }}
      />
      <div
        style={{
          position: 'fixed',
          left: x,
          top: y,
          zIndex: 101,
          backgroundColor: '#1e2022',
          border: '1px solid #2a2b2e',
          borderRadius: 6,
          padding: '4px 0',
          minWidth: 180,
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        }}
      >
        {items.map((item, i) =>
          item === null ? (
            <div key={i} style={{ height: 1, backgroundColor: '#2a2b2e', margin: '4px 0' }} />
          ) : (
            <button
              key={i}
              onClick={() => { item.action(); onClose() }}
              style={{
                display: 'block',
                width: '100%',
                padding: '6px 12px',
                background: 'none',
                border: 'none',
                textAlign: 'left',
                fontSize: 12,
                color: (item as { danger?: boolean }).danger ? '#f87171' : '#c9cdd1',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = '#2a2b2e'
              }}
              onMouseLeave={(e) => {
                ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'
              }}
            >
              {item.label}
            </button>
          )
        )}
      </div>
    </>
  )
}
