import React, { useRef, useState, useEffect, useCallback } from 'react'
import { usePanesStore } from '../../store/panes'
import { useSessionsStore } from '../../store/sessions'
import type { Tab } from '../../../../shared/types'
import { computeLabels, collectLeaves } from '../../utils/tabLabels'

// --- Sub-components ---

function BarButton({
  onClick,
  title,
  children,
  active,
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
  active?: boolean
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: active ? '#242528' : 'none',
        border: 'none',
        color: active ? '#c9cdd1' : '#5a5c61',
        cursor: 'pointer',
        padding: '0 8px',
        height: '100%',
        fontSize: 16,
        lineHeight: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        borderRadius: 0,
      }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.color = '#c9cdd1'
        ;(e.currentTarget as HTMLButtonElement).style.background = '#242528'
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.color = active ? '#c9cdd1' : '#5a5c61'
        ;(e.currentTarget as HTMLButtonElement).style.background = active ? '#242528' : 'none'
      }}
    >
      {children}
    </button>
  )
}

interface ContextMenuState {
  tabId: string
  x: number
  y: number
}

function ContextMenu({
  menu,
  tabs,
  onClose,
  onRename,
  closeTab,
  closeOtherTabs,
  closeTabsToRight,
  duplicateTab,
}: {
  menu: ContextMenuState
  tabs: Tab[]
  onClose: () => void
  onRename: (tabId: string) => void
  closeTab: (id: string) => void
  closeOtherTabs: (id: string) => void
  closeTabsToRight: (id: string) => void
  duplicateTab: (id: string) => void
}): JSX.Element {
  const idx = tabs.findIndex((t) => t.id === menu.tabId)
  const hasRight = idx < tabs.length - 1
  const hasOthers = tabs.length > 1

  function item(label: string, onClick: () => void, disabled = false): JSX.Element {
    return (
      <button
        key={label}
        onClick={disabled ? undefined : onClick}
        style={{
          display: 'block',
          width: '100%',
          padding: '6px 14px',
          background: 'none',
          border: 'none',
          textAlign: 'left',
          fontSize: 12,
          color: disabled ? '#3a3b3e' : '#c9cdd1',
          cursor: disabled ? 'default' : 'pointer',
          whiteSpace: 'nowrap',
        }}
        onMouseEnter={(e) => {
          if (!disabled) (e.currentTarget as HTMLButtonElement).style.background = '#242528'
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.background = 'none'
        }}
      >
        {label}
      </button>
    )
  }

  function separator(): JSX.Element {
    return <div style={{ height: 1, margin: '3px 0', backgroundColor: '#2a2b2e' }} />
  }

  return (
    <div
      style={{
        position: 'fixed',
        top: menu.y,
        left: menu.x,
        zIndex: 200,
        backgroundColor: '#1a1b1e',
        border: '1px solid #2a2b2e',
        borderRadius: 6,
        padding: '4px 0',
        minWidth: 190,
        boxShadow: '0 8px 24px rgba(0,0,0,0.55)',
      }}
    >
      {item('Rename Tab', () => { onRename(menu.tabId); onClose() })}
      {separator()}
      {item('Close Tab', () => { closeTab(menu.tabId); onClose() })}
      {item('Close Other Tabs', () => { closeOtherTabs(menu.tabId); onClose() }, !hasOthers)}
      {item('Close Tabs to the Right', () => { closeTabsToRight(menu.tabId); onClose() }, !hasRight)}
      {separator()}
      {item('Duplicate Tab', () => { duplicateTab(menu.tabId); onClose() })}
    </div>
  )
}

// --- TabBar ---

export function TabBar(): JSX.Element {
  const tabs = usePanesStore((s) => s.tabs)
  const activeTabId = usePanesStore((s) => s.activeTabId)
  const setActiveTab = usePanesStore((s) => s.setActiveTab)
  const closeTab = usePanesStore((s) => s.closeTab)
  const addTab = usePanesStore((s) => s.addTab)
  const renameTab = usePanesStore((s) => s.renameTab)
  const duplicateTab = usePanesStore((s) => s.duplicateTab)
  const closeOtherTabs = usePanesStore((s) => s.closeOtherTabs)
  const closeTabsToRight = usePanesStore((s) => s.closeTabsToRight)
  const sidebarOpen = usePanesStore((s) => s.sidebarOpen)
  const toggleSidebar = usePanesStore((s) => s.toggleSidebar)
  const toggleSessionBrowser = usePanesStore((s) => s.toggleSessionBrowser)
  const toggleCommandPalette = usePanesStore((s) => s.toggleCommandPalette)
  const sessionBrowserOpen = usePanesStore((s) => s.sessionBrowserOpen)
  const commandPaletteOpen = usePanesStore((s) => s.commandPaletteOpen)
  const sessions = useSessionsStore((s) => s.sessions)

  const labels = computeLabels(tabs, sessions)

  // Drag reorder
  const dragIndex = useRef<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  // Rename state
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    function onMouseDown(e: MouseEvent): void {
      const target = e.target as Node
      const menu = document.getElementById('tab-context-menu')
      if (menu && !menu.contains(target)) setContextMenu(null)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [contextMenu])

  // Close context menu / cancel rename on Escape
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        setContextMenu(null)
        setRenamingTabId(null)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // Focus rename input when it appears
  useEffect(() => {
    if (renamingTabId) {
      renameInputRef.current?.select()
    }
  }, [renamingTabId])

  const startRename = useCallback((tabId: string) => {
    setRenameValue(labels.get(tabId) ?? '')
    setRenamingTabId(tabId)
  }, [labels])

  const commitRename = useCallback(() => {
    if (renamingTabId) renameTab(renamingTabId, renameValue)
    setRenamingTabId(null)
  }, [renamingTabId, renameValue, renameTab])

  function hasClaudePane(tab: Tab): boolean {
    return collectLeaves(tab.rootNode).some((l) => l.paneType === 'claude')
  }

  return (
    <div
      style={{
        height: 36,
        backgroundColor: '#141517',
        borderBottom: '1px solid #2a2b2e',
        display: 'flex',
        alignItems: 'center',
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      {/* Sidebar toggle */}
      <BarButton
        onClick={toggleSidebar}
        title={sidebarOpen ? 'Collapse sidebar (Ctrl+B)' : 'Open sidebar (Ctrl+B)'}
        active={sidebarOpen}
      >
        ≡
      </BarButton>

      <div style={{ width: 1, height: 20, backgroundColor: '#2a2b2e', flexShrink: 0 }} />

      {/* Tab strip */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          overflow: 'hidden',
          paddingLeft: 6,
          paddingRight: 6,
        }}
      >
        {tabs.map((tab, idx) => {
          const isActive = tab.id === activeTabId
          const label = labels.get(tab.id) ?? 'Shell'
          const live = hasClaudePane(tab)
          const isRenaming = renamingTabId === tab.id

          return (
            <div
              key={tab.id}
              draggable={!isRenaming}
              onDragStart={() => { dragIndex.current = idx }}
              onDragOver={(e) => { e.preventDefault(); setDragOverIndex(idx) }}
              onDragLeave={() => setDragOverIndex(null)}
              onDrop={() => {
                if (dragIndex.current !== null && dragIndex.current !== idx) {
                  usePanesStore.setState((s) => {
                    const next = [...s.tabs]
                    const [moved] = next.splice(dragIndex.current!, 1)
                    next.splice(idx, 0, moved)
                    return { tabs: next }
                  })
                }
                dragIndex.current = null
                setDragOverIndex(null)
              }}
              onClick={() => !isRenaming && setActiveTab(tab.id)}
              onAuxClick={(e) => { if (e.button === 1) closeTab(tab.id) }}
              onDoubleClick={() => startRename(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setContextMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
              }}
              style={{
                height: 28,
                padding: '0 8px',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                borderRadius: '4px 4px 0 0',
                backgroundColor: isActive ? '#1e2022' : 'transparent',
                border: isActive ? '1px solid #2a2b2e' : '1px solid transparent',
                borderBottomColor: isActive ? '#4ade80' : 'transparent',
                fontSize: 12,
                color: isActive ? '#e2e4e6' : '#6b7280',
                cursor: 'pointer',
                userSelect: 'none',
                flexShrink: 0,
                outline: dragOverIndex === idx ? '1px dashed #4ade80' : 'none',
                transition: 'color 0.1s',
                position: 'relative',
              }}
            >
              {live && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    backgroundColor: '#4ade80',
                    flexShrink: 0,
                  }}
                />
              )}

              {isRenaming ? (
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                    if (e.key === 'Escape') { e.stopPropagation(); setRenamingTabId(null) }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    background: 'none',
                    border: 'none',
                    outline: '1px solid #4ade80',
                    borderRadius: 2,
                    color: '#e2e4e6',
                    fontSize: 12,
                    padding: '0 2px',
                    width: Math.max(60, renameValue.length * 7 + 16),
                    maxWidth: 140,
                  }}
                />
              ) : (
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: 120,
                  }}
                >
                  {label}
                </span>
              )}

              <button
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#5a5c61',
                  cursor: 'pointer',
                  padding: 0,
                  fontSize: 14,
                  lineHeight: 1,
                  display: 'flex',
                  alignItems: 'center',
                  marginLeft: 2,
                  flexShrink: 0,
                }}
                title="Close tab"
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#e2e4e6' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#5a5c61' }}
              >
                ×
              </button>
            </div>
          )
        })}

        <button
          onClick={() => addTab()}
          title="New tab (Ctrl+T)"
          style={{
            marginLeft: 4,
            width: 24,
            height: 24,
            borderRadius: 4,
            border: '1px dashed #2a2b2e',
            backgroundColor: 'transparent',
            color: '#5a5c61',
            cursor: 'pointer',
            fontSize: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            flexShrink: 0,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#c9cdd1' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#5a5c61' }}
        >
          +
        </button>
      </div>

      <div style={{ width: 1, height: 20, backgroundColor: '#2a2b2e', flexShrink: 0 }} />

      {/* Global action buttons */}
      <BarButton
        onClick={toggleSessionBrowser}
        title="Session browser (Ctrl+Shift+O)"
        active={sessionBrowserOpen}
      >
        ⊞
      </BarButton>
      <BarButton
        onClick={toggleCommandPalette}
        title="Command palette (Ctrl+P)"
        active={commandPaletteOpen}
      >
        ⌕
      </BarButton>

      {/* Context menu (rendered outside tab strip to avoid overflow clipping) */}
      {contextMenu && (
        <div id="tab-context-menu">
          <ContextMenu
            menu={contextMenu}
            tabs={tabs}
            onClose={() => setContextMenu(null)}
            onRename={startRename}
            closeTab={closeTab}
            closeOtherTabs={closeOtherTabs}
            closeTabsToRight={closeTabsToRight}
            duplicateTab={duplicateTab}
          />
        </div>
      )}
    </div>
  )
}
