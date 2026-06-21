import React, { useState, useEffect, useRef } from 'react'
import { usePanesStore } from '../../store/panes'
import { useSettingsStore } from '../../store/settings'
import { AgentIcon, ShellIcon } from '../AgentIcon'
import { getCommands, CATEGORY_ORDER, type Command, type CommandContext } from '../../commands/registry'

export function CommandPalette(): JSX.Element {
  const closeOverlays = usePanesStore((s) => s.closeOverlays)
  const addShellPane = usePanesStore((s) => s.addShellPane)
  const newSession = usePanesStore((s) => s.newSession)
  const splitPane = usePanesStore((s) => s.splitPane)
  const getFocusedPane = usePanesStore((s) => s.getFocusedPane)
  const toggleSidebar = usePanesStore((s) => s.toggleSidebar)
  const toggleSessionBrowser = usePanesStore((s) => s.toggleSessionBrowser)
  const openSettings = usePanesStore((s) => s.openSettings)
  const closePane = usePanesStore((s) => s.closePane)
  const zoomPane = usePanesStore((s) => s.zoomPane)
  const unzoom = usePanesStore((s) => s.unzoom)
  const zoomedPaneId = usePanesStore((s) => s.zoomedPaneId)
  const addTab = usePanesStore((s) => s.addTab)
  const closeTab = usePanesStore((s) => s.closeTab)
  const duplicateTab = usePanesStore((s) => s.duplicateTab)
  const setPaneCustomName = usePanesStore((s) => s.setPaneCustomName)
  const setPendingRenamePaneId = usePanesStore((s) => s.setPendingRenamePaneId)
  const setPendingRenameTabId = usePanesStore((s) => s.setPendingRenameTabId)
  const openDirPickerForTab = usePanesStore((s) => s.openDirPickerForTab)
  const activeTabId = usePanesStore((s) => s.activeTabId)
  const tabs = usePanesStore((s) => s.tabs)
  const isDetachedWindow = usePanesStore((s) => s.isDetachedWindow)
  const vsCodeAvailable = usePanesStore((s) => s.vsCodeAvailable)
  const hotkeyOverrides = useSettingsStore((s) => s.hotkeyOverrides)

  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const mouseDownOnOverlay = useRef(false)
  const entryRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const focusedPane = getFocusedPane()
  const activeTab = tabs.find((t) => t.id === activeTabId)

  const ctx: CommandContext = {
    getFocusedPane,
    activeTabId,
    activeTabDefaultCwd: activeTab?.defaultCwd,
    cwd: focusedPane?.cwd ?? window.homeDir ?? 'C:\\',
    isDetachedWindow,
    tabCount: tabs.length,
    vsCodeAvailable,
    closeOverlays,
    newSession,
    addShellPane,
    splitPane,
    zoomedPaneId,
    closePane,
    zoomPane,
    unzoom,
    addTab,
    closeTab,
    duplicateTab,
    toggleSidebar,
    toggleSessionBrowser,
    openSettings,
    setPaneCustomName,
    setPendingRenamePaneId,
    setPendingRenameTabId,
    openDirPickerForTab,
    hotkeyOverrides,
  }

  const normalizedQuery = query.trim().toLowerCase()

  const allCommands = getCommands(ctx)
  const filteredCommands: Command[] = normalizedQuery
    ? allCommands.filter((c) =>
        c.title.toLowerCase().includes(normalizedQuery) ||
        c.category.toLowerCase().includes(normalizedQuery) ||
        c.keywords?.some((k) => k.includes(normalizedQuery))
      )
    : allCommands

  const commandIndexMap = new Map<string, number>()
  filteredCommands.forEach((c, i) => commandIndexMap.set(c.id, i))

  const grouped = new Map<string, Command[]>()
  for (const cat of CATEGORY_ORDER) grouped.set(cat, [])
  for (const cmd of filteredCommands) {
    if (!grouped.has(cmd.category)) grouped.set(cmd.category, [])
    grouped.get(cmd.category)!.push(cmd)
  }

  const totalEntries = filteredCommands.length

  useEffect(() => {
    setSelectedIdx(0)
    entryRefs.current.clear()
  }, [query])

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx((i) => Math.min(i + 1, totalEntries - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = filteredCommands[selectedIdx]
      if (cmd) void cmd.run(ctx)
    } else if (e.key === 'Escape') {
      closeOverlays()
    }
  }

  useEffect(() => {
    entryRefs.current.get(selectedIdx)?.scrollIntoView({ block: 'nearest' })
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
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget }}
      onClick={() => { if (mouseDownOnOverlay.current) closeOverlays() }}
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
            placeholder="Search commands…"
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

        <div style={{ maxHeight: 440, overflowY: 'auto' }}>
          {[...grouped.entries()].map(([category, cmds]) => {
            if (cmds.length === 0) return null
            return (
              <React.Fragment key={category}>
                <SectionLabel>{category}</SectionLabel>
                {cmds.map((cmd) => {
                  const idx = commandIndexMap.get(cmd.id)!
                  const shortcut = cmd.shortcut?.(ctx)
                  return (
                    <EntryRow
                      key={cmd.id}
                      isSelected={selectedIdx === idx}
                      onClick={() => void cmd.run(ctx)}
                      onHover={() => setSelectedIdx(idx)}
                      elRef={(el) => { if (el) entryRefs.current.set(idx, el); else entryRefs.current.delete(idx) }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span
                          style={{
                            fontSize: 12,
                            color: '#6b7280',
                            fontFamily: 'monospace',
                            width: 16,
                            height: 16,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {cmd.agentKind
                            ? <AgentIcon agentKind={cmd.agentKind} size={16} />
                            : cmd.shellIcon
                              ? <ShellIcon size={16} />
                              : '›'}
                        </span>
                        <span style={{ fontSize: 13, color: '#d4d4d4', flex: 1 }}>{cmd.title}</span>
                        {shortcut && (
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
                            {shortcut}
                          </span>
                        )}
                      </div>
                    </EntryRow>
                  )
                })}
              </React.Fragment>
            )
          })}

          {totalEntries === 0 && (
            <div style={{ padding: '24px 16px', textAlign: 'center', color: '#4a4b4e', fontSize: 12 }}>
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
  elRef,
  children,
}: {
  isSelected: boolean
  onClick: () => void
  onHover: () => void
  elRef?: (el: HTMLDivElement | null) => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <div
      ref={elRef}
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
