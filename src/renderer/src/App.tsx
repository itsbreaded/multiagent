import { useEffect, useRef, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { AppChrome } from './components/AppChrome'
import { LeftChrome } from './components/TabBar'
import { PaneGrid } from './components/PaneGrid'
import { SessionBrowser } from './components/SessionBrowser'
import { CommandPalette } from './components/CommandPalette'
import { SettingsPanel } from './components/SettingsPanel'
import { SnapOverlay } from './components/SnapOverlay'
import { DirPicker } from './components/DirPicker'
import { usePanesStore } from './store/panes'
import { useSettingsStore } from './store/settings'
import { buildHotkeys, hotkeyKey, eventKey } from './utils/hotkeys'
import { decodePaneDragPayload, PANE_DRAG_MIME } from './utils/paneDrag'
import { mergeGpuFeatureStatus } from './terminal/rendering/capabilities'
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
  const hotkeyOverrides = useSettingsStore((s) => s.hotkeyOverrides)

  useEffect(() => {
    const hotkeys = buildHotkeys(hotkeyOverrides)
    const dispatch: Record<string, () => void> = {
      [hotkeyKey(hotkeys.newTab)]:          () => addTab(),
      [hotkeyKey(hotkeys.closeTab)]:        () => { if (activeTabId) closeTab(activeTabId) },
      [hotkeyKey(hotkeys.splitVertical)]:   () => { const p = getFocusedPane(); if (p) splitPane(p.id, 'vertical') },
      [hotkeyKey(hotkeys.splitHorizontal)]: () => { const p = getFocusedPane(); if (p) splitPane(p.id, 'horizontal') },
      [hotkeyKey(hotkeys.closePane)]:       () => { const p = getFocusedPane(); if (p) closePane(p.id) },
      [hotkeyKey(hotkeys.zoomPane)]:        () => { if (zoomedPaneId) { unzoom() } else { const p = getFocusedPane(); if (p) zoomPane(p.id) } },
      [hotkeyKey(hotkeys.toggleSidebar)]:   () => toggleSidebar(),
      [hotkeyKey(hotkeys.commandPalette)]:  () => toggleCommandPalette(),
      [hotkeyKey(hotkeys.sessionBrowser)]:  () => toggleSessionBrowser(),
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
    hotkeyOverrides,
  ])
}

const TAB_DRAG_MIME = 'application/x-multiagent-tab'

export default function App(): JSX.Element {
  useGlobalKeyboard()

  const restoreStartedRef = useRef(false)
  const detachedSyncVersionRef = useRef(0)
  const [layoutReady, setLayoutReady] = useState(false)
  const sessionBrowserOpen = usePanesStore((s) => s.sessionBrowserOpen)
  const commandPaletteOpen = usePanesStore((s) => s.commandPaletteOpen)
  const settingsOpen = usePanesStore((s) => s.settingsOpen)
  const isDetachedWindow = usePanesStore((s) => s.isDetachedWindow)
  const dirPickerTabId = usePanesStore((s) => s.dirPickerTabId)
  const closeDirPicker = usePanesStore((s) => s.closeDirPicker)
  const setTabDefaultCwd = usePanesStore((s) => s.setTabDefaultCwd)
  const receiveTab = usePanesStore((s) => s.receiveTab)
  const movePaneToTab = usePanesStore((s) => s.movePaneToTab)
  const tabOverflowMode = useSettingsStore((s) => s.tabOverflowMode)

  const tabs = usePanesStore((s) => s.tabs)
  const windowId = usePanesStore((s) => s.windowId)
  const activeTabId = usePanesStore((s) => s.activeTabId)
  const sidebarWidth = usePanesStore((s) => s.sidebarWidth)
  const sidebarPanelSizes = usePanesStore((s) => s.sidebarPanelSizes)
  const sidebarOpen = usePanesStore((s) => s.sidebarOpen)
  const sidebarSectionOpen = usePanesStore((s) => s.sidebarSectionOpen)

  // Detect VS Code availability once on startup
  const setVsCodeAvailable = usePanesStore((s) => s.setVsCodeAvailable)
  useEffect(() => {
    window.ipc.invoke('shell:vscode-available').then((available) => {
      setVsCodeAvailable(available as boolean)
    }).catch(() => {})
  }, [setVsCodeAvailable])

  // Kick off async GPU feature-status probe. Refines the renderer-side WebGL
  // capability probe (primary signal) with Chromium's GPU status. Never on the
  // critical path of pane creation — only used for diagnostics readout.
  useEffect(() => {
    window.ipc.invoke('gpu:feature-status').then((result) => {
      const r = result as { softwareOnly: boolean } | null
      if (r) mergeGpuFeatureStatus(r.softwareOnly)
    }).catch(() => {})
  }, [])

  // Fetch this window's ID from main so the tab bar can use it for drag-out.
  const setWindowId = usePanesStore((s) => s.setWindowId)
  useEffect(() => {
    window.ipc.invoke('window:get-id').then((id) => {
      if (typeof id === 'number') setWindowId(id)
    }).catch(() => {})
  }, [setWindowId])

  // On startup: check if this is a detached window; if so, skip layout file restore.
  useEffect(() => {
    if (restoreStartedRef.current) return
    restoreStartedRef.current = true

    window.ipc.invoke('window:get-init-data').then((initData) => {
      if (initData && (initData as { mode: string }).mode === 'detached') {
        const { tab, ptyIds } = initData as { tab: Tab; ptyIds: string[] }
        usePanesStore.getState().initDetached(tab, ptyIds)
        setLayoutReady(true)
        return
      }

      // Primary window: restore saved layout as before.
      return window.ipc.invoke('layout:load').then((saved) => {
        const data = saved as { tabs: Tab[]; sidebarWidth: number; sidebarOpen: boolean; sidebarBottomHeight?: number; sidebarPanelSizes?: Record<string, number>; activeTabId?: string; sidebarSectionOpen?: Record<string, boolean>; tabSectionOpen?: Record<string, boolean> } | null
        if (data?.tabs?.length) {
          void usePanesStore.getState().applyLayout(data)
        }
      }).catch(() => {})
    }).catch(() => {
      // Fallback: treat as primary window
      window.ipc.invoke('layout:load').then((saved) => {
        const data = saved as { tabs: Tab[]; sidebarWidth: number; sidebarOpen: boolean } | null
        if (data?.tabs?.length) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          void usePanesStore.getState().applyLayout(data as any)
        }
      }).catch(() => {})
    }).finally(() => setLayoutReady(true))
  }, [])

  // Detached window: push tab state to primary on every change (debounced).
  useEffect(() => {
    if (!isDetachedWindow || !windowId || !layoutReady) return
    const timer = setTimeout(() => {
      detachedSyncVersionRef.current += 1
      window.ipc.send('tab:state-sync', {
        windowId,
        tabs,
        activeTabId,
        version: detachedSyncVersionRef.current,
      })
    }, 300)
    return () => clearTimeout(timer)
  }, [isDetachedWindow, windowId, layoutReady, tabs, activeTabId])

  // Detached window: close itself when all tabs are gone.
  useEffect(() => {
    if (!isDetachedWindow || !layoutReady) return
    if (tabs.length === 0) window.close()
  }, [isDetachedWindow, layoutReady, tabs])

  // Shutdown layout collection: respond to main's requests for an authoritative final save.
  // Primary responds to layout:request-state; detached windows respond to layout:collect-detached-state.
  useEffect(() => {
    if (!layoutReady) return
    const unsub1 = window.ipc.on('layout:request-state', (requestId: unknown) => {
      if (typeof requestId !== 'string') return
      if (usePanesStore.getState().isDetachedWindow) return
      const s = usePanesStore.getState()
      window.ipc.send('layout:state-response', requestId, {
        tabs: s.tabs,
        sidebarWidth: s.sidebarWidth,
        sidebarOpen: s.sidebarOpen,
        activeTabId: s.activeTabId,
        sidebarSectionOpen: s.sidebarSectionOpen,
        sidebarPanelSizes: s.sidebarPanelSizes,
      })
    })
    const unsub2 = window.ipc.on('layout:collect-detached-state', (requestId: unknown) => {
      if (typeof requestId !== 'string') return
      const s = usePanesStore.getState()
      if (!s.isDetachedWindow) return
      window.ipc.send('layout:detached-state-response', requestId, {
        windowId: s.windowId,
        tabs: s.tabs,
        activeTabId: s.activeTabId,
      })
    })
    return () => { unsub1(); unsub2() }
  }, [layoutReady])

  // Debounced layout save — only for the primary window.
  useEffect(() => {
    if (!layoutReady) return
    if (!tabs.length) return
    if (isDetachedWindow) return  // Detached windows don't overwrite the primary layout file
    const timer = setTimeout(() => {
      window.ipc.invoke('layout:save', tabs, sidebarWidth, sidebarOpen, activeTabId, sidebarSectionOpen, sidebarPanelSizes).catch(() => {})
    }, 1000)
    return () => clearTimeout(timer)
  }, [layoutReady, isDetachedWindow, tabs, sidebarWidth, sidebarOpen, activeTabId, sidebarSectionOpen, sidebarPanelSizes])

  const isWrapLayout = tabOverflowMode === 'wrap' && !isDetachedWindow

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
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(TAB_DRAG_MIME) || e.dataTransfer.types.includes(PANE_DRAG_MIME)) e.preventDefault()
      }}
      onDrop={(e) => {
        const panePayload = decodePaneDragPayload(e.dataTransfer)
        if (panePayload && activeTabId && windowId !== null) {
          e.preventDefault()
          e.stopPropagation()
          if (panePayload.sourceWindowId === windowId) {
            movePaneToTab(panePayload.pane.id, activeTabId)
          } else {
            window.ipc.invoke('pane:transfer', { ...panePayload, targetTabId: activeTabId, targetWindowId: windowId }).catch(console.error)
          }
          return
        }
        const data = e.dataTransfer.getData(TAB_DRAG_MIME)
        if (!data) return
        try {
          const { tab, ptyIds, sourceWindowId } = JSON.parse(data) as {
            tab: Tab; ptyIds: string[]; sourceWindowId: number | null
          }
          if (sourceWindowId === windowId) return // intra-window drag
          e.preventDefault()
          e.stopPropagation()
          receiveTab(tab)
          window.ipc.invoke('tab:absorb', JSON.stringify(tab), ptyIds, sourceWindowId ?? -1)
            .then((ok) => {
              if (!ok) usePanesStore.getState().removeTabLocally(tab.id)
            })
            .catch(console.error)
        } catch { /* ignore */ }
      }}
    >
      {isWrapLayout ? (
        /* Wrap mode: left column (LeftChrome + Sidebar) || right column (tab strip + content) */
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Left column */}
          <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
            <LeftChrome withBorderBottom />
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex' }}>
              <Sidebar />
            </div>
          </div>
          {/* Right column */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <AppChrome />
            <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <PaneGrid />
            </div>
          </div>
        </div>
      ) : (
        <>
          <AppChrome />

          {/* Main content row */}
          <div
            style={{
              display: 'flex',
              flex: 1,
              minHeight: 0,
              minWidth: 0,
              overflow: 'hidden',
            }}
          >
            <Sidebar />

            <div
              style={{
                flex: 1,
                minHeight: 0,
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              <PaneGrid />
            </div>
          </div>
        </>
      )}

      {/* Overlays — workspace tools only shown in the primary window */}
      {!isDetachedWindow && sessionBrowserOpen && <SessionBrowser />}
      {!isDetachedWindow && commandPaletteOpen && <CommandPalette />}
      {!isDetachedWindow && settingsOpen && <SettingsPanel />}
      {!isDetachedWindow && dirPickerTabId && (
        <DirPicker
          title="Change project directory"
          description="New sessions and shells in this tab will start here by default."
          initial={tabs.find((t) => t.id === dirPickerTabId)?.defaultCwd ?? ''}
          confirmLabel="Change"
          skipLabel="Cancel"
          onConfirm={(dir) => { setTabDefaultCwd(dirPickerTabId, dir); closeDirPicker() }}
          onSkip={closeDirPicker}
        />
      )}
      <SnapOverlay />
    </div>
  )
}
