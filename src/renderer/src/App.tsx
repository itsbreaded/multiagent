import { useEffect, useState, useCallback } from 'react'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { PaneGrid } from './components/PaneGrid'
import { SessionBrowser } from './components/SessionBrowser'
import { CommandPalette } from './components/CommandPalette'
import { RestorePrompt } from './components/RestorePrompt'
import { usePanesStore } from './store/panes'
import { HOTKEYS, hotkeyKey, eventKey } from './utils/hotkeys'
import type { Tab } from '../../shared/types'

function useGlobalKeyboard() {
  const addTab = usePanesStore((s) => s.addTab)
  const closeTab = usePanesStore((s) => s.closeTab)
  const activeTabId = usePanesStore((s) => s.activeTabId)
  const splitPane = usePanesStore((s) => s.splitPane)
  const closePane = usePanesStore((s) => s.closePane)
  const zoomPane = usePanesStore((s) => s.zoomPane)
  const unzoom = usePanesStore((s) => s.unzoom)
  const zoomedPaneId = usePanesStore((s) => s.zoomedPaneId)
  const toggleSidebar = usePanesStore((s) => s.toggleSidebar)
  const toggleCommandPalette = usePanesStore((s) => s.toggleCommandPalette)
  const toggleSessionBrowser = usePanesStore((s) => s.toggleSessionBrowser)
  const closeOverlays = usePanesStore((s) => s.closeOverlays)
  const getFocusedPane = usePanesStore((s) => s.getFocusedPane)

  useEffect(() => {
    const dispatch: Record<string, () => void> = {
      [hotkeyKey(HOTKEYS.newTab)]:          () => addTab(),
      [hotkeyKey(HOTKEYS.closeTab)]:        () => { if (activeTabId) closeTab(activeTabId) },
      [hotkeyKey(HOTKEYS.splitVertical)]:   () => { const p = getFocusedPane(); if (p) splitPane(p.id, 'vertical') },
      [hotkeyKey(HOTKEYS.splitHorizontal)]: () => { const p = getFocusedPane(); if (p) splitPane(p.id, 'horizontal') },
      [hotkeyKey(HOTKEYS.closePane)]:       () => { const p = getFocusedPane(); if (p) closePane(p.id) },
      [hotkeyKey(HOTKEYS.zoomPane)]:        () => { if (zoomedPaneId) { unzoom() } else { const p = getFocusedPane(); if (p) zoomPane(p.id) } },
      [hotkeyKey(HOTKEYS.toggleSidebar)]:   () => toggleSidebar(),
      [hotkeyKey(HOTKEYS.commandPalette)]:  () => toggleCommandPalette(),
      [hotkeyKey(HOTKEYS.sessionBrowser)]:  () => toggleSessionBrowser(),
    }

    function handler(e: KeyboardEvent) {
      if (!e.ctrlKey && !e.metaKey) {
        if (e.key === 'Escape') closeOverlays()
        return
      }
      const fn = dispatch[eventKey(e)]
      if (fn) { e.preventDefault(); fn() }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [
    addTab,
    closeTab,
    activeTabId,
    splitPane,
    closePane,
    zoomPane,
    unzoom,
    zoomedPaneId,
    toggleSidebar,
    toggleCommandPalette,
    toggleSessionBrowser,
    closeOverlays,
    getFocusedPane,
  ])
}

export default function App(): JSX.Element {
  useGlobalKeyboard()

  const sessionBrowserOpen = usePanesStore((s) => s.sessionBrowserOpen)
  const commandPaletteOpen = usePanesStore((s) => s.commandPaletteOpen)
  const [restoreData, setRestoreData] = useState<{
    tabs: Tab[]
    sidebarWidth: number
    sidebarOpen: boolean
  } | null>(null)

  const tabs = usePanesStore((s) => s.tabs)
  const sidebarWidth = usePanesStore((s) => s.sidebarWidth)
  const sidebarOpen = usePanesStore((s) => s.sidebarOpen)

  // Peek at saved layout on mount; show restore prompt if previous session exists
  useEffect(() => {
    window.ipc.invoke('layout:load').then((saved) => {
      const data = saved as { tabs: Tab[]; sidebarWidth: number; sidebarOpen: boolean } | null
      if (data?.tabs?.length) {
        setRestoreData(data)
      }
    }).catch(() => {})
  }, [])

  const handleRestore = useCallback(() => {
    if (restoreData) {
      usePanesStore.getState().applyLayout(restoreData)
    }
    setRestoreData(null)
  }, [restoreData])

  const handleDiscard = useCallback(() => {
    setRestoreData(null)
  }, [])

  // Debounced layout save whenever tabs or sidebar state changes
  useEffect(() => {
    if (!tabs.length) return
    const timer = setTimeout(() => {
      window.ipc.invoke('layout:save', tabs, sidebarWidth, sidebarOpen).catch(() => {})
    }, 1000)
    return () => clearTimeout(timer)
  }, [tabs, sidebarWidth, sidebarOpen])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        backgroundColor: '#0e1011',
        color: '#d4d4d4',
      }}
    >
      {/* Main content row */}
      <div
        style={{
          display: 'flex',
          flex: 1,
          overflow: 'hidden',
        }}
      >
        <Sidebar />

        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <TabBar />
          <PaneGrid />
        </div>
      </div>

      {/* Overlays */}
      {sessionBrowserOpen && <SessionBrowser />}
      {commandPaletteOpen && <CommandPalette />}

      {/* Startup restore prompt - shown before any tabs load */}
      {restoreData && (
        <RestorePrompt
          tabs={restoreData.tabs}
          onRestore={handleRestore}
          onDiscard={handleDiscard}
        />
      )}
    </div>
  )
}
