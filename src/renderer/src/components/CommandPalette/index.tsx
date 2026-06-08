import React, { useState, useEffect, useRef, useMemo } from 'react'
import { usePanesStore } from '../../store/panes'
import { useSessions } from '../../hooks/useSessions'
import type { Session } from '../../../../shared/types'
import { formatRelativeTime } from '../../utils/time'
import { HOTKEYS } from '../../utils/hotkeys'
import { agentBadge } from '../../utils/agents'

interface SessionEntry {
  kind: 'session'
  session: Session
}

interface ActionEntry {
  kind: 'action'
  label: string
  shortcut?: string
  icon: string
  run: () => void
}

type Entry = SessionEntry | ActionEntry

export function CommandPalette(): JSX.Element {
  const closeOverlays = usePanesStore((s) => s.closeOverlays)
  const addShellPane = usePanesStore((s) => s.addShellPane)
  const newSession = usePanesStore((s) => s.newSession)
  const splitPane = usePanesStore((s) => s.splitPane)
  const getFocusedPane = usePanesStore((s) => s.getFocusedPane)
  const toggleSidebar = usePanesStore((s) => s.toggleSidebar)
  const resumeSession = usePanesStore((s) => s.resumeSession)

  const { sessions, search } = useSessions()
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const actions: ActionEntry[] = useMemo(() => [
    {
      kind: 'action',
      label: 'New Claude session',
      icon: 'C',
      run: () => {
        const pane = getFocusedPane()
        newSession(pane?.cwd ?? window.homeDir ?? 'C:\\', 'vertical', 'claude')
        closeOverlays()
      },
    },
    {
      kind: 'action',
      label: 'New Codex session',
      icon: 'X',
      run: () => {
        const pane = getFocusedPane()
        newSession(pane?.cwd ?? window.homeDir ?? 'C:\\', 'vertical', 'codex')
        closeOverlays()
      },
    },
    {
      kind: 'action',
      label: 'Open shell pane',
      icon: '>',
      run: () => {
        const pane = getFocusedPane()
        addShellPane(pane?.cwd ?? window.homeDir ?? 'C:\\')
        closeOverlays()
      },
    },
    {
      kind: 'action',
      label: 'Split pane vertical',
      shortcut: HOTKEYS.splitVertical.display,
      icon: '|',
      run: () => {
        const pane = getFocusedPane()
        if (pane) splitPane(pane.id, 'vertical')
        closeOverlays()
      },
    },
    {
      kind: 'action',
      label: 'Split pane horizontal',
      shortcut: HOTKEYS.splitHorizontal.display,
      icon: '-',
      run: () => {
        const pane = getFocusedPane()
        if (pane) splitPane(pane.id, 'horizontal')
        closeOverlays()
      },
    },
    {
      kind: 'action',
      label: 'Toggle sidebar',
      shortcut: HOTKEYS.toggleSidebar.display,
      icon: '≡',
      run: () => { toggleSidebar(); closeOverlays() },
    },
  ], [addShellPane, closeOverlays, splitPane, getFocusedPane, toggleSidebar, newSession])

  const filteredSessions: Session[] = query ? search(query) : sessions.slice(0, 6)
  const filteredActions: ActionEntry[] = query
    ? actions.filter((a) => a.label.toLowerCase().includes(query.toLowerCase()))
    : actions

  const entries: Entry[] = [
    ...filteredSessions.map((s): SessionEntry => ({ kind: 'session', session: s })),
    ...filteredActions,
  ]

  useEffect(() => {
    setSelectedIdx(0)
  }, [query])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx((i) => Math.min(i + 1, entries.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const entry = entries[selectedIdx]
      if (entry) executeEntry(entry)
    } else if (e.key === 'Escape') {
      closeOverlays()
    }
  }

  function executeEntry(entry: Entry) {
    if (entry.kind === 'action') {
      entry.run()
    } else {
      resumeSession(entry.session.agentKind, entry.session.sessionId, entry.session.cwd)
      closeOverlays()
    }
  }

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        backgroundColor: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '15vh',
      }}
      onClick={closeOverlays}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        style={{
          width: '100%',
          maxWidth: 600,
          backgroundColor: '#1a1b1e',
          border: '1px solid #2a2b2e',
          borderRadius: 10,
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        }}
      >
        {/* Search input */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '10px 14px',
            borderBottom: '1px solid #2a2b2e',
          }}
        >
          <span style={{ color: '#6b7280', fontSize: 14, marginRight: 8 }}>{'>'}</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions or commands..."
            style={{
              flex: 1,
              background: 'none',
              border: 'none',
              outline: 'none',
              color: '#d4d4d4',
              fontSize: 14,
              caretColor: '#4ade80',
            }}
          />
        </div>

        {/* Results */}
        <div ref={listRef} style={{ maxHeight: 360, overflowY: 'auto' }}>
          {filteredSessions.length > 0 && (
            <>
              <SectionLabel>Sessions</SectionLabel>
              {filteredSessions.map((s, i) => {
                const idx = i
                return (
                  <EntryRow
                    key={`${s.agentKind}:${s.sessionId}`}
                    isSelected={selectedIdx === idx}
                    onClick={() => executeEntry({ kind: 'session', session: s })}
                    onHover={() => setSelectedIdx(idx)}
                  >
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span style={{ fontSize: 13, color: '#d4d4d4' }}>
                        {agentBadge(s.agentKind)} {s.projectName.split('/').pop()}
                      </span>
                      <span style={{ fontSize: 11, color: '#4a4b4e' }}>
                        {formatRelativeTime(s.lastActivity)} ago
                      </span>
                    </div>
                    {s.firstMessage && (
                      <div
                        style={{
                          fontSize: 11,
                          color: '#6b7280',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          maxWidth: '100%',
                        }}
                      >
                        {s.firstMessage}
                      </div>
                    )}
                  </EntryRow>
                )
              })}
            </>
          )}

          {filteredActions.length > 0 && (
            <>
              <SectionLabel>Commands</SectionLabel>
              {filteredActions.map((a, i) => {
                const idx = filteredSessions.length + i
                return (
                  <EntryRow
                    key={a.label}
                    isSelected={selectedIdx === idx}
                    onClick={() => a.run()}
                    onHover={() => setSelectedIdx(idx)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        style={{
                          fontSize: 12,
                          color: '#6b7280',
                          fontFamily: 'monospace',
                          width: 16,
                          textAlign: 'center',
                        }}
                      >
                        {a.icon}
                      </span>
                      <span style={{ fontSize: 13, color: '#d4d4d4', flex: 1 }}>{a.label}</span>
                      {a.shortcut && (
                        <span
                          style={{
                            fontSize: 10,
                            color: '#4a4b4e',
                            backgroundColor: '#141517',
                            border: '1px solid #2a2b2e',
                            borderRadius: 3,
                            padding: '1px 5px',
                          }}
                        >
                          {a.shortcut}
                        </span>
                      )}
                    </div>
                  </EntryRow>
                )
              })}
            </>
          )}

          {entries.length === 0 && (
            <div
              style={{
                padding: '24px 16px',
                textAlign: 'center',
                color: '#4a4b4e',
                fontSize: 12,
              }}
            >
              No results
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      style={{
        padding: '6px 14px 3px',
        fontSize: 10,
        fontWeight: 600,
        color: '#4a4b4e',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
      }}
    >
      {children}
    </div>
  )
}

function EntryRow({
  isSelected,
  onClick,
  onHover,
  children,
}: {
  isSelected: boolean
  onClick: () => void
  onHover: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <div
      onClick={onClick}
      onMouseEnter={onHover}
      style={{
        padding: '7px 14px',
        cursor: 'pointer',
        backgroundColor: isSelected ? '#242528' : 'transparent',
        borderLeft: isSelected ? '2px solid #4ade80' : '2px solid transparent',
      }}
    >
      {children}
    </div>
  )
}
