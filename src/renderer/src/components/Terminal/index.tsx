import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { PaneLeaf } from '../../../../shared/types'
import { usePanesStore } from '../../store/panes'
import { useSettingsStore } from '../../store/settings'
import { buildHotkeys, hotkeyKey, eventKey } from '../../utils/hotkeys'
import { agentLabel } from '../../utils/agents'
import * as xtermRegistry from '../../utils/xtermRegistry'

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
const XTERM_WRITE_CHUNK_CHARS = 128 * 1024
const XTERM_OUTPUT_PAUSE_CHARS = 1024 * 1024
const XTERM_OUTPUT_RESUME_CHARS = 256 * 1024
const IS_WINDOWS = navigator.userAgent.includes('Windows')
const ALT_ENTER_SEQUENCE = '\x1b\r'

interface ContextMenu {
  x: number
  y: number
  hasSelection: boolean
}

interface TerminalProps {
  pane: PaneLeaf
  layoutKey: string
}

export function Terminal({ pane, layoutKey }: TerminalProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const queueFitRef = useRef<(() => void) | null>(null)
  const ptyIdRef = useRef<string | null>(pane.ptyId ?? null)
  const setPtyId = usePanesStore((s) => s.setPtyId)
  const resumeAgentPane = usePanesStore((s) => s.resumeAgentPane)
  const startNewAgentInPane = usePanesStore((s) => s.startNewAgentInPane)
  const closePane = usePanesStore((s) => s.closePane)

  // If a live xterm already exists for this pane (e.g. we're remounting after a
  // layout change), start in 'ready' so the terminal content is shown immediately
  // without flashing the "connecting" overlay again.
  const [status, setStatus] = useState<'mounting' | 'connecting' | 'ready' | 'error'>(() => {
    const entry = xtermRegistry.getEntry(pane.id)
    return entry?.connected ? 'ready' : 'mounting'
  })
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)

  // Keep ptyIdRef in sync so context menu paste can always find the current ptyId
  useEffect(() => { ptyIdRef.current = pane.ptyId ?? null }, [pane.ptyId])

  useEffect(() => {
    let disposed = false
    const queue = (): void => {
      if (!disposed) queueFitRef.current?.()
    }
    const frame = requestAnimationFrame(queue)
    const timer1 = setTimeout(queue, 80)
    const timer2 = setTimeout(queue, 200)

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      clearTimeout(timer1)
      clearTimeout(timer2)
    }
  }, [layoutKey])

  const handleCopy = useCallback(() => {
    const xterm = xtermRef.current
    if (!xterm) return
    const selection = xterm.getSelection()
    if (selection) navigator.clipboard.writeText(selection).catch(() => {})
    setContextMenu(null)
  }, [])

  const handlePaste = useCallback(() => {
    navigator.clipboard.readText().then((text) => {
      if (text) xtermRef.current?.paste(text)
    }).catch(() => {})
    setContextMenu(null)
  }, [])

  // Effect 1: attach the xterm instance for this pane.
  // Uses a registry so the instance (and its scrollback buffer) survives React
  // remounts that happen when the pane tree restructures during drag-drop.
  // The xterm is only truly disposed when the pane is explicitly closed.
  useEffect(() => {
    if (!containerRef.current) return

    const entry = xtermRegistry.getOrCreate(pane.id, () => {
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
      xterm.loadAddon(new WebLinksAddon((_event, uri) => {
        window.ipc.invoke('shell:open-external', uri).catch(() => {})
      }))
      try {
        const webglAddon = new WebglAddon()
        webglAddon.onContextLoss(() => {
          try { webglAddon.dispose() } catch { /* ignore */ }
        })
        xterm.loadAddon(webglAddon)
      } catch { /* fall back to xterm's DOM renderer */ }
      if (IS_WINDOWS) {
        const buildNumber = parseInt(window.osRelease?.split('.')[2] ?? '0', 10)
        xterm.options.windowsPty = { backend: 'conpty', buildNumber }
      }

      return { xterm, fitAddon }
    })

    // Attach the wrapper div (which xterm opened into) to our container.
    xtermRegistry.attach(pane.id, containerRef.current)

    const { xterm, fitAddon } = entry
    xtermRef.current = xterm
    fitAddonRef.current = fitAddon
    xterm.options.theme = pane.paneType === 'agent'
      ? { ...XTERM_THEME, cursor: 'transparent', cursorAccent: 'transparent' }
      : XTERM_THEME
    xterm.options.cursorBlink = pane.paneType !== 'agent'

    // Re-attach the key handler on every mount so the closure captures fresh
    // refs. attachCustomKeyEventHandler replaces the previous handler.
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
        navigator.clipboard.readText().then((text) => {
          if (text) xterm.paste(text)
        }).catch(() => {})
        return stop()
      }

      // Global app shortcuts — read overrides at call time so rebinds take effect immediately
      if (mod) {
        const hotkeys = buildHotkeys(useSettingsStore.getState().hotkeyOverrides)
        const dispatch: Record<string, () => void> = {
          [hotkeyKey(hotkeys.splitVertical)]:   () => { const p = store.getFocusedPane(); if (p) store.splitPane(p.id, 'vertical') },
          [hotkeyKey(hotkeys.splitHorizontal)]: () => { const p = store.getFocusedPane(); if (p) store.splitPane(p.id, 'horizontal') },
          [hotkeyKey(hotkeys.commandPalette)]:  () => store.toggleCommandPalette(),
          [hotkeyKey(hotkeys.sessionBrowser)]:  () => store.toggleSessionBrowser(),
          [hotkeyKey(hotkeys.closePane)]:       () => { const p = store.getFocusedPane(); if (p) store.closePane(p.id) },
          [hotkeyKey(hotkeys.zoomPane)]:        () => { if (store.zoomedPaneId) { store.unzoom() } else { const p = store.getFocusedPane(); if (p) store.zoomPane(p.id) } },
          [hotkeyKey(hotkeys.newTab)]:          () => store.addTab(),
          [hotkeyKey(hotkeys.closeTab)]:        () => { if (store.activeTabId) store.closeTab(store.activeTabId) },
          [hotkeyKey(hotkeys.toggleSidebar)]:   () => store.toggleSidebar(),
        }
        const fn = dispatch[eventKey(e)]
        if (fn) { fn(); return stop() }
      }

      if (!mod && !e.shiftKey && e.code === 'Escape') {
        if (store.sessionBrowserOpen || store.commandPaletteOpen) { store.closeOverlays(); return stop() }
      }

      return true
    })

    let pendingFit: number | null = null
    let delayedFit: ReturnType<typeof setTimeout> | null = null
    let lastFitSize: { width: number; height: number } | null = null
    const fitTerminal = (): void => {
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      const width = Math.round(rect.width)
      const height = Math.round(rect.height)
      if (width <= 0 || height <= 0) return
      if (lastFitSize?.width === width && lastFitSize.height === height) return
      lastFitSize = { width, height }
      try { fitAddon.fit() } catch { /* ignore */ }
    }
    const queueFit = (): void => {
      if (pendingFit !== null) cancelAnimationFrame(pendingFit)
      pendingFit = requestAnimationFrame(() => {
        pendingFit = null
        fitTerminal()
      })
      if (delayedFit !== null) clearTimeout(delayedFit)
      delayedFit = setTimeout(() => {
        delayedFit = null
        fitTerminal()
      }, 120)
    }
    const ro = new ResizeObserver(queueFit)
    queueFitRef.current = queueFit
    ro.observe(containerRef.current)
    if (containerRef.current.parentElement) ro.observe(containerRef.current.parentElement)

    // Block paste events from reaching xterm's internal textarea listener.
    // Without this, Ctrl+Shift+V triggers both our key handler AND xterm's
    // native paste handler, causing every paste to appear twice in the PTY.
    const container = containerRef.current
    const blockPaste = (e: ClipboardEvent): void => {
      e.stopPropagation()
      e.preventDefault()
    }
    container.addEventListener('paste', blockPaste, true)

    // Only show the connecting overlay on a true first mount (no prior PTY).
    if (!entry.connected) setStatus('connecting')

    return () => {
      if (pendingFit !== null) cancelAnimationFrame(pendingFit)
      if (delayedFit !== null) clearTimeout(delayedFit)
      container.removeEventListener('paste', blockPaste, true)
      ro.disconnect()
      xtermRef.current = null
      fitAddonRef.current = null
      queueFitRef.current = null

      // Detach the wrapper to off-screen storage — do NOT dispose.
      // The xterm instance and its full scrollback buffer survive until the
      // pane is explicitly closed via closePane().
      xtermRegistry.detach(pane.id)
    }
  }, [pane.id, pane.paneType, pane.agentKind])

  // Effect 2: connect to the PTY once a ptyId is available
  useEffect(() => {
    const xterm = xtermRef.current
    if (!xterm || status === 'mounting') return
    const terminal: XTerm = xterm

    if (pane.paneType === 'agent' && !pane.ptyId && pane.agentDisconnected) {
      setStatus('ready')
      setErrorMsg(pane.resumeError ?? pane.sessionDetectionError ?? null)
      return
    }

    if (pane.paneType === 'agent' && !pane.ptyId && (pane.resumeError || pane.sessionDetectionError)) {
      setStatus('error')
      setErrorMsg(pane.resumeError ?? pane.sessionDetectionError ?? 'Agent session is not recoverable')
      return
    }

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
    let queuedOutput: string[] = []
    let queuedOutputChars = 0
    let writeInFlight = false
    let outputPaused = false

    const pauseOutput = (ptyId: string): void => {
      if (outputPaused) return
      outputPaused = true
      window.ipc.send('pty:pause-output', ptyId)
    }

    const resumeOutput = (ptyId: string): void => {
      if (!outputPaused) return
      outputPaused = false
      window.ipc.send('pty:resume-output', ptyId)
    }

    const takeQueuedOutput = (): string | null => {
      const first = queuedOutput[0]
      if (!first) return null
      if (first.length <= XTERM_WRITE_CHUNK_CHARS) {
        queuedOutput.shift()
        queuedOutputChars -= first.length
        return first
      }
      const chunk = first.slice(0, XTERM_WRITE_CHUNK_CHARS)
      queuedOutput[0] = first.slice(XTERM_WRITE_CHUNK_CHARS)
      queuedOutputChars -= chunk.length
      return chunk
    }

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
      xtermRegistry.markConnected(pane.id)

      const drainOutput = (): void => {
        if (cancelled || writeInFlight) return
        const chunk = takeQueuedOutput()
        if (!chunk) {
          resumeOutput(ptyId)
          return
        }
        writeInFlight = true
        terminal.write(chunk, () => {
          writeInFlight = false
          if (cancelled) return
          if (queuedOutputChars <= XTERM_OUTPUT_RESUME_CHARS) resumeOutput(ptyId)
          drainOutput()
        })
      }

      const enqueueOutput = (data: string): void => {
        queuedOutput.push(data)
        queuedOutputChars += data.length
        if (queuedOutputChars >= XTERM_OUTPUT_PAUSE_CHARS) pauseOutput(ptyId)
        drainOutput()
      }

      unsubData = window.ipc.on('pty:data', (receivedId: unknown, data: unknown) => {
        if (receivedId === ptyId && typeof data === 'string' && !cancelled) {
          enqueueOutput(data)
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
      if (outputPaused && ptyIdRef.current) window.ipc.send('pty:resume-output', ptyIdRef.current)
      queuedOutput = []
      queuedOutputChars = 0
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
  }, [pane.id, pane.ptyId, pane.paneType, pane.agentDisconnected, pane.resumeError, pane.sessionDetectionError, status === 'mounting' ? 'mounting' : 'ready'])

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      hasSelection: !!(xtermRef.current?.getSelection()),
    })
  }, [])

  const disconnected = pane.paneType === 'agent' && !!pane.agentDisconnected && !pane.ptyId
  const disconnectedAt = pane.agentDisconnected?.at
    ? new Date(pane.agentDisconnected.at).toLocaleString()
    : null
  const exitDescription = pane.agentDisconnected
    ? pane.agentDisconnected.exitCode === 0
      ? 'Exited normally'
      : `Exited with code ${pane.agentDisconnected.exitCode ?? 'unknown'}`
    : ''

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
      {disconnected && (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(14, 16, 17, 0.72)',
          zIndex: 20,
          padding: 16,
          pointerEvents: 'auto',
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        >
          <div style={{
            width: 'min(520px, 100%)',
            backgroundColor: '#17191b',
            border: '1px solid #2a2d30',
            borderRadius: 6,
            boxShadow: '0 12px 36px rgba(0,0,0,0.45)',
            padding: 16,
            color: '#d4d4d4',
          }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
              Agent session disconnected
            </div>
            <div style={{ color: '#9da3aa', fontSize: 12, lineHeight: 1.5, marginBottom: 12 }}>
              The {agentLabel(pane.agentKind ?? 'claude')} process has exited. The terminal output is preserved, but this pane is no longer connected to a live agent.
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'auto minmax(0, 1fr)',
              gap: '6px 12px',
              fontSize: 12,
              lineHeight: 1.4,
              marginBottom: 14,
            }}>
              <span style={{ color: '#6f7780' }}>Agent</span>
              <span>{agentLabel(pane.agentKind ?? 'claude')}</span>
              <span style={{ color: '#6f7780' }}>Status</span>
              <span>{exitDescription}</span>
              {disconnectedAt && (
                <>
                  <span style={{ color: '#6f7780' }}>Disconnected</span>
                  <span>{disconnectedAt}</span>
                </>
              )}
              <span style={{ color: '#6f7780' }}>Directory</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={pane.cwd}>{pane.cwd}</span>
              <span style={{ color: '#6f7780' }}>Session</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={pane.sessionId}>
                {pane.sessionId ?? 'No session id captured'}
              </span>
            </div>
            {!pane.sessionId && (
              <div style={{
                marginBottom: 12,
                color: '#fbbf24',
                backgroundColor: '#211a08',
                border: '1px solid #49360b',
                borderRadius: 4,
                padding: '7px 9px',
                fontSize: 12,
              }}>
                This pane cannot resume the exact session because no session id was captured. Start a new session to keep using this pane.
              </div>
            )}
            {errorMsg && (
              <div style={{
                marginBottom: 12,
                color: '#f87171',
                backgroundColor: '#1e1010',
                border: '1px solid #3a1010',
                borderRadius: 4,
                padding: '7px 9px',
                fontSize: 12,
              }}>
                {errorMsg}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {pane.sessionId && (
                <button
                  data-window-drag-exempt="true"
                  onClick={() => resumeAgentPane(pane.id)}
                  style={{
                    backgroundColor: '#2d6cdf',
                    border: '1px solid #3979ee',
                    color: '#ffffff',
                    borderRadius: 4,
                    padding: '7px 12px',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Resume session
                </button>
              )}
              <button
                data-window-drag-exempt="true"
                onClick={() => startNewAgentInPane(pane.id)}
                style={{
                  backgroundColor: '#24272a',
                  border: '1px solid #3a3f44',
                  color: '#d4d4d4',
                  borderRadius: 4,
                  padding: '7px 12px',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Start new session
              </button>
              <button
                data-window-drag-exempt="true"
                onClick={() => closePane(pane.id)}
                style={{
                  backgroundColor: 'transparent',
                  border: '1px solid #3a3f44',
                  color: '#b8bec5',
                  borderRadius: 4,
                  padding: '7px 12px',
                  fontSize: 12,
                  cursor: 'pointer',
                  marginLeft: 'auto',
                }}
              >
                Close pane
              </button>
            </div>
          </div>
        </div>
      )}
      <div
        ref={containerRef}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 0,
          pointerEvents: disconnected ? 'none' : 'auto',
        }}
      />

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
