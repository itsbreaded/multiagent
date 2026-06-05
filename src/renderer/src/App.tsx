import { useEffect, useState } from 'react'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { PaneGrid } from './components/PaneGrid'
import { SessionBrowser } from './components/SessionBrowser'
import { CommandPalette } from './components/CommandPalette'
import { BrowserPanel } from './components/BrowserPanel'
import { usePanesStore } from './store/panes'

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
    function handler(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey

      if (!mod) {
        if (e.key === 'Escape') {
          closeOverlays()
        }
        return
      }

      // Ctrl/Cmd + T: new tab
      if (e.key === 't' && !e.shiftKey) {
        e.preventDefault()
        addTab()
        return
      }

      // Ctrl/Cmd + W: close active tab
      if (e.key === 'w' && !e.shiftKey) {
        e.preventDefault()
        if (activeTabId) closeTab(activeTabId)
        return
      }

      // Ctrl/Cmd + Shift + E: split vertical
      if (e.key === 'E' && e.shiftKey) {
        e.preventDefault()
        const pane = getFocusedPane()
        if (pane) splitPane(pane.id, 'vertical')
        return
      }

      // Ctrl/Cmd + Shift + D: split horizontal
      if (e.key === 'D' && e.shiftKey) {
        e.preventDefault()
        const pane = getFocusedPane()
        if (pane) splitPane(pane.id, 'horizontal')
        return
      }

      // Ctrl/Cmd + Shift + W: close pane
      if (e.key === 'W' && e.shiftKey) {
        e.preventDefault()
        const pane = getFocusedPane()
        if (pane) closePane(pane.id)
        return
      }

      // Ctrl/Cmd + Shift + Enter: zoom/unzoom
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault()
        if (zoomedPaneId) {
          unzoom()
        } else {
          const pane = getFocusedPane()
          if (pane) zoomPane(pane.id)
        }
        return
      }

      // Ctrl/Cmd + B: toggle sidebar
      if (e.key === 'b' && !e.shiftKey) {
        e.preventDefault()
        toggleSidebar()
        return
      }

      // Ctrl/Cmd + P: toggle command palette
      if (e.key === 'p' && !e.shiftKey) {
        e.preventDefault()
        toggleCommandPalette()
        return
      }

      // Ctrl/Cmd + Shift + O: toggle session browser
      if (e.key === 'O' && e.shiftKey) {
        e.preventDefault()
        toggleSessionBrowser()
        return
      }
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
  const [browserPanelVisible, setBrowserPanelVisible] = useState(false)

  // Open browser panel when main process signals an agent is using the browser
  useEffect(() => {
    if (typeof window === 'undefined' || !window.ipc) return
    const unsub = window.ipc.on('browser:agent-active', (active: unknown) => {
      if (active) setBrowserPanelVisible(true)
    })
    return unsub
  }, [])

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
      {/* Title bar - drag region at top */}
      <TitleBar />

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

      {/* Browser panel (MCP-controlled embedded browser chrome) */}
      <BrowserPanel
        visible={browserPanelVisible}
        onClose={() => setBrowserPanelVisible(false)}
      />

      {/* Overlays */}
      {sessionBrowserOpen && <SessionBrowser />}
      {commandPaletteOpen && <CommandPalette />}
    </div>
  )
}
