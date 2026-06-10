import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { PaneLeaf } from '../../../../shared/types'
import { usePanesStore } from '../../store/panes'
import { HOTKEYS, hotkeyKey, eventKey } from '../../utils/hotkeys'
import { agentLabel } from '../../utils/agents'

const XTERM_THEME = {
  background: '#0e1011',
  foreground: '#d4d4d4',
  cursor: '#4ade80',
  cursorAccent: '#0e1011',
  selectionBackground: '#264f78',
  black: '#1e1e1e',
  red: '#f44747',
  green: '#4ade80',
  yellow: '#ffcc00',
  blue: '#569cd6',
  magenta: '#c586c0',
  cyan: '#4ec9b0',
  white: '#d4d4d4',
  brightBlack: '#3a3a3a',
  brightRed: '#f44747',
  brightGreen: '#4ade80',
  brightYellow: '#ffcc00',
  brightBlue: '#569cd6',
  brightMagenta: '#c586c0',
  brightCyan: '#4ec9b0',
  brightWhite: '#e2e4e6',
}

const TERMINAL_SCROLLBACK_LINES = 250_000
const RESIZE_COL_DEBOUNCE_MS = 100
const IS_WINDOWS = navigator.userAgent.includes('Windows')
const ALT_ENTER_SEQUENCE = '\x1b\r'

interface ContextMenu {
  x: number
  y: number
  hasSelection: boolean
}

interface TerminalProps {
  pane: PaneLeaf
}

export function Terminal({ pane }: TerminalProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const ptyIdRef = useRef<string | null>(pane.ptyId ?? null)
  const setPtyId = usePanesStore((s) => s.setPtyId)
  const [status, setStatus] = useState<'mounting' | 'connecting' | 'ready' | 'error'>('mounting')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)

  // Keep ptyIdRef in sync so context menu paste can always find the current ptyId
  useEffect(() => { ptyIdRef.current = pane.ptyId ?? null }, [pane.ptyId])

  const handleCopy = useCallback(() => {
    const xterm = xtermRef.current
    if (!xterm) return
    const selection = xterm.getSelection()
    if (selection) navigator.clipboard.writeText(selection).catch(() => {})
    setContextMenu(null)
  }, [])

  const handlePaste = useCallback(() => {
    const ptyId = ptyIdRef.current
    if (!ptyId) return
    navigator.clipboard.readText().then((text) => {
      if (text) window.ipc.send('pty:write', ptyId, text)
    }).catch(() => {})
    setContextMenu(null)
  }, [])

  // Effect 1: create the xterm instance once per pane
  useEffect(() => {
    if (!containerRef.current) return

    const theme = pane.paneType === 'agent'
      ? { ...XTERM_THEME, cursor: 'transparent', cursorAccent: 'transparent' }
      : XTERM_THEME

    const xterm = new XTerm({
      allowProposedApi: true,
      theme,
      fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: pane.paneType !== 'agent',
      scrollback: TERMINAL_SCROLLBACK_LINES,
      scrollOnEraseInDisplay: true,
      allowTransparency: false,
      windowOptions: {
        getWinSizePixels: true,
        getCellSizePixels: true,
        getWinSizeChars: true,
      },
    })

    const fitAddon = new FitAddon()
    xterm.loadAddon(fitAddon)
    xterm.open(containerRef.current)
    // Tell xterm we're running under ConPTY so it applies the right
    // rendering workarounds for the detected build number.
    if (IS_WINDOWS) {
      const buildNumber = parseInt(window.osRelease?.split('.')[2] ?? '0', 10)
      xterm.options.windowsPty = { backend: 'conpty', buildNumber }
    }
    fitAddon.fit()
    // No WebGL or Canvas addon — xterm DOM renderer is used. It is leaner on
    // low-powered / software-rasterised GPUs where WebGL (via SwiftShader/WARP)
    // produces ~50-60% CPU for a single keystroke echo.

    // Intercept keyboard shortcuts before xterm sees them.
    // xterm only calls stopPropagation when it processes a key (return true).
    // When we return false, we must call e.stopPropagation() ourselves or the
    // event bubbles to App.tsx's window listener and fires the action a second time.
    xterm.attachCustomKeyEventHandler((e) => {
      // Shift+Enter: translate to Alt+Enter for agent CLIs. Both Codex and
      // Claude Code treat Alt+Enter as insert-newline without submitting.
      if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'Enter') {
        if (pane.agentKind !== 'codex' && pane.agentKind !== 'claude') return true
        if (e.type === 'keydown') {
          const ptyId = ptyIdRef.current
          if (ptyId) window.ipc.send('pty:write', ptyId, ALT_ENTER_SEQUENCE)
        }
        e.stopPropagation()
        e.preventDefault()
        return false
      }

      if (e.type !== 'keydown') return true

      const stop = (): false => { e.stopPropagation(); e.preventDefault(); return false }
      const mod = e.ctrlKey || e.metaKey
      const store = usePanesStore.getState()

      // Ctrl+Shift+C: copy selection
      if (mod && e.shiftKey && e.code === 'KeyC') {
        const selection = xterm.getSelection()
        if (selection) navigator.clipboard.writeText(selection).catch(() => {})
        return stop()
      }

      // Ctrl+Shift+V: paste from clipboard
      if (mod && e.shiftKey && e.code === 'KeyV') {
        const ptyId = ptyIdRef.current
        if (ptyId) {
          navigator.clipboard.readText().then((text) => {
            if (text) window.ipc.send('pty:write', ptyId, text)
          }).catch(() => {})
        }
        return stop()
      }

      // Global app shortcuts
      if (mod) {
        const dispatch: Record<string, () => void> = {
          [hotkeyKey(HOTKEYS.splitVertical)]:   () => { const p = store.getFocusedPane(); if (p) store.splitPane(p.id, 'vertical') },
          [hotkeyKey(HOTKEYS.splitHorizontal)]: () => { const p = store.getFocusedPane(); if (p) store.splitPane(p.id, 'horizontal') },
          [hotkeyKey(HOTKEYS.commandPalette)]:  () => store.toggleCommandPalette(),
          [hotkeyKey(HOTKEYS.sessionBrowser)]:  () => store.toggleSessionBrowser(),
          [hotkeyKey(HOTKEYS.closePane)]:       () => { const p = store.getFocusedPane(); if (p) store.closePane(p.id) },
          [hotkeyKey(HOTKEYS.zoomPane)]:        () => { if (store.zoomedPaneId) { store.unzoom() } else { const p = store.getFocusedPane(); if (p) store.zoomPane(p.id) } },
          [hotkeyKey(HOTKEYS.newTab)]:          () => store.addTab(),
          [hotkeyKey(HOTKEYS.closeTab)]:        () => { if (store.activeTabId) store.closeTab(store.activeTabId) },
          [hotkeyKey(HOTKEYS.toggleSidebar)]:   () => store.toggleSidebar(),
        }
        const fn = dispatch[eventKey(e)]
        if (fn) { fn(); return stop() }
      }

      if (!mod && !e.shiftKey && e.code === 'Escape') {
        if (store.sessionBrowserOpen || store.commandPaletteOpen) { store.closeOverlays(); return stop() }
      }

      return true
    })

    xtermRef.current = xterm
    fitAddonRef.current = fitAddon

    let pendingFit: number | null = null
    let lastFitSize: { width: number; height: number } | null = null
    const fitTerminal = (): void => {
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      const width = Math.round(rect.width)
      const height = Math.round(rect.height)
      if (lastFitSize?.width === width && lastFitSize.height === height) return
      lastFitSize = { width, height }
      try { fitAddon.fit() } catch { /* ignore */ }
    }
    const ro = new ResizeObserver(() => {
      if (pendingFit !== null) cancelAnimationFrame(pendingFit)
      pendingFit = requestAnimationFrame(() => {
        pendingFit = null
        fitTerminal()
      })
    })
    ro.observe(containerRef.current)

    // Block paste events from reaching xterm's internal textarea listener.
    // Without this, Ctrl+Shift+V triggers both our key handler AND xterm's
    // native paste handler, causing every paste to appear twice in the PTY.
    const container = containerRef.current
    const blockPaste = (e: ClipboardEvent): void => {
      e.stopPropagation()
      e.preventDefault()
    }
    container.addEventListener('paste', blockPaste, true)

    setStatus('connecting')

    return () => {
      if (pendingFit !== null) cancelAnimationFrame(pendingFit)
      container.removeEventListener('paste', blockPaste, true)
      ro.disconnect()
      xterm.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
    }
  }, [pane.id])

  // Effect 2: connect to the PTY once a ptyId is available
  useEffect(() => {
    const xterm = xtermRef.current
    if (!xterm || status === 'mounting') return
    const terminal: XTerm = xterm

    if (pane.paneType === 'agent' && !pane.ptyId) {
      xterm.clear()
      xterm.write(`\x1b[2m[Starting ${agentLabel(pane.agentKind ?? 'claude')} session...]\x1b[0m\r\n`)
      setStatus('connecting')
      return
    }

    let cancelled = false
    let unsubData: (() => void) | undefined
    let dataDisposable: { dispose(): void } | undefined
    let resizeDisposable: { dispose(): void } | undefined
    let conptyDa1Handler: { dispose(): void } | undefined
    let lastResize: { cols: number; rows: number } | null = null
    let pendingResizeCols: number | null = null
    let pendingResizeTimer: ReturnType<typeof setTimeout> | null = null

    async function connect(): Promise<void> {
      let ptyId = pane.ptyId ?? null

      if (!ptyId && pane.paneType === 'shell') {
        try {
          const result = await window.ipc.invoke('pty:create', pane.cwd) as { ptyId: string }
          if (cancelled) return
          ptyId = result.ptyId
          ptyIdRef.current = ptyId
          setPtyId(pane.id, ptyId)
        } catch (err) {
          if (!cancelled) {
            setStatus('error')
            setErrorMsg(String(err))
          }
          return
        }
      }

      if (!ptyId || cancelled) return

      ptyIdRef.current = ptyId
      setStatus('ready')

      unsubData = window.ipc.on('pty:data', (receivedId: unknown, data: unknown) => {
        if (receivedId === ptyId && typeof data === 'string' && !cancelled) {
          terminal.write(data)
        }
      })

      dataDisposable = terminal.onData((data) => {
        if (!cancelled) window.ipc.send('pty:write', ptyId, data)
      })

      conptyDa1Handler = IS_WINDOWS
        ? terminal.parser.registerCsiHandler({ final: 'c' }, (params) => {
            if (params.length === 0 || (params.length === 1 && params[0] === 0)) {
              if (!cancelled) window.ipc.send('pty:write', ptyId, '\x1b[?61;4c')
              return true
            }
            return false
          })
        : undefined

      const sendResize = (cols: number, rows: number): void => {
        if (lastResize?.cols === cols && lastResize.rows === rows) return
        lastResize = { cols, rows }
        window.ipc.invoke('pty:resize', ptyId, cols, rows).catch(() => {})
      }

      const flushPendingResize = (): void => {
        pendingResizeTimer = null
        if (pendingResizeCols === null) return
        sendResize(pendingResizeCols, terminal.rows)
        pendingResizeCols = null
      }

      const queueResize = ({ cols, rows }: { cols: number; rows: number }): void => {
        if (lastResize?.cols === cols && lastResize.rows === rows) return
        if (lastResize && lastResize.rows !== rows) {
          if (pendingResizeTimer) {
            clearTimeout(pendingResizeTimer)
            pendingResizeTimer = null
            pendingResizeCols = null
          }
          sendResize(cols, rows)
          return
        }

        pendingResizeCols = cols
        if (pendingResizeTimer) return
        pendingResizeTimer = setTimeout(flushPendingResize, RESIZE_COL_DEBOUNCE_MS)
      }
      resizeDisposable = terminal.onResize(queueResize)
      try { fitAddonRef.current?.fit() } catch { /* ignore */ }
      sendResize(terminal.cols, terminal.rows)
    }

    connect()

    return () => {
      cancelled = true
      if (pendingResizeTimer) clearTimeout(pendingResizeTimer)
      unsubData?.()
      dataDisposable?.dispose()
      conptyDa1Handler?.dispose()
      resizeDisposable?.dispose()
      // Do NOT kill the PTY here. Terminal unmounts whenever the pane tree
      // changes (e.g. a split), and killing here would destroy a live session.
      // PTYs are killed explicitly by closePane() in the panes store.
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, pane.ptyId, pane.paneType, status === 'mounting' ? 'mounting' : 'ready'])

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      hasSelection: !!(xtermRef.current?.getSelection()),
    })
  }, [])

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
        backgroundColor: '#0e1011',
        position: 'relative',
      }}
      onContextMenu={onContextMenu}
      onClick={() => contextMenu && setContextMenu(null)}
    >
      {status === 'connecting' && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          backgroundColor: '#0e1011', zIndex: 1,
          color: '#4a4b4e', fontSize: 12, pointerEvents: 'none',
        }}>
          {pane.paneType === 'agent' ? `Starting ${agentLabel(pane.agentKind ?? 'claude')} session...` : 'Connecting...'}
        </div>
      )}
      {status === 'error' && errorMsg && (
        <div style={{
          position: 'absolute', top: 8, left: 8, right: 8,
          padding: '4px 8px', backgroundColor: '#1e1010',
          border: '1px solid #3a1010', borderRadius: 4,
          fontSize: 11, color: '#f87171', zIndex: 2,
        }}>
          {errorMsg}
        </div>
      )}
      <div ref={containerRef} style={{ width: '100%', height: '100%', minHeight: 0, minWidth: 0, padding: 4 }} />

      {contextMenu && (
        <div
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            backgroundColor: '#1e2022',
            border: '1px solid #2a2b2e',
            borderRadius: 6,
            padding: '4px 0',
            zIndex: 1000,
            minWidth: 140,
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            fontSize: 13,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={handleCopy}
            disabled={!contextMenu.hasSelection}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '6px 14px', background: 'none', border: 'none',
              color: contextMenu.hasSelection ? '#d4d4d4' : '#4a4b4e',
              cursor: contextMenu.hasSelection ? 'pointer' : 'default',
              fontSize: 13,
            }}
          >
            Copy
            <span style={{ float: 'right', opacity: 0.4, fontSize: 11 }}>Ctrl+Shift+C</span>
          </button>
          <button
            onClick={handlePaste}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '6px 14px', background: 'none', border: 'none',
              color: '#d4d4d4', cursor: 'pointer', fontSize: 13,
            }}
          >
            Paste
            <span style={{ float: 'right', opacity: 0.4, fontSize: 11 }}>Ctrl+Shift+V</span>
          </button>
        </div>
      )}
    </div>
  )
}
