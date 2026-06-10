import React, { useState, useRef } from 'react'
import type { Session } from '../../../../shared/types'
import { formatRelativeTime } from '../../utils/time'
import { usePanesStore } from '../../store/panes'
import { useSessionsStore } from '../../store/sessions'
import { agentAccent, agentBadge, agentLabel } from '../../utils/agents'
import { displayGitBranch } from '../../utils/git'
import { border, menuStyles, ui } from '../../styles/theme'

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
    resumeSession(session.agentKind, session.sessionId, session.cwd)
  }

  function closeMenu() {
    setContextMenu(null)
  }

  const statusDot = getStatusDot(session)
  const projectLabel = session.projectName.split('/').pop() ?? session.projectName
  const gitBranch = displayGitBranch(session.gitBranch)
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
          backgroundColor: hovered ? ui.color.control : 'transparent',
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
            <AgentBadge session={session} />
            <span
              style={{
                flex: 1,
                fontSize: 12,
                color: ui.color.text,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {projectLabel}
            </span>
            <span style={{ fontSize: 11, color: ui.color.textMuted, flexShrink: 0 }}>
              {formatRelativeTime(session.lastActivity)}
            </span>
          </div>

          {/* Line 2: git branch badge + first message preview */}
          {(gitBranch || preview) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
              {gitBranch && (
                <span
                  style={{
                    fontSize: 10,
                    color: ui.color.textDim,
                    backgroundColor: ui.color.badge,
                    border: border.default,
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
                  {gitBranch}
                </span>
              )}
              {preview && (
                <span
                  style={{
                    fontSize: 11,
                    color: ui.color.textFaint,
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
          backgroundColor: ui.color.accent,
          display: 'inline-block',
          flexShrink: 0,
        }}
      />
    )
  }
  // resumable
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        border: `1.5px solid ${ui.color.textMuted}`,
        display: 'inline-block',
        flexShrink: 0,
        opacity: 0.8,
      }}
    />
  )
}

function AgentBadge({ session }: { session: Session }): JSX.Element {
  return (
    <span
      title={agentLabel(session.agentKind)}
      style={{
        width: 14,
        height: 14,
        borderRadius: 3,
        border: `1px solid ${agentAccent(session.agentKind)}`,
        color: agentAccent(session.agentKind),
        fontSize: 9,
        fontWeight: 700,
        fontFamily: 'monospace',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {agentBadge(session.agentKind)}
    </span>
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
      action: () => resumeSession(session.agentKind, session.sessionId, session.cwd),
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
      action: () => deleteSession(session.agentKind, session.sessionId),
      danger: true,
    },
  ]

  return (
    <>
      {/* Backdrop */}
      <div
        style={menuStyles.backdrop}
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose() }}
      />
      <div
        style={{
          ...menuStyles.panel,
          left: x,
          top: y,
          minWidth: 180,
        }}
      >
        {items.map((item, i) =>
          item === null ? (
            <div key={i} style={{ ...menuStyles.separator, margin: '4px 0' }} />
          ) : (
            <button
              key={i}
              onClick={() => { item.action(); onClose() }}
              style={{
                ...menuStyles.item,
                display: 'block',
                color: (item as { danger?: boolean }).danger ? ui.color.danger : ui.color.text,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = ui.color.border
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
