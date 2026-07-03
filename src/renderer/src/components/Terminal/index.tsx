import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { PaneLeaf, PtyReadyMetadata } from '../../../../shared/types'
import { usePanesStore } from '../../store/panes'
import { useSessionsStore } from '../../store/sessions'
import { DEFAULT_TERMINAL_SCROLLBACK_LINES, useSettingsStore } from '../../store/settings'
import { buildHotkeys, hotkeyKey, eventKey } from '../../utils/hotkeys'
import { buildTerminalKeyMap, bindingEventKey, bindingDisplay } from '../../utils/terminalKeyBindings'
import { agentLabel } from '../../utils/agents'
import * as xtermRegistry from '../../utils/xtermRegistry'
import { createDirectPtyDataHandler } from '../../terminal/ptyData'
import { applyBackend } from '../../terminal/rendering/backends'
import { getCapabilities } from '../../terminal/rendering/capabilities'
import { DirPicker } from '../DirPicker'
import { createShellPty } from './createShellPty'

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

const RESIZE_COL_DEBOUNCE_MS = 100
// Agent panes pay a leaked classic-renderer redraw on every resize in SIGWINCH;
// a longer debounce during drag reduces how many duplicate frames accumulate in
// scrollback. Shell panes keep the 100 ms value; they tolerate frequent resizes.
const AGENT_RESIZE_COL_DEBOUNCE_MS = 400
const RESIZE_DEBOUNCE_BUFFER_THRESHOLD = 200
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
  const shellCreatePaneRef = useRef<string | null>(null)
  const setPtyId = usePanesStore((s) => s.setPtyId)
  const resumeAgentPane = usePanesStore((s) => s.resumeAgentPane)
  const startNewAgentInPane = usePanesStore((s) => s.startNewAgentInPane)
  const closePane = usePanesStore((s) => s.closePane)
  const applyCwdRepair = usePanesStore((s) => s.applyCwdRepair)
  const repairSessionCwd = useSessionsStore((s) => s.repairSessionCwd)

  // If a live xterm already exists for this pane (e.g. we're remounting after a
  // layout change), start in 'ready' so the terminal content is shown immediately
  // without flashing the "connecting" overlay again.
  const [status, setStatus] = useState<'mounting' | 'connecting' | 'ready' | 'error'>(() => {
    const entry = xtermRegistry.getEntry(pane.id)
    return entry?.connected ? 'ready' : 'mounting'
  })
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const [repairPickerOpen, setRepairPickerOpen] = useState(false)
  const [repairError, setRepairError] = useState<string | null>(null)
  const [repairing, setRepairing] = useState(false)

  // Keep ptyIdRef in sync so context menu paste can always find the current ptyId
  useEffect(() => { ptyIdRef.current = pane.ptyId ?? null }, [pane.ptyId])

  // Copy/paste binding triggers drive the context-menu hint labels. Subscribed
  // so the labels update when the user rebinds them in Settings.
  const copyDisplay = useSettingsStore((s) => {
    const b = s.terminalKeyBindings.find((x) => x.id === 'copy')
    return b ? bindingDisplay(b.trigger) : 'Ctrl+C'
  })
  const pasteDisplay = useSettingsStore((s) => {
    const b = s.terminalKeyBindings.find((x) => x.id === 'paste')
    return b ? bindingDisplay(b.trigger) : 'Ctrl+V'
  })

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

  const repairAndResume = useCallback(async (newCwd: string): Promise<void> => {
    if (!pane.sessionId || repairing) return
    setRepairing(true)
    setRepairError(null)
    try {
      const result = await repairSessionCwd(pane.cwd, newCwd)
      if (!result.ok) {
        setRepairError(result.error ?? 'Directory repair failed')
        return
      }
      if (result.mapping) applyCwdRepair(result.mapping)
      setRepairPickerOpen(false)
      setRepairError(null)
      await resumeAgentPane(pane.id)
    } catch {
      setRepairError('Directory repair failed')
    } finally {
      setRepairing(false)
    }
  }, [applyCwdRepair, pane.cwd, pane.id, pane.sessionId, repairSessionCwd, repairing, resumeAgentPane])

  // Effect 1: attach the xterm instance for this pane.
  // Uses a registry so the instance (and its scrollback buffer) survives React
  // remounts that happen when the pane tree restructures during drag-drop.
  // The xterm is only truly disposed when the pane is explicitly closed.
  useEffect(() => {
    if (!containerRef.current) return

    const createXterm = (): { xterm: XTerm; fitAddon: FitAddon; backendHandle: { dispose(): void } } => {
      const theme = pane.paneType === 'agent'
        ? { ...XTERM_THEME, cursor: 'transparent', cursorAccent: 'transparent' }
        : XTERM_THEME

      const storeState = useSettingsStore.getState()
      const xterm = new XTerm({
        allowProposedApi: true,
        theme,
        fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
        fontSize: 13,
        lineHeight: 1.3,
        cursorBlink: pane.paneType !== 'agent',
        scrollback: storeState.terminalScrollbackLines ?? DEFAULT_TERMINAL_SCROLLBACK_LINES,
        scrollOnEraseInDisplay: true,
        allowTransparency: false,
        customGlyphs: true,
        minimumContrastRatio: storeState.terminalMinimumContrastRatio,
        rescaleOverlappingGlyphs: storeState.terminalRescaleOverlappingGlyphs,
        windowOptions: {
          getWinSizePixels: true,
          getCellSizePixels: true,
          getWinSizeChars: true,
        },
        linkHandler: {
          activate(_event, uri) {
            window.ipc.invoke('shell:open-external', uri).catch(() => {})
          },
        },
      })

      const fitAddon = new FitAddon()
      xterm.loadAddon(fitAddon)
      xterm.loadAddon(new WebLinksAddon((_event, uri) => {
        window.ipc.invoke('shell:open-external', uri).catch(() => {})
      }))

      const backendHandle = (() => {
        if (storeState.optimizedTerminalRenderer) {
          const { handle } = applyBackend(xterm, storeState.terminalGpuAcceleration, getCapabilities())
          return handle
        }
        // Legacy path: unconditional WebGL attempt with try/catch fallback
        try {
          const webglAddon = new WebglAddon()
          webglAddon.onContextLoss(() => {
            try { webglAddon.dispose() } catch { /* ignore */ }
          })
          xterm.loadAddon(webglAddon)
          return { dispose() { try { webglAddon.dispose() } catch { /* ignore */ } } }
        } catch {
          return { dispose() {} }
        }
      })()

      return { xterm, fitAddon, backendHandle }
    }

    // Both shell and agent panes use the registry so the xterm instance (and its
    // scrollback) survives remounts. The registry defers xterm.open() until the
    // wrapper is attached to a live container (see xtermRegistry.attach), which is
    // what made the old "direct open" shell path unnecessary.
    const entry = xtermRegistry.getOrCreate(pane.id, () => {
      const result = createXterm()
      return { xterm: result.xterm, fitAddon: result.fitAddon, backendHandle: result.backendHandle }
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
      // Step 1 — Shift+Enter: translate to Alt+Enter for agent CLIs. Both Codex
      // and Claude Code treat Alt+Enter as insert-newline without submitting.
      // MUST run before the terminal-binding lookup below: a terminal binding on
      // Shift+Enter is intentionally shadowed here for agent panes (documented
      // limitation, not a bug to fix without re-verifying Codex/Claude behavior).
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

      // Step 2 — Terminal key bindings (copy/paste and PTY signals).
      // Runs on ALL keydowns regardless of modifier, BEFORE the if (mod) app-
      // hotkey gate, so Alt-only combos (e.g. the default Alt+C interrupt) are
      // reachable. Bindings are read from settings at event time — no re-attach
      // needed when the user rebinds. On match the event is consumed (stop());
      // a 'suppress' entry consumes the key and sends nothing (a vacated default
      // trigger of a rebound signal binding).
      const entry = buildTerminalKeyMap(useSettingsStore.getState().terminalKeyBindings).get(bindingEventKey(e))
      if (entry) {
        if (entry.kind === 'suppress') return stop()
        const b = entry.binding
        switch (b.action.type) {
          case 'clipboard-copy': {
            // Always consume. Silent no-op when nothing is selected.
            const selection = xterm.getSelection()
            if (selection) navigator.clipboard.writeText(selection).catch(() => {})
            return stop()
          }
          case 'clipboard-paste': {
            // preventDefault (via stop()) suppresses the browser's native paste
            // event. The blockPaste capture listener below is the backstop that
            // guarantees no double-paste; keep both.
            navigator.clipboard.readText().then((text) => {
              if (text) xterm.paste(text)
            }).catch(() => {})
            return stop()
          }
          case 'pty-sequence': {
            const ptyId = ptyIdRef.current
            if (ptyId) window.ipc.send('pty:write', ptyId, b.action.sequence)
            return stop()
          }
          case 'text-macro': {
            const ptyId = ptyIdRef.current
            if (ptyId) window.ipc.send('pty:write', ptyId, b.action.text)
            return stop()
          }
        }
      }

      const mod = e.ctrlKey || e.metaKey
      const store = usePanesStore.getState()

      // Step 3 — Global app shortcuts (HotkeyId). Read overrides at call time
      // so rebinds take effect immediately.
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

    // Backstop paste blocker: stops native paste ClipboardEvents from reaching
    // xterm's internal textarea listener. The terminal-binding handler already
    // calls preventDefault on the Ctrl+V keydown, but this guard guarantees no
    // double-paste survives (e.g. programmatic paste, or a rebound paste trigger).
    // Keep it alongside the binding handler.
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

  // Effect 2: create a shell PTY when this pane needs one. Attachment happens
  // in the next effect after the ptyId is committed to pane state. The body is
  // extracted into createShellPty.ts so cancel-kill and retry-unblock are
  // unit-testable without xterm.
  useEffect(() => {
    if (status === 'mounting' || pane.paneType !== 'shell' || pane.ptyId) return
    if (shellCreatePaneRef.current === pane.id) return

    shellCreatePaneRef.current = pane.id
    setStatus('connecting')

    const handle = createShellPty(pane.cwd, {
      ipc: window.ipc,
      getInitialSize: () => {
        try { fitAddonRef.current?.fit() } catch { /* ignore */ }
        const term = xtermRef.current
        return { cols: term?.cols ?? 80, rows: term?.rows ?? 24 }
      },
      onPtyId: (ptyId) => {
        ptyIdRef.current = ptyId
        setPtyId(pane.id, ptyId)
      },
      onError: (msg) => {
        setStatus('error')
        setErrorMsg(msg)
      },
      releaseGuard: () => {
        if (shellCreatePaneRef.current === pane.id) shellCreatePaneRef.current = null
      },
    })
    return () => {
      handle.cancel()
    }
  }, [pane.id, pane.ptyId, pane.paneType, pane.cwd, setPtyId, status === 'mounting' ? 'mounting' : 'ready'])

  // Effect 3: connect to the PTY once a ptyId is available
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
    let unsubReady: (() => void) | undefined
    let dataDisposable: { dispose(): void } | undefined
    let resizeDisposable: { dispose(): void } | undefined
    let conptyDa1Handler: { dispose(): void } | undefined
    let lastResize: { cols: number; rows: number } | null = null
    let latestResize: { cols: number; rows: number } | null = null
    let pendingResizeTimer: ReturnType<typeof setTimeout> | null = null
    let suppressResizeUntil = 0

    function connect(ptyId: string): void {
      const isLayoutReattachment = xtermRegistry.getEntry(pane.id)?.connected === true
      ptyIdRef.current = ptyId
      setStatus('ready')
      xtermRegistry.markConnected(pane.id)

      const applyReadyMetadata = (metadata: PtyReadyMetadata): void => {
        if (cancelled) return
        if (metadata.windowsPty?.backend === 'conpty') {
          terminal.options.windowsPty = metadata.windowsPty
          conptyDa1Handler?.dispose()
          conptyDa1Handler = terminal.parser.registerCsiHandler({ final: 'c' }, (params) => {
            if (params.length === 0 || (params.length === 1 && params[0] === 0)) {
              if (!cancelled) window.ipc.send('pty:write', ptyId, '\x1b[?61;4c')
              return true
            }
            return false
          })
        }
      }

      unsubReady = window.ipc.on('pty:ready', (receivedId: unknown, event: unknown) => {
        if (receivedId !== ptyId || !event || typeof event !== 'object') return
        const metadata = event as PtyReadyMetadata
        if (typeof metadata.cwd === 'string') applyReadyMetadata(metadata)
      })
      window.ipc.invoke('pty:get-ready', ptyId).then((event) => {
        if (!event || typeof event !== 'object') return
        const metadata = event as PtyReadyMetadata
        if (typeof metadata.cwd === 'string') applyReadyMetadata(metadata)
      }).catch(() => {})

      unsubData = window.ipc.on(
        'pty:data',
        createDirectPtyDataHandler(ptyId, {
          write(data) {
            window.e2ePtyTrace?.terminalWrite(ptyId, data)
            terminal.write(data)
          },
        }, () => cancelled)
      )

      dataDisposable = terminal.onData((data) => {
        if (cancelled) return
        window.ipc.send('pty:write', ptyId, data)
      })

      const sendResize = (cols: number, rows: number): void => {
        if (lastResize?.cols === cols && lastResize.rows === rows) return
        lastResize = { cols, rows }
        window.ipc.send('pty:resize', ptyId, cols, rows)
      }

      const flushPendingResize = (): void => {
        pendingResizeTimer = null
        if (!latestResize) return
        sendResize(latestResize.cols, latestResize.rows)
        latestResize = null
      }

      const colDebounce = pane.paneType === 'agent' ? AGENT_RESIZE_COL_DEBOUNCE_MS : RESIZE_COL_DEBOUNCE_MS
      const queueResize = ({ cols, rows }: { cols: number; rows: number }): void => {
        if (lastResize?.cols === cols && lastResize.rows === rows) return
        if (Date.now() < suppressResizeUntil) {
          latestResize = { cols, rows }
          if (!pendingResizeTimer) pendingResizeTimer = setTimeout(flushPendingResize, colDebounce)
          return
        }
        const bufferIsSmall = terminal.buffer.normal.length < RESIZE_DEBOUNCE_BUFFER_THRESHOLD
        if (!lastResize) {
          if (pendingResizeTimer) {
            clearTimeout(pendingResizeTimer)
            pendingResizeTimer = null
            latestResize = null
          }
          sendResize(cols, rows)
          return
        }

        if (bufferIsSmall && lastResize.rows === rows) {
          latestResize = { cols, rows }
          if (!pendingResizeTimer) pendingResizeTimer = setTimeout(flushPendingResize, colDebounce)
          return
        }

        if (lastResize.rows !== rows) {
          sendResize(lastResize.cols, rows)
        }
        latestResize = { cols, rows }
        if (pendingResizeTimer) return
        pendingResizeTimer = setTimeout(flushPendingResize, colDebounce)
      }
      resizeDisposable = terminal.onResize(queueResize)
      suppressResizeUntil = Date.now() + 750
      try { fitAddonRef.current?.fit() } catch { /* ignore */ }
      // A split reparents and remounts the existing terminal while nested
      // Allotments are still resolving their geometry. Keep the live PTY at
      // its last stable size until the normal agent debounce observes the
      // settled layout. New/deferred PTYs still need an immediate first size
      // so their process can spawn at the fitted dimensions.
      if (isLayoutReattachment) {
        latestResize = { cols: terminal.cols, rows: terminal.rows }
        pendingResizeTimer = setTimeout(flushPendingResize, colDebounce)
      } else {
        sendResize(terminal.cols, terminal.rows)
      }
    }

    if (pane.ptyId) connect(pane.ptyId)

    return () => {
      cancelled = true
      if (pendingResizeTimer) clearTimeout(pendingResizeTimer)
      unsubData?.()
      unsubReady?.()
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
          padding: '6px 8px', backgroundColor: '#1e1010',
          border: '1px solid #3a1010', borderRadius: 4,
          fontSize: 11, color: '#f87171', zIndex: 2,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ flex: 1 }}>{errorMsg}</span>
          {pane.paneType === 'agent' && pane.sessionId && (
            <button
              data-window-drag-exempt="true"
              onClick={() => {
                setRepairError(null)
                setRepairPickerOpen(true)
              }}
              style={{
                backgroundColor: '#24272a',
                border: '1px solid #3a3f44',
                color: '#d4d4d4',
                borderRadius: 4,
                padding: '4px 8px',
                fontSize: 11,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              Repair directory
            </button>
          )}
          {pane.paneType === 'agent' && (
            <button
              data-window-drag-exempt="true"
              onClick={() => startNewAgentInPane(pane.id)}
              style={{
                backgroundColor: '#24272a',
                border: '1px solid #3a3f44',
                color: '#d4d4d4',
                borderRadius: 4,
                padding: '4px 8px',
                fontSize: 11,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              Start new session
            </button>
          )}
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
              {pane.sessionId && (
                <button
                  data-window-drag-exempt="true"
                  onClick={() => {
                    setRepairError(null)
                    setRepairPickerOpen(true)
                  }}
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
                  Repair directory
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
      {repairPickerOpen && (
        <DirPicker
          title="Repair project directory"
          description="Choose the current folder for this project. The pane will resume after repair."
          initial={pane.cwd}
          confirmLabel={repairing ? 'Repairing...' : 'Repair and resume'}
          skipLabel="Cancel"
          error={repairError}
          onConfirm={(dir) => { void repairAndResume(dir) }}
          onSkip={() => {
            if (repairing) return
            setRepairError(null)
            setRepairPickerOpen(false)
          }}
        />
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
            <span style={{ float: 'right', opacity: 0.4, fontSize: 11 }}>{copyDisplay}</span>
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
            <span style={{ float: 'right', opacity: 0.4, fontSize: 11 }}>{pasteDisplay}</span>
          </button>
        </div>
      )}
    </div>
  )
}
