import React, { useState, useEffect, useRef, useMemo } from 'react'
import { usePanesStore } from '../../store/panes'
import { useSessions } from '../../hooks/useSessions'
import type { Session } from '../../../../shared/types'
import { formatRelativeTime } from '../../utils/time'
import { agentBadge, agentLabel } from '../../utils/agents'

function groupByProject(sessions: Session[]): Map<string, Session[]> {
  const map = new Map<string, Session[]>()
  for (const s of sessions) {
    const key = s.projectName
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(s)
  }
  return map
}

export function SessionBrowser(): JSX.Element {
  const closeOverlays = usePanesStore((s) => s.closeOverlays)
  const resumeSession = usePanesStore((s) => s.resumeSession)
  const resumeSessionInNewTab = usePanesStore((s) => s.resumeSessionInNewTab)
  const { sessions, search } = useSessions()
  const [query, setQuery] = useState('')
  const [selectedProject, setSelectedProject] = useState<string | null>(null)
  const [detailSession, setDetailSession] = useState<Session | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const filtered = query ? search(query) : sessions
  const grouped = useMemo(() => groupByProject(filtered), [filtered])
  const projects = Array.from(grouped.keys())

  // Derive the active project synchronously so the first render already shows
  // the right content. Using useEffect for this causes a visible flicker: the
  // component paints once with selectedProject=null (showing all projects),
  // then the effect fires and re-renders with only the first project shown.
  const activeProject = selectedProject ?? projects[0] ?? null

  function statusLabel(s: Session): string {
    if (s.status === 'live-attached') return 'LIVE'
    return 'RESUMABLE'
  }

  function statusColor(s: Session): string {
    if (s.status === 'live-attached') return '#4ade80'
    return '#6b7280'
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        backgroundColor: 'rgba(0,0,0,0.8)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={closeOverlays}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '85vw',
          maxWidth: 960,
          height: '75vh',
          backgroundColor: '#1a1b1e',
          border: '1px solid #2a2b2e',
          borderRadius: 10,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid #2a2b2e',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: '#d4d4d4' }}>Session Browser</span>
          <span style={{ fontSize: 11, color: '#4a4b4e' }}>ESC to close</span>
        </div>

        {/* Body */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* Left: search + project list */}
          <div
            style={{
              width: 200,
              borderRight: '1px solid #2a2b2e',
              display: 'flex',
              flexDirection: 'column',
              flexShrink: 0,
            }}
          >
            <div style={{ padding: '8px 8px 6px' }}>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search sessions..."
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  backgroundColor: '#141517',
                  border: '1px solid #2a2b2e',
                  borderRadius: 5,
                  color: '#d4d4d4',
                  fontSize: 12,
                  outline: 'none',
                }}
              />
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {projects.map((proj) => (
                <button
                  key={proj}
                  onClick={() => setSelectedProject(proj)}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '7px 12px',
                    background: activeProject === proj ? '#242528' : 'none',
                    border: 'none',
                    borderLeft: activeProject === proj ? '2px solid #4ade80' : '2px solid transparent',
                    textAlign: 'left',
                    cursor: 'pointer',
                    fontSize: 12,
                    color: activeProject === proj ? '#d4d4d4' : '#6b7280',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {proj.split('/').pop()}
                </button>
              ))}
            </div>
          </div>

          {/* Right: sessions by project */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
            {Array.from(grouped.entries()).map(([proj, projSessions]) => {
              if (activeProject && proj !== activeProject) return null
              const first = projSessions[0]
              return (
                <div key={proj} style={{ marginBottom: 20 }}>
                  {/* Project header */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: 6,
                    }}
                  >
                    <div>
                      <span style={{ fontSize: 14, fontWeight: 600, color: '#d4d4d4' }}>
                        {proj.split('/').pop()}
                      </span>
                      <span style={{ fontSize: 11, color: '#4a4b4e', marginLeft: 8 }}>
                        {first.cwd}
                      </span>
                    </div>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: statusColor(first),
                        letterSpacing: '0.06em',
                      }}
                    >
                      {statusLabel(first)}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: '#4a4b4e', marginBottom: 8 }}>
                    {projSessions.length} session{projSessions.length !== 1 ? 's' : ''} - last active{' '}
                    {formatRelativeTime(first.lastActivity)} ago
                  </div>

                  {/* Session rows */}
                  {projSessions.map((s) => (
                    <SessionBrowserRow
                      key={`${s.agentKind}:${s.sessionId}`}
                      session={s}
                      isExpanded={detailSession?.agentKind === s.agentKind && detailSession?.sessionId === s.sessionId}
                      onToggle={() =>
                        setDetailSession((prev) =>
                          prev?.agentKind === s.agentKind && prev?.sessionId === s.sessionId ? null : s
                        )
                      }
                      onResumeSplit={() => {
                        resumeSession(s.agentKind, s.sessionId, s.cwd)
                        closeOverlays()
                      }}
                      onResumeNewTab={() => {
                        resumeSessionInNewTab(s.agentKind, s.sessionId, s.cwd)
                        closeOverlays()
                      }}
                    />
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

interface SessionBrowserRowProps {
  session: Session
  isExpanded: boolean
  onToggle: () => void
  onResumeSplit: () => void
  onResumeNewTab: () => void
}

function SessionBrowserRow({ session, isExpanded, onToggle, onResumeSplit, onResumeNewTab }: SessionBrowserRowProps): JSX.Element {
  const statusDotColor = session.status === 'live-attached' ? '#4ade80' : '#6b7280'

  return (
    <div
      style={{
        border: '1px solid #2a2b2e',
        borderRadius: 6,
        marginBottom: 4,
        overflow: 'hidden',
        backgroundColor: isExpanded ? '#1e2022' : '#141517',
      }}
    >
      <button
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '7px 10px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            backgroundColor:
              session.status === 'live-attached' ? statusDotColor : 'transparent',
            border:
              session.status !== 'live-attached'
                ? `1.5px solid ${statusDotColor}`
                : 'none',
            flexShrink: 0,
            display: 'inline-block',
          }}
        />
        <span style={{ fontSize: 11, color: '#6b7280', flexShrink: 0 }}>
          {agentBadge(session.agentKind)}
        </span>
        <span style={{ fontSize: 11, color: '#4a4b4e', flexShrink: 0 }}>
          {formatRelativeTime(session.lastActivity)}
        </span>
        <span
          style={{
            flex: 1,
            fontSize: 12,
            color: '#d4d4d4',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {session.firstMessage ?? session.sessionId}
        </span>
      </button>

      {isExpanded && (
        <div
          style={{
            padding: '8px 12px 10px',
            borderTop: '1px solid #2a2b2e',
          }}
        >
          <Row label="CWD" value={session.cwd} />
          <Row label="Agent" value={agentLabel(session.agentKind)} />
          {session.gitBranch && <Row label="Branch" value={session.gitBranch} />}
          {session.firstMessage && (
            <Row label="First message" value={session.firstMessage} />
          )}
          {session.lastMessage && session.lastMessage !== session.firstMessage && (
            <Row label="Last message" value={session.lastMessage} />
          )}
          <Row label="Messages" value={String(session.messageCount)} />
          <Row
            label="First activity"
            value={session.firstActivity ? new Date(session.firstActivity).toLocaleString() : '-'}
          />
          <Row
            label="Last activity"
            value={session.lastActivity ? new Date(session.lastActivity).toLocaleString() : '-'}
          />

          <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
            <ActionButton onClick={onResumeSplit}>Resume in split</ActionButton>
            <ActionButton onClick={onResumeNewTab}>Resume in new tab</ActionButton>
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 4, fontSize: 11 }}>
      <span style={{ color: '#4a4b4e', flexShrink: 0, minWidth: 90 }}>{label}</span>
      <span style={{ color: '#a0a0a0', wordBreak: 'break-all' }}>{value}</span>
    </div>
  )
}

function ActionButton({
  onClick,
  children,
}: {
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 10px',
        backgroundColor: '#242528',
        border: '1px solid #2a2b2e',
        borderRadius: 4,
        color: '#c9cdd1',
        fontSize: 11,
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = '#2e2f33'
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = '#242528'
      }}
    >
      {children}
    </button>
  )
}
