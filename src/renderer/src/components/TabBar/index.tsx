import React, { useRef, useState, useEffect, useCallback } from 'react'
import { usePanesStore } from '../../store/panes'
import { useSessionsStore } from '../../store/sessions'
import type { Tab } from '../../../../shared/types'
import { computeLabels, collectLeaves } from '../../utils/tabLabels'
import { DirPicker } from '../DirPicker'
import { HOTKEYS } from '../../utils/hotkeys'
import { useGitBranch } from '../../hooks/useGitBranch'
import { useSettingsStore } from '../../store/settings'
import { decodePaneDragPayload, PANE_DRAG_MIME } from '../../utils/paneDrag'
import searchIcon from '../../assets/search.png'
import commandPaletteIcon from '../../assets/commandpallete.png'
import settingsIcon from '../../assets/settings.png'

const TAB_DRAG_MIME = 'application/x-multiagent-tab'

function collectPtyIds(tab: Tab): string[] {
  if (!tab.rootNode) return []
  return collectLeaves(tab.rootNode)
    .map((l) => l.ptyId)
    .filter((id): id is string => typeof id === 'string')
}

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
  isDetachedWindow,
  onClose,
  onRename,
  onChangeDefaultDir,
  closeTab,
  closeOtherTabs,
  closeTabsToRight,
  duplicateTab,
}: {
  menu: ContextMenuState
  tabs: Tab[]
  isDetachedWindow: boolean
  onClose: () => void
  onRename: (tabId: string) => void
  onChangeDefaultDir: (tabId: string) => void
  closeTab: (id: string) => void
  closeOtherTabs: (id: string) => void
  closeTabsToRight: (id: string) => void
  duplicateTab: (id: string) => void
}): JSX.Element {
  const idx = tabs.findIndex((t) => t.id === menu.tabId)
  const hasRight = idx < tabs.length - 1
  const hasOthers = tabs.length > 1
  const tab = tabs[idx]
  const defaultDirLabel = tab?.defaultCwd
    ? `Change Default Directory  (${tab.defaultCwd.split(/[\\/]/).pop()})`
    : 'Set Default Directory'

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
        minWidth: 210,
        boxShadow: '0 8px 24px rgba(0,0,0,0.55)',
      }}
    >
      {item('Rename Tab', () => { onRename(menu.tabId); onClose() })}
      {item(defaultDirLabel, () => { onChangeDefaultDir(menu.tabId); onClose() })}
      {separator()}
      {isDetachedWindow
        ? item('Reattach to Main Window', () => { reattachHome(menu.tabId); onClose() })
        : item('Move Tab to New Window', () => { tearOffTab(menu.tabId, tabs); onClose() })}
      {separator()}
      {item('Close Tab', () => { closeTab(menu.tabId); onClose() })}
      {item('Close Other Tabs', () => { closeOtherTabs(menu.tabId); onClose() }, !hasOthers)}
      {item('Close Tabs to the Right', () => { closeTabsToRight(menu.tabId); onClose() }, !hasRight)}
      {separator()}
      {item('Duplicate Tab', () => { duplicateTab(menu.tabId); onClose() })}
    </div>
  )
}

// Move a detached window's own tab back to the primary window. Main sends this
// window tab:release (which removes it locally) and the primary tab:return.
function reattachHome(tabId: string): void {
  window.ipc.invoke('tab:reattach-home', tabId).catch(console.error)
}

function tearOffTab(tabId: string, tabs: Tab[]): void {
  const tab = tabs.find((t) => t.id === tabId)
  if (!tab) return
  const ptyIds = collectPtyIds(tab)
  const cx = window.screenX + Math.floor(window.outerWidth / 2)
  const cy = window.screenY + 40
  window.ipc.invoke('tab:tear-off', JSON.stringify(tab), ptyIds, cx, cy)
    .then((result) => {
      const store = usePanesStore.getState()
      const ownerWindowId = typeof result === 'object' && result !== null && 'windowId' in result && typeof result.windowId === 'number'
        ? result.windowId
        : undefined
      // In a detached window the tab moves to a brand-new window — remove it
      // locally rather than marking it as detached (which would corrupt the sync).
      // In the primary window, keep it as detached so the sidebar can show it.
      if (store.isDetachedWindow) {
        store.removeTabLocally(tabId)
      } else {
        store.detachTab(tabId, ownerWindowId)
      }
    })
    .catch(console.error)
}

// --- TabBar ---

export function TabBar(): JSX.Element {
  const tabs = usePanesStore((s) => s.tabs)
  const activeTabId = usePanesStore((s) => s.activeTabId)
  const windowId = usePanesStore((s) => s.windowId)
  const setActiveTab = usePanesStore((s) => s.setActiveTab)
  const closeTab = usePanesStore((s) => s.closeTab)
  const addTab = usePanesStore((s) => s.addTab)
  const setTabDefaultCwd = usePanesStore((s) => s.setTabDefaultCwd)
  const renameTab = usePanesStore((s) => s.renameTab)
  const duplicateTab = usePanesStore((s) => s.duplicateTab)
  const closeOtherTabs = usePanesStore((s) => s.closeOtherTabs)
  const closeTabsToRight = usePanesStore((s) => s.closeTabsToRight)
  const sidebarOpen = usePanesStore((s) => s.sidebarOpen)
  const toggleSidebar = usePanesStore((s) => s.toggleSidebar)
  const toggleSessionBrowser = usePanesStore((s) => s.toggleSessionBrowser)
  const toggleCommandPalette = usePanesStore((s) => s.toggleCommandPalette)
  const toggleSettings = usePanesStore((s) => s.toggleSettings)
  const sessionBrowserOpen = usePanesStore((s) => s.sessionBrowserOpen)
  const commandPaletteOpen = usePanesStore((s) => s.commandPaletteOpen)
  const settingsOpen = usePanesStore((s) => s.settingsOpen)
  const draggedPaneId = usePanesStore((s) => s.draggedPaneId)
  const movePaneToTab = usePanesStore((s) => s.movePaneToTab)
  const receiveTab = usePanesStore((s) => s.receiveTab)
  const detachTab = usePanesStore((s) => s.detachTab)
  const isDetachedWindow = usePanesStore((s) => s.isDetachedWindow)
  const sessions = useSessionsStore((s) => s.sessions)

  const labels = computeLabels(tabs, sessions)

  // Intra-window tab reorder state
  const dragIndex = useRef<number | null>(null)
  const dragSideRef = useRef<'left' | 'right' | null>(null)
  const hoverActivateTimer = useRef<number | null>(null)
  const hoverActivateTabId = useRef<string | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [dragSide, setDragSide] = useState<'left' | 'right' | null>(null)
  const [paneDropTabId, setPaneDropTabId] = useState<string | null>(null)
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  // Track whether the current drag was handled by a drop inside this window's tab bar
  const droppedInsideRef = useRef(false)
  // Cache all window bounds fetched on drag start for use in dragend
  const allWindowBoundsRef = useRef<{ id: number; x: number; y: number; width: number; height: number }[]>([])
  // The tab being dragged (for tear-off)
  const draggingTabRef = useRef<Tab | null>(null)

  useEffect(() => {
    const el = tabRefs.current.get(activeTabId)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId])

  useEffect(() => {
    return () => {
      if (hoverActivateTimer.current !== null) window.clearTimeout(hoverActivateTimer.current)
    }
  }, [])

  // Rename state
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  // Directory picker state: string = change default for that tabId
  const [dirPickerState, setDirPickerState] = useState<string | null>(null)

  const dirPickerTab = typeof dirPickerState === 'string'
    ? tabs.find((t) => t.id === dirPickerState)
    : null

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

  function hasAgentPane(tab: Tab): boolean {
    if (!tab.rootNode) return false
    return collectLeaves(tab.rootNode).some((l) => l.paneType === 'agent')
  }

  function clearPaneDragHover(): void {
    if (hoverActivateTimer.current !== null) {
      window.clearTimeout(hoverActivateTimer.current)
      hoverActivateTimer.current = null
    }
    hoverActivateTabId.current = null
    setPaneDropTabId(null)
  }

  function schedulePaneDragActivation(tabId: string): void {
    if (tabId === activeTabId) return
    if (hoverActivateTabId.current === tabId) return
    if (hoverActivateTimer.current !== null) window.clearTimeout(hoverActivateTimer.current)
    hoverActivateTabId.current = tabId
    hoverActivateTimer.current = window.setTimeout(() => {
      setActiveTab(tabId)
      hoverActivateTimer.current = null
      hoverActivateTabId.current = null
    }, 500)
  }

  function resetDragState(): void {
    dragIndex.current = null
    dragSideRef.current = null
    draggingTabRef.current = null
    droppedInsideRef.current = false
    setDragOverIndex(null)
    setDragSide(null)
    clearPaneDragHover()
  }

  // Handle a cross-window tab drop onto this window's tab bar.
  // dropIndex is the visual insertion index among local tabs (undefined = append at end).
  function handleCrossWindowDrop(e: React.DragEvent, dropIndex?: number): boolean {
    const data = e.dataTransfer.getData(TAB_DRAG_MIME)
    if (!data) return false
    try {
      const { tab, ptyIds, sourceWindowId } = JSON.parse(data) as {
        tab: Tab
        ptyIds: string[]
        sourceWindowId: number | null
      }
      if (sourceWindowId === windowId) return false // Same window — let normal reorder handle it
      e.preventDefault()
      e.stopPropagation()
      receiveTab(tab, dropIndex)
      window.ipc.invoke('tab:absorb', JSON.stringify(tab), ptyIds, sourceWindowId ?? -1)
        .then((ok) => {
          if (!ok) usePanesStore.getState().removeTabLocally(tab.id)
        })
        .catch(console.error)
      return true
    } catch {
      return false
    }
  }

  function handlePaneDrop(e: React.DragEvent, targetTabId: string): boolean {
    const payload = decodePaneDragPayload(e.dataTransfer)
    if (!payload || windowId === null) return false
    e.preventDefault()
    e.stopPropagation()
    if (payload.sourceWindowId === windowId) {
      movePaneToTab(payload.pane.id, targetTabId)
    } else {
      window.ipc.invoke('pane:transfer', { ...payload, targetTabId, targetWindowId: windowId }).catch(console.error)
    }
    clearPaneDragHover()
    return true
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
      {/* Sidebar toggle — hidden in detached windows (content-only mode) */}
      {!isDetachedWindow && (
        <>
          <BarButton
            onClick={toggleSidebar}
            title={sidebarOpen ? `Collapse sidebar (${HOTKEYS.toggleSidebar.display})` : `Open sidebar (${HOTKEYS.toggleSidebar.display})`}
            active={sidebarOpen}
          >
            ≡
          </BarButton>
          <div style={{ width: 1, height: 20, backgroundColor: '#2a2b2e', flexShrink: 0 }} />
        </>
      )}

      {/* Tab strip — also accepts cross-window tab drops */}
      <div
        className="tab-strip"
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          overflowX: 'auto',
          overflowY: 'hidden',
          paddingLeft: 6,
          paddingRight: 6,
        }}
        onDragOver={(e) => {
          // Accept cross-window tab drops on the strip background
          if (e.dataTransfer.types.includes(TAB_DRAG_MIME) || e.dataTransfer.types.includes(PANE_DRAG_MIME)) {
            e.preventDefault()
          }
        }}
        onDrop={(e) => {
          handleCrossWindowDrop(e)
        }}
      >
        {tabs.filter((t) => !t.detached).map((tab, idx) => {
          const isActive = tab.id === activeTabId
          const label = labels.get(tab.id) ?? 'Shell'
          const live = hasAgentPane(tab)
          const isRenaming = renamingTabId === tab.id

          return (
            <div
              key={tab.id}
              ref={(el) => { if (el) tabRefs.current.set(tab.id, el); else tabRefs.current.delete(tab.id) }}
              draggable={!isRenaming}
              onMouseDown={() => {
                // Pre-fetch all window bounds before drag starts (async, completes before dragend fires)
                window.ipc.invoke('window:get-all-bounds')
                  .then((b) => { allWindowBoundsRef.current = b as typeof allWindowBoundsRef.current })
                  .catch(() => {})
              }}
              onDragStart={(e) => {
                dragIndex.current = idx
                draggingTabRef.current = tab
                droppedInsideRef.current = false
                // Embed tab data for cross-window drops
                const ptyIds = collectPtyIds(tab)
                e.dataTransfer.setData(TAB_DRAG_MIME, JSON.stringify({ tab, ptyIds, sourceWindowId: windowId }))
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                if (draggedPaneId) {
                  e.preventDefault()
                  e.stopPropagation()
                  setPaneDropTabId(tab.id)
                  schedulePaneDragActivation(tab.id)
                  return
                }
                if (e.dataTransfer.types.includes(PANE_DRAG_MIME)) {
                  e.preventDefault()
                  e.stopPropagation()
                  setPaneDropTabId(tab.id)
                  return
                }
                // Accept cross-window tab drop
                if (e.dataTransfer.types.includes(TAB_DRAG_MIME)) {
                  e.preventDefault()
                  e.stopPropagation()
                }
                const rect = e.currentTarget.getBoundingClientRect()
                const side = e.clientX - rect.left < rect.width / 2 ? 'left' : 'right'
                dragSideRef.current = side
                setDragOverIndex(idx)
                setDragSide(side)
              }}
              onDragLeave={(e) => {
                if (draggedPaneId || e.dataTransfer.types.includes(PANE_DRAG_MIME)) {
                  clearPaneDragHover()
                  return
                }
                setDragOverIndex(null); setDragSide(null)
              }}
              onDragEnd={(e) => {
                const draggedTab = draggingTabRef.current

                if (droppedInsideRef.current) {
                  resetDragState()
                  return
                }

                // Check if the drop landed outside this window
                const winX = window.screenX
                const winY = window.screenY
                const winW = window.outerWidth
                const winH = window.outerHeight
                const insideThis = (
                  e.screenX >= winX && e.screenX <= winX + winW &&
                  e.screenY >= winY && e.screenY <= winY + winH
                )

                if (insideThis) {
                  // Dropped inside this window but not on a drop target — cancel
                  resetDragState()
                  return
                }

                // Check if dropped on another app window
                const insideOtherWindow = allWindowBoundsRef.current
                  .filter((b) => b.id !== windowId)
                  .some((b) =>
                    e.screenX >= b.x && e.screenX <= b.x + b.width &&
                    e.screenY >= b.y && e.screenY <= b.y + b.height
                  )

                if (insideOtherWindow) {
                  // The target window's onDrop will call tab:absorb which triggers tab:release on us.
                  resetDragState()
                  return
                }

                // Dropped outside all windows — tear off into a new window
                if (draggedTab) {
                  const ptyIds = collectPtyIds(draggedTab)
                  resetDragState()
                  window.ipc.invoke('tab:tear-off', JSON.stringify(draggedTab), ptyIds, e.screenX, e.screenY)
                    .then((result) => {
                      const ownerWindowId = typeof result === 'object' && result !== null && 'windowId' in result && typeof result.windowId === 'number'
                        ? result.windowId
                        : undefined
                      if (isDetachedWindow) {
                        usePanesStore.getState().removeTabLocally(draggedTab.id)
                      } else {
                        detachTab(draggedTab.id, ownerWindowId)
                      }
                    })
                    .catch(console.error)
                } else {
                  resetDragState()
                }
              }}
              onDrop={(e) => {
                // Handle cross-window drop first, honoring the cursor position.
                // dragSideRef is set by onDragOver on this element regardless of drag source.
                const crossSide = dragSideRef.current ?? 'right'
                const crossDropIndex = crossSide === 'right' ? idx + 1 : idx
                if (handleCrossWindowDrop(e, crossDropIndex)) {
                  droppedInsideRef.current = true
                  return
                }

                if (handlePaneDrop(e, tab.id)) {
                  droppedInsideRef.current = true
                  return
                }

                droppedInsideRef.current = true

                if (draggedPaneId) {
                  e.preventDefault()
                  e.stopPropagation()
                  movePaneToTab(draggedPaneId, tab.id)
                  clearPaneDragHover()
                  return
                }
                const from = dragIndex.current
                const side = dragSideRef.current
                const targetTabId = tab.id
                if (from !== null && from !== idx) {
                  usePanesStore.setState((s) => {
                    const next = [...s.tabs]
                    const [moved] = next.splice(from, 1)
                    const newTargetIdx = next.findIndex((t) => t.id === targetTabId)
                    const insertAt = side === 'right' ? newTargetIdx + 1 : newTargetIdx
                    next.splice(Math.max(0, insertAt), 0, moved)
                    return { tabs: next }
                  })
                }
                dragIndex.current = null
                dragSideRef.current = null
                setDragOverIndex(null)
                setDragSide(null)
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
                borderTop: isActive ? '1px solid #2a2b2e' : '1px solid transparent',
                borderBottom: isActive ? '1px solid #4ade80' : '1px solid transparent',
                borderLeft: dragOverIndex === idx && dragSide === 'left'
                  ? '2px solid #4ade80'
                  : isActive ? '1px solid #2a2b2e' : '1px solid transparent',
                borderRight: dragOverIndex === idx && dragSide === 'right'
                  ? '2px solid #4ade80'
                  : isActive ? '1px solid #2a2b2e' : '1px solid transparent',
                outline: paneDropTabId === tab.id ? '1px solid #4ade80' : 'none',
                outlineOffset: -1,
                fontSize: 12,
                color: isActive ? '#e2e4e6' : '#6b7280',
                cursor: 'pointer',
                userSelect: 'none',
                flexShrink: 0,
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
                <>
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
                  <TabBranchBadge cwd={tab.defaultCwd} />
                </>
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
          onClick={() => { const id = addTab(); startRename(id) }}
          title={`New tab (${HOTKEYS.newTab.display})`}
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
        title={`Session browser (${HOTKEYS.sessionBrowser.display})`}
        active={sessionBrowserOpen}
      >
        <img src={searchIcon} alt="Search" style={{ width: 16, height: 16, display: 'block' }} />
      </BarButton>
      <BarButton
        onClick={toggleCommandPalette}
        title={`Command palette (${HOTKEYS.commandPalette.display})`}
        active={commandPaletteOpen}
      >
        <img src={commandPaletteIcon} alt="Command palette" style={{ width: 16, height: 16, display: 'block' }} />
      </BarButton>
      <BarButton
        onClick={toggleSettings}
        title="Settings"
        active={settingsOpen}
      >
        <img src={settingsIcon} alt="Settings" style={{ width: 16, height: 16, display: 'block' }} />
      </BarButton>

      {/* Context menu (rendered outside tab strip to avoid overflow clipping) */}
      {contextMenu && (
        <div id="tab-context-menu">
          <ContextMenu
            menu={contextMenu}
            tabs={tabs.filter((t) => !t.detached)}
            isDetachedWindow={isDetachedWindow}
            onClose={() => setContextMenu(null)}
            onRename={startRename}
            onChangeDefaultDir={(tabId) => setDirPickerState(tabId)}
            closeTab={closeTab}
            closeOtherTabs={closeOtherTabs}
            closeTabsToRight={closeTabsToRight}
            duplicateTab={duplicateTab}
          />
        </div>
      )}

      {/* Directory picker — change default for existing tab */}
      {dirPickerState !== null && (
        <DirPicker
          title="Change default directory"
          description="New sessions and shells in this tab will start here by default."
          initial={dirPickerTab?.defaultCwd ?? ''}
          confirmLabel="Change"
          skipLabel="Cancel"
          autoBrowse
          onConfirm={(dir) => { setTabDefaultCwd(dirPickerState, dir); setDirPickerState(null) }}
          onSkip={() => setDirPickerState(null)}
        />
      )}
    </div>
  )
}

function TabBranchBadge({ cwd }: { cwd?: string }): JSX.Element | null {
  const showGitBranchBadges = useSettingsStore((s) => s.showGitBranchBadges)
  const branch = useGitBranch(cwd, showGitBranchBadges && !!cwd)
  if (!showGitBranchBadges || !cwd || !branch) return null

  return (
    <span
      title={`${cwd}\n${branch}`}
      style={{
        fontSize: 10,
        color: '#8a8a8a',
        backgroundColor: '#191a1d',
        border: '1px solid #2a2b2e',
        borderRadius: 3,
        padding: '0 4px',
        lineHeight: '14px',
        maxWidth: 72,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flexShrink: 1,
      }}
    >
      {branch}
    </span>
  )
}
