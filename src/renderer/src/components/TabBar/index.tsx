import React, { useEffect, useState } from 'react'
import { usePanesStore } from '../../store/panes'
import { HOTKEYS } from '../../utils/hotkeys'
import { ui, border } from '../../styles/theme'
import searchIcon from '../../assets/search.png'
import bookIcon from '../../assets/book.png'
import settingsIcon from '../../assets/settings.png'
import leftPanelOpenedIcon from '../../assets/leftpanelopened.png'
import leftPanelClosedIcon from '../../assets/leftpanelclosed.png'
import minimizeIcon from '../../assets/minimize.png'
import maximizeIcon from '../../assets/maximize.png'
import closeIcon from '../../assets/close.png'

const CHROME_DRAG_EXEMPT_SELECTOR = 'button, input, textarea, select, [data-window-drag-exempt="true"]'

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
        e.currentTarget.style.color = ui.color.text
        e.currentTarget.style.background = ui.color.control
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = active ? ui.color.text : ui.color.textDim
        e.currentTarget.style.background = active ? ui.color.control : 'none'
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
    void window.ipc.invoke('window:is-maximized')
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

function ChromeButtonCluster(): JSX.Element {
  const sidebarOpen = usePanesStore((s) => s.sidebarOpen)
  const toggleSidebar = usePanesStore((s) => s.toggleSidebar)
  const toggleSessionBrowser = usePanesStore((s) => s.toggleSessionBrowser)
  const toggleCommandPalette = usePanesStore((s) => s.toggleCommandPalette)
  const toggleSettings = usePanesStore((s) => s.toggleSettings)
  const sessionBrowserOpen = usePanesStore((s) => s.sessionBrowserOpen)
  const commandPaletteOpen = usePanesStore((s) => s.commandPaletteOpen)
  const settingsOpen = usePanesStore((s) => s.settingsOpen)

  return <>
    <BarButton onClick={toggleSidebar} title={sidebarOpen ? `Collapse sidebar (${HOTKEYS.toggleSidebar.display})` : `Open sidebar (${HOTKEYS.toggleSidebar.display})`}>
      <img src={sidebarOpen ? leftPanelClosedIcon : leftPanelOpenedIcon} alt="" style={{ width: 16, height: 16, display: 'block' }} />
    </BarButton>
    <BarButton onClick={toggleSessionBrowser} title={`Session browser (${HOTKEYS.sessionBrowser.display})`} active={sessionBrowserOpen}>
      <img src={bookIcon} alt="" style={{ width: 16, height: 16, display: 'block' }} />
    </BarButton>
    <BarButton onClick={toggleCommandPalette} title={`Command palette (${HOTKEYS.commandPalette.display})`} active={commandPaletteOpen}>
      <img src={searchIcon} alt="" style={{ width: 16, height: 16, display: 'block' }} />
    </BarButton>
    <BarButton onClick={toggleSettings} title="Settings" active={settingsOpen}>
      <img src={settingsIcon} alt="" style={{ width: 16, height: 16, display: 'block' }} />
    </BarButton>
  </>
}

function leftChromeWidth(sidebarOpen: boolean, sidebarWidth: number, isMac: boolean): number {
  return sidebarOpen ? sidebarWidth : ui.chrome.controlSize * 4 + 8 + (isMac ? 80 : 0)
}

export function TabBar(): JSX.Element {
  const isDetachedWindow = usePanesStore((s) => s.isDetachedWindow)
  const sidebarOpen = usePanesStore((s) => s.sidebarOpen)
  const sidebarWidth = usePanesStore((s) => s.sidebarWidth)
  const isMac = isMacPlatform()
  const isWindows = isWindowsPlatform()
  const chromeHeight = isDetachedWindow ? ui.chrome.detachedHeight : ui.chrome.height
  const leftChromePadding = 4
  const chromeWidth = leftChromeWidth(sidebarOpen, sidebarWidth, isMac)
  const nativeWindowControlsWidth = isWindows ? ui.chrome.windowControlWidth * 3 : 0

  return (
    <div
      onMouseDownCapture={startWindowDragFromChrome}
      onDoubleClickCapture={toggleMaximizeFromChrome}
      style={{
        height: chromeHeight,
        minHeight: chromeHeight,
        boxSizing: 'border-box',
        backgroundColor: isDetachedWindow ? ui.chrome.backgroundDetached : ui.chrome.background,
        borderBottom: border.default,
        display: 'flex',
        alignItems: 'center',
        flexShrink: 0,
        overflow: 'hidden',
        paddingLeft: isDetachedWindow && isMac ? 80 : 0,
        ...appRegion('drag'),
      }}
    >
      <div
        style={{
          width: chromeWidth,
          minWidth: chromeWidth,
          height: chromeHeight - 1,
          backgroundColor: isDetachedWindow ? ui.chrome.backgroundDetached : ui.chrome.background,
          paddingLeft: isMac && !isDetachedWindow ? 80 : leftChromePadding,
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
        <ChromeButtonCluster />
      </div>

      <div style={{ flex: 1, minWidth: 24, height: '100%', ...appRegion('drag') }} />
      {nativeWindowControlsWidth > 0 && (
        <div
          style={{
            width: nativeWindowControlsWidth,
            height: '100%',
            flexShrink: 0,
            backgroundColor: isDetachedWindow ? ui.chrome.backgroundDetached : ui.chrome.background,
          }}
        />
      )}
      <WindowControls />
    </div>
  )
}
