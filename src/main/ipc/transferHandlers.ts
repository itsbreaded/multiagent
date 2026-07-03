import { BrowserWindow } from 'electron'
import type { PaneSplitTransferPayload, PaneSwapTransferPayload, PaneTransferPayload, SpawnInTabPayload, Tab } from '../../shared/types'
import type { WindowManager } from '../window/WindowManager'
import type { IpcRegistrar } from './ipcRegistrar'
import type { createAckProtocol } from './ackProtocol'

let remoteFocusRequestSeq = 0
let remoteSpawnRequestSeq = 0
let focusTargetVersionSeq = 0
let tabReleaseSeq = 0

export function registerTransferHandlers(deps: {
  registrar: IpcRegistrar
  ack: ReturnType<typeof createAckProtocol>
  windowManager: WindowManager
  getPrimaryWindow: () => BrowserWindow | null
  flushDirectOutput: (ptyId: string) => void
  registerWindowHandlers: (win: BrowserWindow) => void
}): void {
  const { registrar, ack, windowManager, getPrimaryWindow, flushDirectOutput, registerWindowHandlers } = deps
  registrar.handle('tab:tear-off', async (e, tabJson: string, ptyIds: string[], screenX: number, screenY: number) => {
    const fromWin = BrowserWindow.fromWebContents(e.sender) ?? getPrimaryWindow()
    if (!fromWin) return null
    const tab = JSON.parse(tabJson) as Tab
    const newWin = windowManager.createDetachedWindow(
      fromWin,
      screenX,
      screenY,
      { mode: 'detached', tab, ptyIds }
    )
    windowManager.prepareDetachedTab(newWin.id, [tab.id])
    registerWindowHandlers(newWin)
    return { windowId: newWin.id }
  })

  registrar.handle('window:focus-for-tab', (_e, tabId: string) => {
    return windowManager.focusWindowForTab(tabId)
  })

  // Immediate focus relay: detached window clicked a pane → broadcast to all other windows.
  registrar.on('pane:focus-changed', (e, windowId: number, tabId: string, paneId: string) => {
    const senderWin = BrowserWindow.fromWebContents(e.sender)
    if (!senderWin) return
    windowManager.broadcastExcept(senderWin.id, 'pane:focus-changed', windowId, tabId, paneId)
  })

  registrar.on('focus:target-report', (e, tabId: string, paneId: string) => {
    const senderWin = BrowserWindow.fromWebContents(e.sender)
    if (!senderWin || typeof tabId !== 'string' || typeof paneId !== 'string') return
    windowManager.broadcastAll('focus:target-changed', {
      windowId: senderWin.id,
      tabId,
      paneId,
      version: ++focusTargetVersionSeq,
    })
  })

  registrar.handle('window:focus-pane', (_e, tabId: string, paneId: string) => {
    const winId = windowManager.getWindowIdForTab(tabId)
    if (winId === null) return false
    const expectedGeneration = windowManager.getOwnershipGeneration(tabId)
    const win = windowManager.getWindowById(winId)
    if (!win || win.isDestroyed()) return false

    const requestId = `${Date.now()}:${++remoteFocusRequestSeq}`
    const focusTarget = (): void => {
      if (
        windowManager.getWindowIdForTab(tabId) !== winId ||
        windowManager.getOwnershipGeneration(tabId) !== expectedGeneration
      ) return
      const currentWin = windowManager.getWindowById(winId)
      if (!currentWin || currentWin.isDestroyed()) return
      if (currentWin.isMinimized()) currentWin.restore()
      currentWin.focus()
    }
    void ack.waitForAck(win.id, 'pane:focus-remote-applied', requestId, () => {
      win.webContents.send('pane:focus-remote', tabId, paneId, requestId)
    }).then(focusTarget)
    return true
  })

  registrar.handle('tab:spawn-in-project', async (_e, tabId: string, payload: SpawnInTabPayload) => {
    if (
      typeof tabId !== 'string' ||
      !payload ||
      typeof payload !== 'object' ||
      (payload.paneType !== 'agent' && payload.paneType !== 'shell') ||
      (payload.agentKind !== undefined && payload.agentKind !== 'claude' && payload.agentKind !== 'codex') ||
      typeof payload.cwd !== 'string' ||
      (payload.direction !== 'vertical' && payload.direction !== 'horizontal')
    ) return false

    const winId = windowManager.getWindowIdForTab(tabId)
    if (winId === null) return false
    const expectedGeneration = windowManager.getOwnershipGeneration(tabId)
    const win = windowManager.getWindowById(winId)
    if (!win || win.isDestroyed()) return false

    const requestId = `${Date.now()}:${++remoteSpawnRequestSeq}`
    const result = await ack.waitForAckWithResult(win.id, 'tab:spawn-in-project-applied', requestId, () => {
      win.webContents.send('tab:spawn-in-project-remote', tabId, payload, requestId)
    }, 3000)
    if (
      result.ok &&
      windowManager.getWindowIdForTab(tabId) === winId &&
      windowManager.getOwnershipGeneration(tabId) === expectedGeneration
    ) {
      const currentWin = windowManager.getWindowById(winId)
      if (currentWin && !currentWin.isDestroyed()) {
        if (currentWin.isMinimized()) currentWin.restore()
        currentWin.focus()
      }
    }
    return result.ok
  })

  registrar.handle('tab:adopt', (e, ptyIds: string[]) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return false
    for (const ptyId of ptyIds as string[]) {
      windowManager.routePty(ptyId, win.webContents.id)
      flushDirectOutput(ptyId)
    }
    return true
  })

  registrar.on('tab:detached-ready', (e, tabId: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || typeof tabId !== 'string') return
    windowManager.markDetachedTabReady(win.id, tabId)
  })

  // Live tab state sync: detached window pushes its tab list; we update routing and forward to others.
  registrar.on('tab:state-sync', (e, payloadOrWindowId: unknown, tabsJsonArg?: unknown, activeTabIdArg?: unknown) => {
    const senderWin = BrowserWindow.fromWebContents(e.sender)
    if (!senderWin) return
    let windowId: number
    let tabsJson: string
    let activeTabId: string | undefined
    let version: number | undefined
    if (typeof payloadOrWindowId === 'object' && payloadOrWindowId !== null) {
      const payload = payloadOrWindowId as { windowId?: unknown; tabs?: unknown; activeTabId?: unknown; version?: unknown }
      if (typeof payload.windowId !== 'number' || !Array.isArray(payload.tabs)) return
      windowId = payload.windowId
      tabsJson = JSON.stringify(payload.tabs)
      activeTabId = typeof payload.activeTabId === 'string' ? payload.activeTabId : undefined
      version = typeof payload.version === 'number' ? payload.version : undefined
    } else {
      if (typeof payloadOrWindowId !== 'number' || typeof tabsJsonArg !== 'string') return
      windowId = payloadOrWindowId
      tabsJson = tabsJsonArg
      activeTabId = typeof activeTabIdArg === 'string' ? activeTabIdArg : undefined
    }
    try {
      const tabs = JSON.parse(tabsJson) as Array<{ id: string }>
      const acceptedIds = windowManager.recordDetachedTabsForWindow(senderWin.id, tabs.map((t) => t.id), version)
      tabsJson = JSON.stringify(tabs.filter((t) => acceptedIds.includes(t.id)))
    } catch { /* ignore malformed */ }
    windowManager.broadcastExcept(senderWin.id, 'tab:state-sync', windowId, tabsJson, activeTabId)
  })

  // Move a pane (with its PTY) to a tab in another window.
  registrar.handle('pane:transfer', async (e, payload: PaneTransferPayload) => {
    try {
      const senderWin = BrowserWindow.fromWebContents(e.sender)
      if (!senderWin || !payload?.pane || typeof payload.targetTabId !== 'string') return false
      const targetWindowId = payload.targetWindowId ?? windowManager.getWindowIdForTab(payload.targetTabId) ?? senderWin.id
      if (targetWindowId === null) return false
      const toWin = windowManager.getWindowById(targetWindowId)
      if (!toWin || toWin.isDestroyed()) return false
      const sourceWin = windowManager.getWindowById(payload.sourceWindowId)
      if (!sourceWin || sourceWin.isDestroyed()) return false
      if (payload.sourceWindowId === targetWindowId) {
        sourceWin.webContents.send('pane:move-remote', payload.pane.id, payload.targetTabId)
        return true
      }
      const transferId = `${Date.now()}:${Math.random().toString(36).slice(2)}`
      const committed = await waitForAck(toWin, 'pane:received-applied', transferId, () => {
        toWin.webContents.send('pane:received', JSON.stringify(payload.pane), payload.targetTabId, transferId)
      })
      if (!committed || toWin.isDestroyed()) {
        // The target optimistically added the pane on pane:received but the transfer never
        // committed (no PTY routing will follow). Tell it to discard the pane so it does not
        // linger as a dead, output-less duplicate. The source still holds its working pane.
        // See specs/atomic-state-audit-followup #2.
        if (!toWin.isDestroyed()) toWin.webContents.send('pane:transfer-rolledback', payload.pane.id)
        return false
      }
      if (payload.pane.ptyId) {
        windowManager.transferPty(payload.pane.ptyId, toWin)
        flushDirectOutput(payload.pane.ptyId)
      }
      sourceWin.webContents.send('pane:remove-remote', payload.pane.id)
      return true
    } catch {
      return false
    }
  })

  // Reusable ack helper: send `trigger()`, wait for renderer to send `channel` with matching `id`.
  function waitForAck(win: BrowserWindow, channel: string, id: string, trigger: () => void, ms = 1000): Promise<boolean> {
    return ack.waitForAck(win.id, channel, id, trigger, ms)
  }

  // Move a pane to a directional split in another window, rerouting its PTY.
  registrar.handle('pane:split-transfer', async (_e, payload: PaneSplitTransferPayload) => {
    try {
      const { pane, sourceWindowId, targetPaneId, direction, sourceBefore, targetWindowId } = payload
      if (pane.id === targetPaneId) return false  // self-drop is a no-op; never remove-after-noop-insert
      const srcWin = windowManager.getWindowById(sourceWindowId)
      const tgtWin = windowManager.getWindowById(targetWindowId)
      if (!srcWin || srcWin.isDestroyed() || !tgtWin || tgtWin.isDestroyed()) return false
      const transferId = `split:${Date.now()}:${Math.random().toString(36).slice(2)}`
      const committed = await waitForAck(tgtWin, 'renderer:insert-at-split-applied', transferId, () => {
        tgtWin.webContents.send('renderer:insert-at-split', JSON.stringify(pane), targetPaneId, direction, sourceBefore, transferId)
      })
      if (!committed || tgtWin.isDestroyed()) return false
      srcWin.webContents.send('renderer:remove-pane', pane.id)
      if (pane.ptyId) {
        windowManager.transferPty(pane.ptyId, tgtWin)
        flushDirectOutput(pane.ptyId)
      }
      // Raise and focus the target window (cross-window split follows the pane — spec decision 4)
      if (sourceWindowId !== targetWindowId && !tgtWin.isDestroyed()) {
        tgtWin.show()
        tgtWin.focus()
      }
      return true
    } catch {
      return false
    }
  })

  // Swap two panes across windows, rerouting both PTYs.
  registrar.handle('pane:swap-transfer', async (_e, payload: PaneSwapTransferPayload) => {
    try {
      const { sourcePane, sourceWindowId, targetPane, targetWindowId } = payload
      const srcWin = windowManager.getWindowById(sourceWindowId)
      const tgtWin = windowManager.getWindowById(targetWindowId)
      if (!srcWin || srcWin.isDestroyed() || !tgtWin || tgtWin.isDestroyed()) return false
      if (sourceWindowId === targetWindowId) return false  // caller should use local store for same-window
      const id1 = `swap:src:${Date.now()}:${Math.random().toString(36).slice(2)}`
      const id2 = `swap:tgt:${Date.now()}:${Math.random().toString(36).slice(2)}`
      // Commit in both windows before rerouting either PTY (multi-window invariant)
      const [ok1, ok2] = await Promise.all([
        waitForAck(srcWin, 'renderer:replace-pane-applied', id1, () =>
          srcWin.webContents.send('renderer:replace-pane', sourcePane.id, JSON.stringify(targetPane), id1)),
        waitForAck(tgtWin, 'renderer:replace-pane-applied', id2, () =>
          tgtWin.webContents.send('renderer:replace-pane', targetPane.id, JSON.stringify(sourcePane), id2)),
      ])
      if (!ok1 || !ok2) {
        // Partial commit: roll back whichever side applied so we never leave a half-swapped tree
        // with a stale PTY route. The renderer applies synchronously before acking, so a missing
        // ack means that side did not apply; only undo the side that acked. PTYs are untouched here
        // (reroute happens only after both commit), so restoring the tree is sufficient.
        if (ok1 && !srcWin.isDestroyed()) {
          srcWin.webContents.send('renderer:replace-pane', targetPane.id, JSON.stringify(sourcePane), `${id1}:rollback`)
        }
        if (ok2 && !tgtWin.isDestroyed()) {
          tgtWin.webContents.send('renderer:replace-pane', sourcePane.id, JSON.stringify(targetPane), `${id2}:rollback`)
        }
        return false
      }
      if (sourcePane.ptyId) { windowManager.transferPty(sourcePane.ptyId, tgtWin); flushDirectOutput(sourcePane.ptyId) }
      if (targetPane.ptyId) { windowManager.transferPty(targetPane.ptyId, srcWin); flushDirectOutput(targetPane.ptyId) }
      // No window raise/focus for swap — view stays put (spec decision 4)
      return true
    } catch {
      return false
    }
  })

  // Pull a detached tab back to the requesting window.
  registrar.handle('tab:bring-home', (e, tabId: string) => {
    const targetWindowId = windowManager.getWindowIdForTab(tabId)
    if (targetWindowId === null) return false
    const sourceWin = windowManager.getWindowById(targetWindowId)
    if (!sourceWin || sourceWin.isDestroyed()) return false
    // Unrecord before sending release so stale syncs and unregister() don't re-process this tab.
    windowManager.unrecordTab(tabId)
    sourceWin.webContents.send('tab:release', tabId)
    const callerWin = BrowserWindow.fromWebContents(e.sender)
    callerWin?.webContents.send('tab:return', tabId)
    return true
  })

  // Reattach: a detached window moves one of its own tabs back to the primary window.
  // Mirror of tab:bring-home, but the SENDER is the source (the detached window) and the
  // destination is the primary window. Unrecording first means the detached window's
  // close-time return (if this empties it) and any in-flight sync won't duplicate the tab.
  registrar.handle('tab:reattach-home', (e, tabId: string) => {
    const callerWin = BrowserWindow.fromWebContents(e.sender)
    if (!callerWin) return false
    const primaryWin = windowManager.getPrimaryWindow()
    if (!primaryWin || primaryWin.isDestroyed() || primaryWin.id === callerWin.id) return false
    windowManager.unrecordTab(tabId)
    callerWin.webContents.send('tab:release', tabId)
    primaryWin.webContents.send('tab:return', tabId)
    return true
  })

  registrar.handle('tab:absorb', async (e, tabJson: string, ptyIds: string[], sourceWindowId: number) => {
    const toWin = BrowserWindow.fromWebContents(e.sender)
    if (!toWin) return false
    let tab: Tab
    try {
      tab = JSON.parse(tabJson) as Tab
    } catch {
      return false
    }

    const sourceWin = windowManager.getWindowById(sourceWindowId)
    if (!sourceWin || sourceWin.isDestroyed()) return false

    const releaseId = `${Date.now()}:${++tabReleaseSeq}`
    const released = await waitForAck(sourceWin, 'tab:release-applied', releaseId, () => {
      sourceWin.webContents.send(
        'tab:release',
        tab.id,
        windowManager.isDetachedWindow(toWin.id) ? toWin.id : undefined,
        releaseId,
      )
    })
    // On failure the source has NOT yet touched its copy of the tab (it only acked the
    // release; finalize is deferred to tab:absorb-committed below), so there is nothing to
    // roll back here — the absorber discards its optimistic copy on the falsy result.
    if (!released || toWin.isDestroyed()) return false

    windowManager.unrecordTab(tab.id)
    if (windowManager.isDetachedWindow(toWin.id)) {
      windowManager.recordDetachedTab(toWin.id, [tab.id])
    }
    for (const ptyId of ptyIds as string[]) {
      windowManager.transferPty(ptyId, toWin)
      flushDirectOutput(ptyId)
    }
    // PTYs are now routed to the absorbing window; only now is it safe for the source to
    // drop/detach its copy. Without this commit the source either lost the tab before the
    // transfer was confirmed (data loss) or never released it at all.
    if (!sourceWin.isDestroyed()) {
      sourceWin.webContents.send(
        'tab:absorb-committed',
        tab.id,
        windowManager.isDetachedWindow(toWin.id) ? toWin.id : undefined,
      )
    }
    return true
  })

}
