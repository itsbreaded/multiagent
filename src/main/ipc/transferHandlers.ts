import { BrowserWindow } from 'electron'
import type { PaneSplitTransferPayload, PaneSwapTransferPayload, PaneTransferPayload, SpawnInTabPayload, Tab } from '../../shared/types'
import type { WindowManager } from '../window/WindowManager'
import type { IpcRegistrar } from './ipcRegistrar'
import type { createAckProtocol } from './ackProtocol'

let remoteFocusRequestSeq = 0
let remoteSpawnRequestSeq = 0
let focusTargetVersionSeq = 0
let tabReleaseSeq = 0
const tearOffTimers = new Map<string, NodeJS.Timeout>()
const pendingTabAbsorbs = new Map<string, { tabId: string; targetWindowId: number }>()

function trySend(win: BrowserWindow, channel: string, ...args: unknown[]): boolean {
  try {
    if (win.isDestroyed()) return false
    win.webContents.send(channel, ...args)
    return true
  } catch {
    // BrowserWindow#isDestroyed() and webContents.send() are not atomic.
    // Renderer notifications during teardown are best effort.
    return false
  }
}

export function registerTransferHandlers(deps: {
  registrar: IpcRegistrar
  ack: ReturnType<typeof createAckProtocol>
  windowManager: WindowManager
  getPrimaryWindow: () => BrowserWindow | null
  flushDirectOutput: (ptyId: string) => void
  registerWindowHandlers: (win: BrowserWindow) => void
}): void {
  const { registrar, ack, windowManager, getPrimaryWindow, flushDirectOutput, registerWindowHandlers } = deps
  windowManager.configurePendingTabTransferCleanup((transferId) => {
    const timer = tearOffTimers.get(transferId)
    if (timer) clearTimeout(timer)
    tearOffTimers.delete(transferId)
  })
  registrar.handle('tab:tear-off', async (e, tabJson: string, ptyIds: string[], screenX: number, screenY: number, transferId: string) => {
    const fromWin = BrowserWindow.fromWebContents(e.sender) ?? getPrimaryWindow()
    if (!fromWin || typeof transferId !== 'string' || !transferId) return null
    const tab = JSON.parse(tabJson) as Tab
    const newWin = windowManager.createDetachedWindow(
      fromWin,
      screenX,
      screenY,
      { mode: 'detached', tab, ptyIds, transferId }
    )
    if (!windowManager.prepareTabTearOff(transferId, fromWin.id, newWin.id, tab.id, ptyIds)) {
      newWin.close()
      return null
    }
    registerWindowHandlers(newWin)
    const timer = setTimeout(() => {
      tearOffTimers.delete(transferId)
      const canceled = windowManager.cancelPendingTabTransfer(transferId)
      if (canceled && !fromWin.isDestroyed()) {
        // The source renderer intentionally remains unchanged on timeout.
      }
    }, 5000)
    tearOffTimers.set(transferId, timer)
    return { windowId: newWin.id, transferId }
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
      trySend(win, 'pane:focus-remote', tabId, paneId, requestId)
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
      trySend(win, 'tab:spawn-in-project-remote', tabId, payload, requestId)
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

  registrar.handle('tab:adopt', (e, ptyIds: string[], transferId?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return false
    if (typeof transferId === 'string') {
      const transfer = windowManager.getPendingTabTransfer(transferId)
      if (!transfer || transfer.targetWindowId !== win.id || transfer.phase !== 'pending') return false
      if (transfer.ptyIds.length !== ptyIds.length || transfer.ptyIds.some((ptyId) => !ptyIds.includes(ptyId))) return false
      const sourceWin = windowManager.getWindowById(transfer.sourceWindowId)
      if (!sourceWin || sourceWin.isDestroyed() || windowManager.isWindowClosing(sourceWin.id)) return false
      if (windowManager.getOwnershipGeneration(transfer.tabId) !== transfer.sourceGeneration) return false
      if (transfer.ptyIds.some((ptyId) => windowManager.getPtyOwner(ptyId) !== sourceWin.webContents.id)) return false
      // Adoption is a preflight. The PTY route changes only in detached-ready,
      // after the target renderer has mounted its local tab.
      return true
    }
    for (const ptyId of ptyIds as string[]) {
      windowManager.routePty(ptyId, win.webContents.id)
      flushDirectOutput(ptyId)
    }
    return true
  })

  registrar.on('tab:detached-ready', (e, tabId: string, transferId?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || typeof tabId !== 'string') return
    if (typeof transferId === 'string') {
      const transfer = windowManager.markTabTransferReady(transferId)
      if (!transfer || transfer.targetWindowId !== win.id || transfer.tabId !== tabId) return
      const sourceWin = windowManager.getWindowById(transfer.sourceWindowId)
      if (!sourceWin || sourceWin.isDestroyed() || windowManager.isWindowClosing(sourceWin.id) || windowManager.isWindowClosing(win.id)) {
        windowManager.cancelPendingTabTransfer(transferId)
        return
      }
      if (windowManager.getOwnershipGeneration(tabId) !== transfer.sourceGeneration) {
        windowManager.cancelPendingTabTransfer(transferId)
        return
      }
      if (transfer.ptyIds.some((ptyId) => windowManager.getPtyOwner(ptyId) !== sourceWin.webContents.id)) {
        windowManager.cancelPendingTabTransfer(transferId)
        return
      }
      for (const ptyId of transfer.ptyIds) {
        windowManager.transferPty(ptyId, win)
        flushDirectOutput(ptyId)
      }
      windowManager.recordDetachedTab(win.id, [tabId])
      if (windowManager.isWindowClosing(sourceWin.id) || sourceWin.isDestroyed() || win.isDestroyed()) {
        windowManager.cancelPendingTabTransfer(transferId)
        return
      }
      const committed = windowManager.commitPendingTabTransfer(transferId)
      if (!committed) return
      const timer = tearOffTimers.get(transferId)
      if (timer) clearTimeout(timer)
      tearOffTimers.delete(transferId)
      trySend(sourceWin, 'tab:absorb-committed', tabId, win.id, transferId)
      trySend(win, 'tab:absorb-committed', tabId, win.id, transferId)
      return
    }
    windowManager.markDetachedTabReady(win.id, tabId)
  })

  registrar.handle('tab:tear-off-cancel', (e, transferId: string) => {
    if (typeof transferId !== 'string') return false
    const transfer = windowManager.getPendingTabTransfer(transferId)
    const sender = BrowserWindow.fromWebContents(e.sender)
    if (!transfer || !sender || (transfer.sourceWindowId !== sender.id && transfer.targetWindowId !== sender.id)) return false
    const timer = tearOffTimers.get(transferId)
    if (timer) clearTimeout(timer)
    tearOffTimers.delete(transferId)
    return windowManager.cancelPendingTabTransfer(transferId) !== null
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
      if (typeof payload.windowId !== 'number' || payload.windowId !== senderWin.id || !Array.isArray(payload.tabs)) return
      windowId = payload.windowId
      tabsJson = JSON.stringify(payload.tabs)
      activeTabId = typeof payload.activeTabId === 'string' ? payload.activeTabId : undefined
      version = typeof payload.version === 'number' ? payload.version : undefined
    } else {
      if (typeof payloadOrWindowId !== 'number' || payloadOrWindowId !== senderWin.id || typeof tabsJsonArg !== 'string') return
      windowId = payloadOrWindowId
      tabsJson = tabsJsonArg
      activeTabId = typeof activeTabIdArg === 'string' ? activeTabIdArg : undefined
    }
    try {
      let tabs = JSON.parse(tabsJson) as Array<{ id: string }>
      const pendingForWindow = Array.from(pendingTabAbsorbs.values())
        .filter((pending) => pending.targetWindowId === senderWin.id)
      if (pendingForWindow.length > 0) {
        const blockedIds = new Set(pendingForWindow.map((pending) => pending.tabId))
        tabs = tabs.filter((tab) => !blockedIds.has(tab.id))
      }
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
        trySend(sourceWin, 'pane:move-remote', payload.pane.id, payload.targetTabId)
        return true
      }
      const transferId = `${Date.now()}:${Math.random().toString(36).slice(2)}`
      const committed = await waitForAck(toWin, 'pane:received-applied', transferId, () => {
        trySend(toWin, 'pane:received', JSON.stringify(payload.pane), payload.targetTabId, transferId)
      })
      if (!committed || toWin.isDestroyed()) {
        // The target optimistically added the pane on pane:received but the transfer never
        // committed (no PTY routing will follow). Tell it to discard the pane so it does not
        // linger as a dead, output-less duplicate. The source still holds its working pane.
        // See specs/atomic-state-audit-followup #2.
        trySend(toWin, 'pane:transfer-rolledback', payload.pane.id)
        return false
      }
      if (payload.pane.ptyId) {
        windowManager.transferPty(payload.pane.ptyId, toWin)
        flushDirectOutput(payload.pane.ptyId)
      }
      trySend(sourceWin, 'pane:remove-remote', payload.pane.id)
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
        trySend(tgtWin, 'renderer:insert-at-split', JSON.stringify(pane), targetPaneId, direction, sourceBefore, transferId)
      })
      if (!committed || tgtWin.isDestroyed()) return false
      trySend(srcWin, 'renderer:remove-pane', pane.id)
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
          trySend(srcWin, 'renderer:replace-pane', sourcePane.id, JSON.stringify(targetPane), id1)),
        waitForAck(tgtWin, 'renderer:replace-pane-applied', id2, () =>
          trySend(tgtWin, 'renderer:replace-pane', targetPane.id, JSON.stringify(sourcePane), id2)),
      ])
      if (!ok1 || !ok2) {
        // Partial commit: roll back whichever side applied so we never leave a half-swapped tree
        // with a stale PTY route. The renderer applies synchronously before acking, so a missing
        // ack means that side did not apply; only undo the side that acked. PTYs are untouched here
        // (reroute happens only after both commit), so restoring the tree is sufficient.
        if (ok1 && !srcWin.isDestroyed()) {
          trySend(srcWin, 'renderer:replace-pane', targetPane.id, JSON.stringify(sourcePane), `${id1}:rollback`)
        }
        if (ok2 && !tgtWin.isDestroyed()) {
          trySend(tgtWin, 'renderer:replace-pane', sourcePane.id, JSON.stringify(targetPane), `${id2}:rollback`)
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
  registrar.handle('tab:bring-home', async (e, tabId: string) => {
    // A tab just torn off is staged in pendingDetachedWindowTabs before the new window finishes
    // booting + the tab:adopt/tab:detached-ready handshake that populates real ownership. If the
    // primary closes the tab in that window, getWindowIdForTab would return null and silently
    // never send tab:release, permanently orphaning the tab in the detached window (no retry, no
    // notification). Wait for the handshake to land (or fail fast if the tab isn't pending at all).
    const targetWindowId = windowManager.getWindowIdForTab(tabId) ?? await windowManager.waitForTabOwnership(tabId)
    if (targetWindowId === null) return false
    const sourceWin = windowManager.getWindowById(targetWindowId)
    if (!sourceWin || sourceWin.isDestroyed()) return false
    // Unrecord before sending release so stale syncs and unregister() don't re-process this tab.
    windowManager.unrecordTab(tabId)
    trySend(sourceWin, 'tab:release', tabId)
    const callerWin = BrowserWindow.fromWebContents(e.sender)
    if (callerWin) trySend(callerWin, 'tab:return', tabId)
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
    trySend(callerWin, 'tab:release', tabId)
    trySend(primaryWin, 'tab:return', tabId)
    return true
  })

  registrar.handle('tab:absorb', async (e, tabJson: string, ptyIds: string[], sourceWindowId: number, dropIndex?: number) => {
    const toWin = BrowserWindow.fromWebContents(e.sender)
    if (!toWin || typeof sourceWindowId !== 'number' || sourceWindowId === toWin.id) return false
    if (windowManager.isWindowClosing(toWin.id) || toWin.isDestroyed()) return false
    let tab: Tab
    try {
      tab = JSON.parse(tabJson) as Tab
    } catch {
      return false
    }

    if (!tab || typeof tab.id !== 'string' || !Array.isArray(ptyIds) || !ptyIds.every((id) => typeof id === 'string')) return false
    if (new Set(ptyIds).size !== ptyIds.length) return false
    const sourceWin = windowManager.getWindowById(sourceWindowId)
    if (!sourceWin || sourceWin.isDestroyed() || windowManager.isWindowClosing(sourceWin.id)) return false
    const sourceGeneration = windowManager.getOwnershipGeneration(tab.id)
    const sourceWebContentsId = sourceWin.webContents.id
    const ownsAllPtys = (): boolean => ptyIds.every((ptyId) => windowManager.getPtyOwner(ptyId) === sourceWebContentsId)
    if (!ownsAllPtys()) return false

    const transferId = `absorb:${Date.now()}:${++tabReleaseSeq}`
    pendingTabAbsorbs.set(transferId, { tabId: tab.id, targetWindowId: toWin.id })
    const targetApplied = await waitForAck(toWin, 'tab:received-applied', transferId, () => {
      trySend(toWin, 'tab:received', tabJson, Number.isInteger(dropIndex) && (dropIndex as number) >= 0 ? dropIndex : undefined, transferId)
    }, 1500)
    if (!targetApplied) {
      // The apply may have succeeded while its ack raced a renderer/window
      // teardown. Rollback is token-keyed and harmless when nothing applied.
      trySend(toWin, 'tab:transfer-rolledback', tab.id, transferId)
      pendingTabAbsorbs.delete(transferId)
      return false
    }

    const released = await waitForAck(sourceWin, 'tab:release-applied', transferId, () => {
      trySend(sourceWin,
        'tab:release',
        tab.id,
        windowManager.isDetachedWindow(toWin.id) ? toWin.id : undefined,
        transferId,
      )
    }, 1500)
    // On failure the source has NOT yet touched its copy of the tab (it only acked the
    // release; finalize is deferred to tab:absorb-committed below), so there is nothing to
    // roll back here — the absorber discards its optimistic copy on the falsy result.
    const validBeforeCommit =
      released &&
      !toWin.isDestroyed() &&
      !sourceWin.isDestroyed() &&
      !windowManager.isWindowClosing(sourceWin.id) &&
      !windowManager.isWindowClosing(toWin.id) &&
      windowManager.getOwnershipGeneration(tab.id) === sourceGeneration &&
      ownsAllPtys()
    if (!validBeforeCommit) {
      trySend(toWin, 'tab:transfer-rolledback', tab.id, transferId)
      trySend(sourceWin, 'tab:transfer-rolledback', tab.id, transferId)
      pendingTabAbsorbs.delete(transferId)
      return false
    }

    windowManager.unrecordTab(tab.id)
    const targetIsDetached = windowManager.isDetachedWindow(toWin.id)
    if (targetIsDetached) {
      windowManager.recordDetachedTab(toWin.id, [tab.id])
    }
    for (const ptyId of ptyIds as string[]) {
      windowManager.transferPty(ptyId, toWin)
      flushDirectOutput(ptyId)
    }
    // PTYs are now routed to the absorbing window; only now is it safe for the source to
    // drop/detach its copy. Without this commit the source either lost the tab before the
    // transfer was confirmed (data loss) or never released it at all.
    trySend(sourceWin, 'tab:absorb-committed', tab.id, targetIsDetached ? toWin.id : undefined, transferId)
    trySend(toWin, 'tab:absorb-committed', tab.id, targetIsDetached ? toWin.id : undefined, transferId)
    pendingTabAbsorbs.delete(transferId)
    return true
  })

}
