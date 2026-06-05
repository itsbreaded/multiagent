import React, { useRef, useCallback, CSSProperties } from 'react'
import { usePanesStore } from '../../store/panes'
import { useSessions } from '../../hooks/useSessions'
import { SidebarHeader } from './SidebarHeader'
import { SidebarSection } from './SidebarSection'
import { SessionRow } from './SessionRow'
import { OpenTabs } from './OpenTabs'

export function Sidebar(): JSX.Element {
  const sidebarOpen = usePanesStore((s) => s.sidebarOpen)
  const sidebarWidth = usePanesStore((s) => s.sidebarWidth)
  const setSidebarWidth = usePanesStore((s) => s.setSidebarWidth)
  const newSession = usePanesStore((s) => s.newSession)
  const addShellPane = usePanesStore((s) => s.addShellPane)
  const getFocusedPane = usePanesStore((s) => s.getFocusedPane)
  const tabs = usePanesStore((s) => s.tabs)
  const { resumable, archived, loading } = useSessions()

  const defaultCwd = window.homeDir ?? (navigator.userAgent.includes('Windows') ? 'C:\\' : '/')

  function activeCwd(): string {
    return getFocusedPane()?.cwd ?? defaultCwd
  }

  // Resize drag
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      dragging.current = true
      startX.current = e.clientX
      startWidth.current = sidebarWidth

      const onMove = (me: MouseEvent) => {
        if (!dragging.current) return
        const delta = me.clientX - startX.current
        const next = Math.max(140, Math.min(400, startWidth.current + delta))
        setSidebarWidth(next)
      }
      const onUp = () => {
        dragging.current = false
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [sidebarWidth, setSidebarWidth]
  )

  if (!sidebarOpen) return <></>

  return (
    <div
      style={{
        width: sidebarWidth,
        minWidth: sidebarWidth,
        maxWidth: sidebarWidth,
        backgroundColor: '#1a1b1e',
        borderRight: '1px solid #2a2b2e',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        flexShrink: 0,
        position: 'relative',
      }}
    >
      <SidebarHeader />

      {/* Action buttons */}
      <div style={{ padding: '8px 8px 6px', display: 'flex', gap: 6 }}>
        <SidebarButton onClick={() => newSession(activeCwd())} label="+ Session" />
        <SidebarButton onClick={() => addShellPane(activeCwd())} label="+ Shell" />
      </div>

      {/* Scrollable session list */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        {loading && (
          <div style={{ padding: '12px 16px', fontSize: 11, color: '#4a4b4e' }}>
            Scanning sessions...
          </div>
        )}

        {/* Open tabs - always visible, reflects current app state */}
        {tabs.length > 0 && (
          <SidebarSection title="Open" count={tabs.length} defaultOpen>
            <OpenTabs />
          </SidebarSection>
        )}

        {resumable.length > 0 && (
          <SidebarSection title="Recent" count={resumable.length} defaultOpen>
            {resumable.map((s) => (
              <SessionRow key={s.sessionId} session={s} />
            ))}
          </SidebarSection>
        )}

        {archived.length > 0 && (
          <SidebarSection title="Archived" count={archived.length} defaultOpen={false}>
            {archived.map((s) => (
              <SessionRow key={s.sessionId} session={s} />
            ))}
          </SidebarSection>
        )}
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={onMouseDown}
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          width: 4,
          cursor: 'col-resize',
          zIndex: 10,
        }}
      />
    </div>
  )
}

const btnBase: CSSProperties = {
  flex: 1,
  padding: '6px 6px',
  backgroundColor: '#242528',
  border: '1px solid #2a2b2e',
  borderRadius: 5,
  color: '#c9cdd1',
  fontSize: 12,
  cursor: 'pointer',
  fontWeight: 500,
  textAlign: 'center' as const,
}

function SidebarButton({ onClick, label }: { onClick: () => void; label: string }): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={btnBase}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#2e2f33' }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#242528' }}
    >
      {label}
    </button>
  )
}
