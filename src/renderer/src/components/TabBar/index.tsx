import React, { useRef, useState, useEffect, useCallback } from 'react'
import { usePanesStore } from '../../store/panes'
import { useSessionsStore } from '../../store/sessions'
import { useSettingsStore } from '../../store/settings'
import type { Tab } from '../../../../shared/types'
import { computeLabels, collectLeaves } from '../../utils/tabLabels'
import { DirPicker } from '../DirPicker'
import { HOTKEYS } from '../../utils/hotkeys'
import { decodePaneDragPayload, PANE_DRAG_MIME } from '../../utils/paneDrag'
import { ui, border } from '../../styles/theme'
import searchIcon from '../../assets/search.png'
import bookIcon from '../../assets/book.png'
import settingsIcon from '../../assets/settings.png'
import leftPanelOpenedIcon from '../../assets/leftpanelopened.png'
import leftPanelClosedIcon from '../../assets/leftpanelclosed.png'
import minimizeIcon from '../../assets/minimize.png'
import maximizeIcon from '../../assets/maximize.png'
import closeIcon from '../../assets/close.png'
import arrowLeftIcon from '../../assets/arrowleft.png'
import arrowRightIcon from '../../assets/arrowright.png'
import newFolderIcon from '../../assets/newfolder.png'

const TAB_DRAG_MIME = 'application/x-multiagent-tab'
const CHROME_DRAG_EXEMPT_SELECTOR = 'button, input, textarea, select, [data-window-drag-exempt="true"]'
const TAB_HEIGHT = 28
const NEW_TAB_BUTTON_SIZE = 24
const TAB_SCROLL_BUTTON_SIZE = NEW_TAB_BUTTON_SIZE

function appRegion(value: 'drag' | 'no-drag'): React.CSSProperties {
  return { WebkitAppRegion: value } as React.CSSProperties
}

function startWindowDrag(e: React.MouseEvent): void {
  if (e.button !== 0) return
  window.ipc.invoke('window:start-drag').catch(() => {})
}

function isWindowDragTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return !target.closest(CHROME_DRAG_EXEMPT_SELECTOR)
}

function startWindowDragFromChrome(e: React.MouseEvent): void {
  if (!isWindowDragTarget(e.target)) return
  startWindowDrag(e)
}

function toggleMaximizeFromChrome(e: React.MouseEvent): void {
  if (!isWindowDragTarget(e.target)) return
  window.ipc.invoke('window:toggle-maximize').catch(console.error)
}

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
        background: active ? ui.color.control : 'none',
        border: 'none',
        color: active ? ui.color.text : ui.color.textDim,
        cursor: 'pointer',
        padding: 0,
        width: ui.chrome.controlSize,
        height: ui.chrome.controlSize,
        fontSize: 16,
        lineHeight: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        borderRadius: ui.radius.md,
        ...appRegion('no-drag'),
      }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.color = ui.color.text
        ;(e.currentTarget as HTMLButtonElement).style.background = ui.color.control
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.color = active ? ui.color.text : ui.color.textDim
        ;(e.currentTarget as HTMLButtonElement).style.background = active ? ui.color.control : 'none'
      }}
    >
      {children}
    </button>
  )
}
function isMacPlatform(): boolean {
  return /Mac/i.test(window.navigator.platform)
}

function isWindowsPlatform(): boolean {
  return /Windows/i.test(window.navigator.userAgent)
}

function WindowControls(): JSX.Element | null {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (isMacPlatform() || isWindowsPlatform()) return
    window.ipc.invoke('window:is-maximized')
      .then((value) => setIsMaximized(value === true))
      .catch(() => {})
    return window.ipc.on('window:maximized-changed', (value) => {
      setIsMaximized(value === true)
    })
  }, [])

  if (isMacPlatform() || isWindowsPlatform()) return null

  const buttonStyle: React.CSSProperties = {
    width: ui.chrome.windowControlWidth,
    height: '100%',
    border: 'none',
    background: 'transparent',
    color: ui.color.textMuted,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    lineHeight: 1,
    cursor: 'default',
    ...appRegion('no-drag'),
  }

  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'stretch', flexShrink: 0, ...appRegion('no-drag') }}>
      <button
        title="Minimize"
        style={buttonStyle}
        onClick={() => { window.ipc.invoke('window:minimize').catch(console.error) }}
        onMouseEnter={(e) => { e.currentTarget.style.background = ui.color.control; e.currentTarget.style.color = ui.color.text }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = ui.color.textMuted }}
      >
        <img src={minimizeIcon} alt="" style={{ width: 12, height: 12, display: 'block' }} />
      </button>
      <button
        title={isMaximized ? 'Restore' : 'Maximize'}
        style={buttonStyle}
        onClick={() => { window.ipc.invoke('window:toggle-maximize').catch(console.error) }}
        onMouseEnter={(e) => { e.currentTarget.style.background = ui.color.control; e.currentTarget.style.color = ui.color.text }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = ui.color.textMuted }}
      >
        <img src={maximizeIcon} alt="" style={{ width: 12, height: 12, display: 'block' }} />
      </button>
      <button
        title="Close"
        style={buttonStyle}
        onClick={() => { window.ipc.invoke('window:close').catch(console.error) }}
        onMouseEnter={(e) => { e.currentTarget.style.background = '#c42b1c'; e.currentTarget.style.color = '#ffffff' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = ui.color.textMuted }}
      >
        <img src={closeIcon} alt="" style={{ width: 12, height: 12, display: 'block', filter: 'brightness(0) invert(1)' }} />
      </button>
    </div>
  )
}

function NewTabButton({
  onClick,
  rowInset = 0,
}: {
  onClick: () => void
  rowInset?: number
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={`New tab (${HOTKEYS.newTab.display})`}
      style={{
        marginLeft: 4,
        width: NEW_TAB_BUTTON_SIZE,
        height: NEW_TAB_BUTTON_SIZE,
        borderRadius: 4,
        border: `1px dashed ${ui.color.border}`,
        backgroundColor: 'transparent',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        flexShrink: 0,
        alignSelf: 'center',
        marginTop: rowInset,
        marginBottom: rowInset,
        ...appRegion('no-drag'),
      }}
    >
      <img src={newFolderIcon} alt="" style={{ width: 16, height: 16, display: 'block' }} />
    </button>
  )
}

function TabScrollButton({
  onClick,
  title,
  icon,
}: {
  onClick: () => void
  title: string
  icon: string
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: TAB_SCROLL_BUTTON_SIZE,
        height: TAB_SCROLL_BUTTON_SIZE,
        border: border.default,
        background: 'transparent',
        cursor: 'pointer',
        padding: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        ...appRegion('no-drag'),
      }}
    >
      <img src={icon} alt="" style={{ width: 18, height: 18, display: 'block' }} />
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

// --- LeftChrome ---
// Exported so App.tsx can render it in a separate column in wrap mode.

export function LeftChrome({ withBorderBottom = false }: { withBorderBottom?: boolean }): JSX.Element {
  const sidebarOpen = usePanesStore((s) => s.sidebarOpen)
  const sidebarWidth = usePanesStore((s) => s.sidebarWidth)
  const toggleSidebar = usePanesStore((s) => s.toggleSidebar)
  const toggleSessionBrowser = usePanesStore((s) => s.toggleSessionBrowser)
  const toggleCommandPalette = usePanesStore((s) => s.toggleCommandPalette)
  const toggleSettings = usePanesStore((s) => s.toggleSettings)
  const sessionBrowserOpen = usePanesStore((s) => s.sessionBrowserOpen)
  const commandPaletteOpen = usePanesStore((s) => s.commandPaletteOpen)
  const settingsOpen = usePanesStore((s) => s.settingsOpen)

  const isMac = isMacPlatform()
  const leftChromePadding = 4
  const controlClusterWidth = ui.chrome.controlSize * 4 + 8
  const leftChromeWidth = sidebarOpen ? sidebarWidth : controlClusterWidth + (isMac ? 80 : 0)

  return (
    <div
      onMouseDownCapture={startWindowDragFromChrome}
      onDoubleClickCapture={toggleMaximizeFromChrome}
      style={{
        width: leftChromeWidth,
        minWidth: leftChromeWidth,
        height: ui.chrome.height,
        boxSizing: 'border-box',
        backgroundColor: ui.chrome.background,
        paddingLeft: isMac ? 80 : leftChromePadding,
        paddingRight: leftChromePadding,
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        borderRight: border.default,
        borderBottom: withBorderBottom ? border.default : undefined,
        overflow: 'hidden',
        flexShrink: 0,
        ...appRegion('drag'),
      }}
    >
      <BarButton
        onClick={toggleSidebar}
        title={sidebarOpen ? `Collapse sidebar (${HOTKEYS.toggleSidebar.display})` : `Open sidebar (${HOTKEYS.toggleSidebar.display})`}
      >
        <img src={sidebarOpen ? leftPanelClosedIcon : leftPanelOpenedIcon} alt="" style={{ width: 16, height: 16, display: 'block' }} />
      </BarButton>
      <BarButton
        onClick={toggleSessionBrowser}
        title={`Session browser (${HOTKEYS.sessionBrowser.display})`}
        active={sessionBrowserOpen}
      >
        <img src={bookIcon} alt="" style={{ width: 16, height: 16, display: 'block' }} />
      </BarButton>
      <BarButton
        onClick={toggleCommandPalette}
        title={`Command palette (${HOTKEYS.commandPalette.display})`}
        active={commandPaletteOpen}
      >
        <img src={searchIcon} alt="" style={{ width: 16, height: 16, display: 'block' }} />
      </BarButton>
      <BarButton
        onClick={toggleSettings}
        title="Settings"
        active={settingsOpen}
      >
        <img src={settingsIcon} alt="" style={{ width: 16, height: 16, display: 'block' }} />
      </BarButton>
    </div>
  )
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
  const sidebarWidth = usePanesStore((s) => s.sidebarWidth)
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
  const tabOverflowMode = useSettingsStore((s) => s.tabOverflowMode)
  const isMac = isMacPlatform()
  const isWindows = isWindowsPlatform()
  const leftChromePadding = 4
  const controlClusterWidth = ui.chrome.controlSize * 4 + 8
  const leftChromeWidth = sidebarOpen ? sidebarWidth : controlClusterWidth + (isMac ? 80 : 0)
  const nativeWindowControlsWidth = isWindows ? ui.chrome.windowControlWidth * 3 : 0

  const labels = computeLabels(tabs, sessions)
  const stripNativeAppRegion = appRegion(tabOverflowMode === 'wrap' ? 'drag' : 'no-drag')
  const tabNativeAppRegion = tabOverflowMode === 'wrap' ? appRegion('no-drag') : {}
  const chromeRowHeight = isDetachedWindow ? ui.chrome.detachedHeight : ui.chrome.height
  const chromeContentHeight = chromeRowHeight - 1
  const tabRowInset = tabOverflowMode === 'wrap' ? Math.max(0, (chromeContentHeight - TAB_HEIGHT) / 2) : 0
  const newTabRowInset = tabOverflowMode === 'wrap' ? Math.max(0, (chromeContentHeight - NEW_TAB_BUTTON_SIZE) / 2) : 0

  // Scroll mode arrow state
  const stripRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const updateScrollState = useCallback(() => {
    const strip = stripRef.current
    if (!strip || tabOverflowMode !== 'scroll') {
      setCanScrollLeft(false)
      setCanScrollRight(false)
      return
    }
    setCanScrollLeft(strip.scrollLeft > 0)
    setCanScrollRight(strip.scrollLeft < strip.scrollWidth - strip.clientWidth - 1)
  }, [tabOverflowMode])

  const scrollTabsBy = useCallback((delta: number) => {
    const strip = stripRef.current
    if (strip) strip.scrollBy({ left: delta, behavior: 'smooth' })
  }, [])

  const handleStripWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (tabOverflowMode !== 'scroll') return
    const strip = stripRef.current
    if (!strip || strip.scrollWidth <= strip.clientWidth) return

    const rawDelta = e.deltaY !== 0 ? e.deltaY : e.deltaX
    if (rawDelta === 0) return

    const delta = e.deltaMode === 1
      ? rawDelta * 16
      : e.deltaMode === 2
        ? rawDelta * strip.clientWidth
        : rawDelta

    e.preventDefault()
    strip.scrollLeft += delta
    window.requestAnimationFrame(updateScrollState)
  }, [tabOverflowMode, updateScrollState])

  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    strip.addEventListener('scroll', updateScrollState, { passive: true })
    const ro = new ResizeObserver(updateScrollState)
    ro.observe(strip)
    return () => {
      strip.removeEventListener('scroll', updateScrollState)
      ro.disconnect()
    }
  }, [updateScrollState])

  useEffect(() => {
    updateScrollState()
  }, [tabs.length, sidebarOpen, tabOverflowMode, updateScrollState])

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
    if (tabOverflowMode === 'wrap') return
    const el = tabRefs.current.get(activeTabId)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId, tabOverflowMode])

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
      onMouseDownCapture={startWindowDragFromChrome}
      onDoubleClickCapture={toggleMaximizeFromChrome}
      style={{
        height: tabOverflowMode === 'wrap' ? 'auto' : chromeRowHeight,
        minHeight: tabOverflowMode === 'wrap' ? chromeRowHeight : undefined,
        boxSizing: 'border-box',
        // In wrap mode the root is transparent — each child carries its own background so the
        // left chrome area does not visually grow beyond the first row.
        backgroundColor: tabOverflowMode === 'wrap' ? 'transparent' : (isDetachedWindow ? ui.chrome.backgroundDetached : ui.chrome.background),
        borderBottom: border.default,
        display: 'flex',
        alignItems: tabOverflowMode === 'wrap' ? 'flex-start' : 'center',
        flexShrink: 0,
        overflow: tabOverflowMode === 'wrap' ? 'visible' : 'hidden',
        paddingLeft: isDetachedWindow && isMac ? 80 : 0,
        ...appRegion('drag'),
      }}
    >
      {/* Sidebar toggle — hidden in detached windows and in wrap mode (rendered by App.tsx in a separate column) */}
      {!isDetachedWindow && tabOverflowMode !== 'wrap' && (
        <div
          style={{
            width: leftChromeWidth,
            minWidth: leftChromeWidth,
            height: chromeContentHeight,
            backgroundColor: isDetachedWindow ? ui.chrome.backgroundDetached : ui.chrome.background,
            paddingLeft: isMac ? 80 : leftChromePadding,
            paddingRight: leftChromePadding,
            display: 'flex',
            alignItems: 'center',
            gap: 0,
            borderRight: border.default,
            overflow: 'hidden',
            flexShrink: 0,
            ...appRegion('drag'),
          }}
        >
          <BarButton
            onClick={toggleSidebar}
            title={sidebarOpen ? `Collapse sidebar (${HOTKEYS.toggleSidebar.display})` : `Open sidebar (${HOTKEYS.toggleSidebar.display})`}
          >
            <img src={sidebarOpen ? leftPanelClosedIcon : leftPanelOpenedIcon} alt="" style={{ width: 16, height: 16, display: 'block' }} />
          </BarButton>
          <BarButton
            onClick={toggleSessionBrowser}
            title={`Session browser (${HOTKEYS.sessionBrowser.display})`}
            active={sessionBrowserOpen}
          >
            <img src={bookIcon} alt="" style={{ width: 16, height: 16, display: 'block' }} />
          </BarButton>
          <BarButton
            onClick={toggleCommandPalette}
            title={`Command palette (${HOTKEYS.commandPalette.display})`}
            active={commandPaletteOpen}
          >
            <img src={searchIcon} alt="" style={{ width: 16, height: 16, display: 'block' }} />
          </BarButton>
          <BarButton
            onClick={toggleSettings}
            title="Settings"
            active={settingsOpen}
          >
            <img src={settingsIcon} alt="" style={{ width: 16, height: 16, display: 'block' }} />
          </BarButton>
        </div>
      )}

      {/* Tab strip wrapper — relative-positioned for arrow buttons */}
      <div
        style={{
          position: 'relative',
          flex: tabOverflowMode === 'wrap' ? '1 1 0%' : '0 1 auto',
          minWidth: 0,
          maxWidth: tabOverflowMode === 'wrap' ? undefined : '100%',
          height: tabOverflowMode === 'wrap' ? 'auto' : chromeContentHeight,
          alignSelf: tabOverflowMode === 'wrap' ? 'flex-start' : undefined,
          backgroundColor: tabOverflowMode === 'wrap' ? (isDetachedWindow ? ui.chrome.backgroundDetached : ui.chrome.background) : undefined,
          display: 'flex',
          alignItems: 'center',
          overflow: tabOverflowMode === 'wrap' ? 'visible' : 'hidden',
          ...appRegion('drag'),
        }}
      >
        {/* In scroll mode, keep the native no-drag region on the fixed strip box;
            scrolled tab children use React hit testing so their regions cannot leak left. */}
        <div
          ref={stripRef}
          className="tab-strip"
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            flexWrap: tabOverflowMode === 'wrap' ? 'wrap' : 'nowrap',
            gap: 2,
            overflowX: tabOverflowMode === 'wrap' ? 'visible' : 'auto',
            overflowY: tabOverflowMode === 'wrap' ? 'visible' : 'hidden',
            paddingLeft: isDetachedWindow ? 0 : 2,
            paddingRight: 6,
            minHeight: chromeContentHeight,
            ...stripNativeAppRegion,
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
          onWheel={handleStripWheel}
        >
        {tabs.filter((t) => !t.detached).map((tab, idx) => {
          const isActive = tab.id === activeTabId
          const label = labels.get(tab.id) ?? 'Shell'
          const live = hasAgentPane(tab)
          const isRenaming = renamingTabId === tab.id

          return (
            <div
              key={tab.id}
              data-window-drag-exempt="true"
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
              onDoubleClick={(e) => { e.stopPropagation(); startRename(tab.id) }}
              onContextMenu={(e) => {
                e.preventDefault()
                setContextMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
              }}
              style={{
                height: TAB_HEIGHT,
                boxSizing: 'border-box',
                minWidth: 86,
                maxWidth: 180,
                padding: '0 9px',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                borderRadius: '6px 6px 0 0',
                backgroundColor: isActive ? ui.chrome.tabActive : 'transparent',
                borderTop: isActive ? border.default : '1px solid transparent',
                borderBottom: isActive ? `2px solid ${ui.color.accent}` : '1px solid transparent',
                borderLeft: dragOverIndex === idx && dragSide === 'left'
                  ? `2px solid ${ui.color.accent}`
                  : isActive ? border.default : '1px solid transparent',
                borderRight: dragOverIndex === idx && dragSide === 'right'
                  ? `2px solid ${ui.color.accent}`
                  : isActive ? border.default : '1px solid transparent',
                outline: paneDropTabId === tab.id ? border.accent : 'none',
                outlineOffset: -1,
                fontSize: 12,
                color: isActive ? ui.color.textStrong : ui.color.textMuted,
                cursor: 'pointer',
                userSelect: 'none',
                flexShrink: 0,
                transition: 'color 0.1s',
                position: 'relative',
                marginTop: tabRowInset,
                marginBottom: tabRowInset,
                ...tabNativeAppRegion,
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.backgroundColor = ui.chrome.tabInactiveHover
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.backgroundColor = 'transparent'
              }}
            >
              {live && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    backgroundColor: ui.color.accent,
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
                    outline: border.accent,
                    borderRadius: 2,
                    color: ui.color.textStrong,
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
                      minWidth: 0,
                      flex: 1,
                    }}
                  >
                    {label}
                  </span>
                </>
              )}

              <button
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  display: 'flex',
                  alignItems: 'center',
                  marginLeft: 2,
                  flexShrink: 0,
                  ...tabNativeAppRegion,
                }}
                title="Close tab"
              >
                <img src={closeIcon} alt="" style={{ width: 10, height: 10, display: 'block', opacity: 0.5 }} />
              </button>
            </div>
          )
        })}

        <NewTabButton
          rowInset={newTabRowInset}
          onClick={() => { const id = addTab(); startRename(id) }}
        />

        </div>{/* end tab-strip */}

        {tabOverflowMode === 'scroll' && canScrollLeft && (
          <div style={{
            position: 'absolute',
            left: 0,
            top: 0,
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            background: `linear-gradient(to right, ${isDetachedWindow ? ui.chrome.backgroundDetached : ui.chrome.background} 55%, transparent)`,
            paddingRight: 4,
            pointerEvents: 'none',
          }}>
            <div style={{ pointerEvents: 'auto' }}>
              <TabScrollButton
                onClick={() => scrollTabsBy(-(stripRef.current?.clientWidth ?? 0) * 0.8)}
                title="Scroll tabs left"
                icon={arrowLeftIcon}
              />
            </div>
          </div>
        )}

        {tabOverflowMode === 'scroll' && canScrollRight && (
          <div style={{
            position: 'absolute',
            right: 0,
            top: 0,
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            background: `linear-gradient(to left, ${isDetachedWindow ? ui.chrome.backgroundDetached : ui.chrome.background} 55%, transparent)`,
            paddingLeft: 4,
            pointerEvents: 'none',
          }}>
            <div style={{ pointerEvents: 'auto' }}>
              <TabScrollButton
                onClick={() => scrollTabsBy((stripRef.current?.clientWidth ?? 0) * 0.8)}
                title="Scroll tabs right"
                icon={arrowRightIcon}
              />
            </div>
          </div>
        )}
      </div>{/* end strip wrapper */}

      <div
        style={{
          flex: tabOverflowMode === 'wrap' ? 0 : 1,
          minWidth: tabOverflowMode === 'wrap' ? 0 : 24,
          height: chromeContentHeight,
          alignSelf: tabOverflowMode === 'wrap' ? 'flex-start' : undefined,
          backgroundColor: isDetachedWindow ? ui.chrome.backgroundDetached : ui.chrome.background,
          ...appRegion('drag'),
        }}
      />
      {nativeWindowControlsWidth > 0 && (
        <div style={{
          width: nativeWindowControlsWidth,
          height: tabOverflowMode === 'wrap' ? undefined : (isDetachedWindow ? ui.chrome.detachedHeight : ui.chrome.height),
          alignSelf: tabOverflowMode === 'wrap' ? 'stretch' : undefined,
          flexShrink: 0,
          backgroundColor: isDetachedWindow ? ui.chrome.backgroundDetached : ui.chrome.background,
        }} />
      )}
      <WindowControls />

      {/* Context menu (rendered outside tab strip to avoid overflow clipping) */}
      {contextMenu && (
        <div id="tab-context-menu" data-window-drag-exempt="true" style={appRegion('no-drag')}>
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
        <div data-window-drag-exempt="true" style={appRegion('no-drag')}>
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
        </div>
      )}
    </div>
  )
}
