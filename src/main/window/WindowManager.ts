import { BrowserWindow } from 'electron'
import type { OverlayKind, OverlayRequest } from '../../shared/types'
import { OverlayCoordinator } from './OverlayCoordinator'

export interface WindowInitData {
  mode: 'detached'
  tab: object
  ptyIds: string[]
  transferId?: string
}

export interface PendingTabTransfer {
  transferId: string
  sourceWindowId: number
  targetWindowId: number
  tabId: string
  ptyIds: string[]
  originalRoutes: Map<string, number | undefined>
  sourceGeneration: number
  phase: 'pending' | 'ready' | 'canceled' | 'committed'
}

export interface SnapZone {
  targetWindowId: number
  side: 'left' | 'right' | 'top' | 'bottom'
  x: number
  y: number
  width: number
  height: number
}

export class WindowManager {
  private windows = new Map<number, BrowserWindow>()
  private readonly overlayCoordinator = new OverlayCoordinator({
    getWindowById: (windowId) => this.windows.get(windowId) ?? null,
  })
  private ptyToWebContentsId = new Map<string, number>()
  public pendingInitData = new Map<number, WindowInitData>()
  private pendingDetachedWindowTabs = new Map<number, string[]>()
  /** Resolvers waiting on a tab's ownership handshake to land (see waitForTabOwnership). */
  private ownershipWaiters = new Map<string, Array<(windowId: number | null) => void>>()
  /** Maps detached window id → tab ids it owns for routing and terminal close cleanup. */
  private detachedWindowTabs = new Map<number, string[]>()
  /** PTYs staged/owned by a detached window, including before its first state sync. */
  private detachedWindowPtyIds = new Map<number, Set<string>>()
  /** Maps tab id → detached window id (for window:focus-for-tab) */
  private tabToWindowId = new Map<string, number>()
  private tabOwnershipGeneration = new Map<string, number>()
  private tabSyncTombstones = new Map<string, number>()
  private syncVersionByWindow = new Map<number, number>()
  private detachedWindowIds = new Set<number>()
  private closingWindowIds = new Set<number>()
  private pendingTabTransfers = new Map<string, PendingTabTransfer>()
  private detachedWindowCloseCleanup: ((ptyIds: string[]) => void | Promise<void>) | null = null
  private pendingTabTransferCleanup: ((transferId: string) => void) | null = null

  private preloadPath: string | null = null
  private rendererUrl: string | null = null
  private rendererFile: string | null = null
  private onWindowCreated: ((win: BrowserWindow) => void) | null = null

  configure(
    preloadPath: string,
    rendererUrl: string | null,
    rendererFile: string | null,
    onWindowCreated: (win: BrowserWindow) => void
  ): void {
    this.preloadPath = preloadPath
    this.rendererUrl = rendererUrl
    this.rendererFile = rendererFile
    this.onWindowCreated = onWindowCreated
  }

  configureDetachedWindowCloseCleanup(cleanup: (ptyIds: string[]) => void | Promise<void>): void {
    this.detachedWindowCloseCleanup = cleanup
  }

  configurePendingTabTransferCleanup(cleanup: (transferId: string) => void): void {
    this.pendingTabTransferCleanup = cleanup
  }

  register(win: BrowserWindow): void {
    this.windows.set(win.id, win)
    win.once('closed', () => this.unregister(win.id))
  }

  unregister(id: number): void {
    if (this.closingWindowIds.has(id)) return
    this.closingWindowIds.add(id)

    // Native close is authoritative: the renderer can no longer own a visible
    // overlay, and any pending handoff may proceed without waiting for it.
    this.overlayCoordinator.releaseWindow(id)

    // BrowserWindow#closed is synchronous. Invalidate pending transfer tokens
    // and restore routes before clearing ownership so a late ready/commit cannot
    // win the shutdown race.
    for (const transfer of [...this.pendingTabTransfers.values()]) {
      if (transfer.sourceWindowId === id || transfer.targetWindowId === id) {
        this.cancelPendingTabTransfer(transfer.transferId, id)
      }
    }

    const closingWin = this.windows.get(id)
    const closingWebContentsId = this.getWebContentsId(closingWin)
    const ownedTabIds = Array.from(new Set(this.detachedWindowTabs.get(id) ?? []))
    const cleanupCandidates = new Set(this.detachedWindowPtyIds.get(id) ?? [])
    for (const [ptyId, wcId] of this.ptyToWebContentsId) {
      if (closingWebContentsId !== undefined && wcId === closingWebContentsId) cleanupCandidates.add(ptyId)
    }
    for (const ptyId of this.pendingInitData.get(id)?.ptyIds ?? []) cleanupCandidates.add(ptyId)
    const cleanupPtyIds = [...cleanupCandidates].filter((ptyId) => {
      const owner = this.ptyToWebContentsId.get(ptyId)
      if (owner === undefined) return true
      if (closingWebContentsId !== undefined) return owner === closingWebContentsId
      return this.detachedWindowPtyIds.get(id)?.has(ptyId) === true
    })

    const primaryWin = this.getPrimaryWindow()
    for (const tabId of ownedTabIds) {
      if (this.tabToWindowId.get(tabId) !== id) continue
      this.tabToWindowId.delete(tabId)
      this.tabSyncTombstones.set(tabId, id)
      this.bumpTabOwnershipGeneration(tabId)
      this.resolveOwnershipWaiters(tabId, null)
      if (primaryWin && !primaryWin.isDestroyed()) {
        this.trySend(primaryWin, 'tab:closed', tabId, id)
      }
    }
    this.detachedWindowTabs.delete(id)
    this.detachedWindowPtyIds.delete(id)
    this.pendingDetachedWindowTabs.delete(id)
    this.syncVersionByWindow.delete(id)
    this.detachedWindowIds.delete(id)

    this.windows.delete(id)
    for (const [ptyId, wcId] of this.ptyToWebContentsId) {
      const win = this.getWindowByWebContentsId(wcId)
      if (!win || win.id === id) this.ptyToWebContentsId.delete(ptyId)
    }
    this.pendingInitData.delete(id)
    if (cleanupPtyIds.length > 0 && this.detachedWindowCloseCleanup) {
      void Promise.resolve(this.detachedWindowCloseCleanup(Array.from(new Set(cleanupPtyIds)))).catch(() => {})
    }
  }

  requestOverlay(windowId: number | null, request: OverlayRequest) {
    return this.overlayCoordinator.request(windowId, request)
  }

  releaseOverlay(windowId: number | null, kind: OverlayKind, generation: number) {
    return this.overlayCoordinator.release(windowId, kind, generation)
  }

  acknowledgeOverlayClosed(windowId: number | null, kind: OverlayKind, generation: number): boolean {
    return this.overlayCoordinator.acknowledgeClose(windowId, kind, generation)
  }

  getOverlayOwner() {
    return this.overlayCoordinator.getOwner()
  }

  /** Record that a detached window owns the given tab IDs (appends; used on tear-off). */
  recordDetachedTab(windowId: number, tabIds: string[]): void {
    if (!this.detachedWindowIds.has(windowId) || this.closingWindowIds.has(windowId)) return
    const existing = this.detachedWindowTabs.get(windowId) ?? []
    const nextTabIds = Array.from(new Set([...existing, ...tabIds]))
    this.detachedWindowTabs.set(windowId, nextTabIds)
    for (const tabId of tabIds) {
      this.tabToWindowId.set(tabId, windowId)
      if (this.tabSyncTombstones.get(tabId) === windowId) this.tabSyncTombstones.delete(tabId)
      this.bumpTabOwnershipGeneration(tabId)
      this.resolveOwnershipWaiters(tabId, windowId)
    }
  }

  prepareDetachedTab(windowId: number, tabIds: string[]): void {
    const existing = this.pendingDetachedWindowTabs.get(windowId) ?? []
    this.pendingDetachedWindowTabs.set(windowId, Array.from(new Set([...existing, ...tabIds])))
  }

  private addDetachedWindowPtyIds(windowId: number, ptyIds: string[]): void {
    if (ptyIds.length === 0) return
    const existing = this.detachedWindowPtyIds.get(windowId) ?? new Set<string>()
    for (const ptyId of ptyIds) existing.add(ptyId)
    this.detachedWindowPtyIds.set(windowId, existing)
  }

  private removeDetachedWindowPtyId(ptyId: string): void {
    for (const windowId of this.detachedWindowPtyIds.keys()) this.removeDetachedWindowPtyIds(windowId, [ptyId])
  }

  private removeDetachedWindowPtyIds(windowId: number, ptyIds: string[]): void {
    const owned = this.detachedWindowPtyIds.get(windowId)
    if (!owned) return
    for (const ptyId of ptyIds) owned.delete(ptyId)
    if (owned.size === 0) this.detachedWindowPtyIds.delete(windowId)
  }

  prepareTabTearOff(
    transferId: string,
    sourceWindowId: number,
    targetWindowId: number,
    tabId: string,
    ptyIds: string[],
  ): boolean {
    const source = this.windows.get(sourceWindowId)
    const target = this.windows.get(targetWindowId)
    if (!source || source.isDestroyed() || !target || target.isDestroyed() || this.closingWindowIds.has(sourceWindowId) || this.closingWindowIds.has(targetWindowId)) return false
    const originalRoutes = new Map(ptyIds.map((ptyId) => [ptyId, this.ptyToWebContentsId.get(ptyId)] as const))
    this.pendingTabTransfers.set(transferId, {
      transferId,
      sourceWindowId,
      targetWindowId,
      tabId,
      ptyIds: [...ptyIds],
      originalRoutes,
      sourceGeneration: this.getOwnershipGeneration(tabId),
      phase: 'pending',
    })
    this.prepareDetachedTab(targetWindowId, [tabId])
    this.addDetachedWindowPtyIds(targetWindowId, ptyIds)
    return true
  }

  getPendingTabTransfer(transferId: string): PendingTabTransfer | null {
    return this.pendingTabTransfers.get(transferId) ?? null
  }

  markTabTransferReady(transferId: string): PendingTabTransfer | null {
    const transfer = this.pendingTabTransfers.get(transferId)
    if (!transfer || transfer.phase !== 'pending') return null
    transfer.phase = 'ready'
    return transfer
  }

  commitPendingTabTransfer(transferId: string): PendingTabTransfer | null {
    const transfer = this.pendingTabTransfers.get(transferId)
    if (!transfer || transfer.phase !== 'ready') return null
    transfer.phase = 'committed'
    this.pendingTabTransfers.delete(transferId)
    return transfer
  }

  cancelPendingTabTransfer(transferId: string, closingWindowId?: number): PendingTabTransfer | null {
    const transfer = this.pendingTabTransfers.get(transferId)
    if (!transfer || transfer.phase === 'committed' || transfer.phase === 'canceled') return null
    transfer.phase = 'canceled'
    this.pendingTabTransfers.delete(transferId)
    this.pendingTabTransferCleanup?.(transferId)
    const source = this.windows.get(transfer.sourceWindowId)
    const target = this.windows.get(transfer.targetWindowId)
    const sourceAlive = !!source && !source.isDestroyed() && !this.closingWindowIds.has(transfer.sourceWindowId)
    const targetWebContentsId = this.getWebContentsId(target)
    if (sourceAlive && targetWebContentsId !== undefined) {
      for (const ptyId of transfer.ptyIds) {
        if (this.ptyToWebContentsId.get(ptyId) !== targetWebContentsId) continue
        const originalOwner = transfer.originalRoutes.get(ptyId)
        if (originalOwner === undefined) this.ptyToWebContentsId.delete(ptyId)
        else this.ptyToWebContentsId.set(ptyId, originalOwner)
      }
    }
    if (sourceAlive) this.trySend(source, 'tab:tear-off-rolled-back', transfer.tabId, transfer.transferId)
    if (target && !target.isDestroyed() && transfer.targetWindowId !== closingWindowId) {
      this.trySend(target, 'tab:tear-off-rolled-back', transfer.tabId, transfer.transferId)
      try {
        target.close()
      } catch {
        // The native window may cross from closing to destroyed between the
        // checks above and close(). Its closed handler still performs cleanup.
      }
    }
    this.removeDetachedWindowPtyIds(transfer.targetWindowId, transfer.ptyIds)
    this.resolveOwnershipWaiters(transfer.tabId, null)
    const pending = this.pendingDetachedWindowTabs.get(transfer.targetWindowId) ?? []
    const remaining = pending.filter((id) => id !== transfer.tabId)
    if (remaining.length > 0) this.pendingDetachedWindowTabs.set(transfer.targetWindowId, remaining)
    else this.pendingDetachedWindowTabs.delete(transfer.targetWindowId)
    return transfer
  }

  isWindowClosing(windowId: number): boolean {
    return this.closingWindowIds.has(windowId)
  }

  private resolveOwnershipWaiters(tabId: string, windowId: number | null): void {
    const waiters = this.ownershipWaiters.get(tabId)
    if (!waiters) return
    this.ownershipWaiters.delete(tabId)
    for (const resolve of waiters) resolve(windowId)
  }

  /**
   * Resolve once `tabId` gets an owning window, for a tab that is currently mid tear-off
   * (staged in pendingDetachedWindowTabs but not yet in tabToWindowId — see prepareDetachedTab).
   * Bounded wait so a tab that is not pending anywhere (or whose detached window never boots)
   * fails fast instead of hanging. Closes the race where the primary closes a just-torn-off tab
   * before the new window finishes its tab:adopt/tab:detached-ready handshake (see tab:bring-home).
   */
  waitForTabOwnership(tabId: string, timeoutMs = 3000): Promise<number | null> {
    const immediate = this.tabToWindowId.get(tabId)
    if (immediate !== undefined) return Promise.resolve(immediate)
    const isPending = Array.from(this.pendingDetachedWindowTabs.values()).some((ids) => ids.includes(tabId))
    if (!isPending) return Promise.resolve(null)
    return new Promise((resolve) => {
      let settled = false
      const finish = (windowId: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const waiters = this.ownershipWaiters.get(tabId)
        if (waiters) {
          const remaining = waiters.filter((w) => w !== onResolved)
          if (remaining.length > 0) this.ownershipWaiters.set(tabId, remaining)
          else this.ownershipWaiters.delete(tabId)
        }
        resolve(windowId)
      }
      const onResolved = (windowId: number | null): void => finish(windowId)
      const existing = this.ownershipWaiters.get(tabId) ?? []
      this.ownershipWaiters.set(tabId, [...existing, onResolved])
      const timer = setTimeout(() => finish(null), timeoutMs)
    })
  }

  markDetachedTabReady(windowId: number, tabId: string): boolean {
    const pending = this.pendingDetachedWindowTabs.get(windowId) ?? []
    if (!pending.includes(tabId)) return false
    const remaining = pending.filter((id) => id !== tabId)
    if (remaining.length > 0) {
      this.pendingDetachedWindowTabs.set(windowId, remaining)
    } else {
      this.pendingDetachedWindowTabs.delete(windowId)
    }
    this.recordDetachedTab(windowId, [tabId])
    return true
  }

  /** Remove a single tab from routing (used when a tab is absorbed or brought home). */
  unrecordTab(tabId: string): void {
    const windowId = this.tabToWindowId.get(tabId)
    if (windowId === undefined) return
    this.tabToWindowId.delete(tabId)
    this.tabSyncTombstones.set(tabId, windowId)
    this.bumpTabOwnershipGeneration(tabId)
    const existing = this.detachedWindowTabs.get(windowId)
    if (existing) {
      this.detachedWindowTabs.set(windowId, existing.filter((id) => id !== tabId))
    }
  }

  /** Replace the full tab list for a window (used on live-sync updates). */
  recordDetachedTabsForWindow(windowId: number, tabIds: string[], version?: number): string[] {
    if (!this.detachedWindowIds.has(windowId) || this.closingWindowIds.has(windowId)) return []
    if (version !== undefined) {
      const previous = this.syncVersionByWindow.get(windowId) ?? 0
      if (version <= previous) return this.detachedWindowTabs.get(windowId) ?? []
      this.syncVersionByWindow.set(windowId, version)
    }
    const old = this.detachedWindowTabs.get(windowId) ?? []
    const acceptedTabIds = tabIds.filter((id) => this.tabSyncTombstones.get(id) !== windowId)
    // Remove stale mappings
    for (const id of old) {
      if (!acceptedTabIds.includes(id)) {
        this.tabToWindowId.delete(id)
        this.bumpTabOwnershipGeneration(id)
      }
    }
    this.detachedWindowTabs.set(windowId, acceptedTabIds)
    for (const id of acceptedTabIds) {
      if (this.tabToWindowId.get(id) !== windowId) this.bumpTabOwnershipGeneration(id)
      this.tabToWindowId.set(id, windowId)
    }
    return acceptedTabIds
  }

  isDetachedWindow(windowId: number): boolean {
    return this.detachedWindowIds.has(windowId)
  }

  /** Returns the window ID that currently owns a tab, or null. */
  getWindowIdForTab(tabId: string): number | null {
    return this.tabToWindowId.get(tabId) ?? null
  }

  getOwnershipGeneration(tabId: string): number {
    return this.tabOwnershipGeneration.get(tabId) ?? 0
  }

  private bumpTabOwnershipGeneration(tabId: string): void {
    this.tabOwnershipGeneration.set(tabId, (this.tabOwnershipGeneration.get(tabId) ?? 0) + 1)
  }

  private getWebContentsId(win: BrowserWindow | null | undefined): number | undefined {
    if (!win) return undefined
    try {
      return win.webContents.id
    } catch {
      return undefined
    }
  }

  private trySend(win: BrowserWindow, channel: string, ...args: unknown[]): boolean {
    try {
      if (win.isDestroyed()) return false
      win.webContents.send(channel, ...args)
      return true
    } catch {
      // BrowserWindow#isDestroyed() and webContents.send() are not atomic.
      // A close can win between them; renderer notifications are best effort
      // during teardown and must never crash the main process.
      return false
    }
  }

  broadcastExcept(excludeId: number, channel: string, ...args: unknown[]): void {
    for (const [id, win] of this.windows) {
      if (id !== excludeId && !win.isDestroyed()) {
        this.trySend(win, channel, ...args)
      }
    }
  }

  /** Focus the window that owns a given tab. Returns true if found. */
  focusWindowForTab(tabId: string): boolean {
    const winId = this.tabToWindowId.get(tabId)
    if (winId === undefined) return false
    const win = this.windows.get(winId)
    if (!win || win.isDestroyed()) return false
    if (win.isMinimized()) win.restore()
    win.focus()
    return true
  }

  /** Returns the primary (non-detached) window — the original window tabs reattach to. */
  getPrimaryWindow(): BrowserWindow | null {
    for (const [id, win] of this.windows) {
      if (!this.detachedWindowIds.has(id) && !win.isDestroyed()) return win
    }
    return null
  }

  routePty(ptyId: string, webContentsId: number): void {
    this.ptyToWebContentsId.set(ptyId, webContentsId)
    this.removeDetachedWindowPtyId(ptyId)
    const win = this.getWindowByWebContentsId(webContentsId)
    if (win && this.detachedWindowIds.has(win.id)) this.addDetachedWindowPtyIds(win.id, [ptyId])
  }

  transferPty(ptyId: string, toWin: BrowserWindow): void {
    this.ptyToWebContentsId.set(ptyId, toWin.webContents.id)
    this.removeDetachedWindowPtyId(ptyId)
    if (this.detachedWindowIds.has(toWin.id)) this.addDetachedWindowPtyIds(toWin.id, [ptyId])
  }

  unroutePty(ptyId: string): void {
    this.ptyToWebContentsId.delete(ptyId)
    this.removeDetachedWindowPtyId(ptyId)
  }

  ownsPty(ptyId: string, webContentsId: number): boolean {
    return this.ptyToWebContentsId.get(ptyId) === webContentsId
  }

  getPtyOwner(ptyId: string): number | undefined {
    return this.ptyToWebContentsId.get(ptyId)
  }

  sendToWindowForPty(ptyId: string, channel: string, ...args: unknown[]): boolean {
    const wcId = this.ptyToWebContentsId.get(ptyId)
    if (wcId === undefined) return false
    const win = this.getWindowByWebContentsId(wcId)
    if (!win || win.isDestroyed()) return false
    return this.trySend(win, channel, ...args)
  }

  broadcastAll(channel: string, ...args: unknown[]): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) {
        this.trySend(win, channel, ...args)
      }
    }
  }

  getAllBounds(): { id: number; x: number; y: number; width: number; height: number }[] {
    return Array.from(this.windows.values())
      .filter((w) => !w.isDestroyed())
      .map((w) => {
        const b = w.getBounds()
        return { id: w.id, x: b.x, y: b.y, width: b.width, height: b.height }
      })
  }

  getWindowById(id: number): BrowserWindow | null {
    return this.windows.get(id) ?? null
  }

  getWindowByWebContentsId(wcId: number): BrowserWindow | null {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed() && win.webContents.id === wcId) return win
    }
    return null
  }

  createDetachedWindow(
    fromWin: BrowserWindow,
    screenX: number,
    screenY: number,
    initData?: WindowInitData
  ): BrowserWindow {
    if (!this.preloadPath) throw new Error('WindowManager not configured — call configure() first')

    const fromBounds = fromWin.getBounds()
    const width = Math.max(800, Math.floor(fromBounds.width * 0.6))
    const height = fromBounds.height

    const win = new BrowserWindow({
      x: Math.max(0, screenX - Math.floor(width / 2)),
      y: Math.max(0, screenY - 20),
      width,
      height,
      show: false,
      autoHideMenuBar: true,
      frame: false,
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : process.platform === 'win32' ? 'hidden' : 'default',
      titleBarOverlay: process.platform === 'win32'
        ? { color: '#121416', symbolColor: '#c9cdd1', height: 34 }
        : false,
      webPreferences: {
        preload: this.preloadPath,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        // Keep the detached renderer painting while it's covered by another window, so resizing
        // a window over it doesn't leave the exposed terminal strip compositing a stale frame
        // (corrupted/duplicated text until a resize forces a repaint). See index.ts for the
        // matching setting on the primary window.
        backgroundThrottling: false
      },
    })

    win.once('ready-to-show', () => {
      if (process.env.MULTIAGENT_E2E_MINIMIZED === '1') {
        // Keep local Electron E2E runs from taking focus when a test creates a
        // detached window, while leaving its renderer available to Playwright.
        win.showInactive()
        win.minimize()
      } else {
        win.show()
      }
    })

    this.register(win)
    this.detachedWindowIds.add(win.id)
    // Register init data before loadFile/loadURL starts. A fast local file load
    // can invoke window:get-init-data immediately; setting this afterward races
    // the renderer and incorrectly initializes a detached window as primary.
    if (initData) this.pendingInitData.set(win.id, initData)
    this.startMoveTracking(win)

    if (this.onWindowCreated) {
      this.onWindowCreated(win)
    }

    if (this.rendererUrl) {
      void win.loadURL(this.rendererUrl)
    } else if (this.rendererFile) {
      void win.loadFile(this.rendererFile)
    }

    return win
  }

  startMoveTracking(win: BrowserWindow): void {
    let moveTimer: NodeJS.Timeout | null = null

    win.on('move', () => {
      if (moveTimer) clearTimeout(moveTimer)
      moveTimer = setTimeout(() => {
        moveTimer = null
        if (win.isDestroyed()) return
        const snapZones = this.computeSnapZones(win)
        if (snapZones.length > 0) {
          win.webContents.send('window:snap-zones', snapZones)
        }
      }, 200)
    })
  }

  computeSnapZones(win: BrowserWindow): SnapZone[] {
    if (win.isDestroyed()) return []
    const THRESHOLD = 60
    const bounds = win.getBounds()
    const zones: SnapZone[] = []

    for (const other of this.windows.values()) {
      if (other.id === win.id || other.isDestroyed()) continue
      const ob = other.getBounds()

      // Moving window's right edge near other's left edge → snap left of other
      if (Math.abs(bounds.x + bounds.width - ob.x) < THRESHOLD) {
        const oTop = Math.max(bounds.y, ob.y)
        const oBot = Math.min(bounds.y + bounds.height, ob.y + ob.height)
        if (oBot - oTop > 80) {
          zones.push({ targetWindowId: other.id, side: 'left', x: ob.x - 10, y: ob.y, width: 10, height: ob.height })
        }
      }

      // Moving window's left edge near other's right edge → snap right of other
      if (Math.abs(bounds.x - (ob.x + ob.width)) < THRESHOLD) {
        const oTop = Math.max(bounds.y, ob.y)
        const oBot = Math.min(bounds.y + bounds.height, ob.y + ob.height)
        if (oBot - oTop > 80) {
          zones.push({ targetWindowId: other.id, side: 'right', x: ob.x + ob.width, y: ob.y, width: 10, height: ob.height })
        }
      }
    }

    return zones
  }

  applySnap(
    fromWin: BrowserWindow,
    toWindowId: number,
    side: 'left' | 'right' | 'top' | 'bottom'
  ): void {
    const toWin = this.getWindowById(toWindowId)
    if (!toWin || fromWin.isDestroyed() || toWin.isDestroyed()) return

    const fromB = fromWin.getBounds()
    const toB = toWin.getBounds()

    switch (side) {
      case 'left': {
        // fromWin snaps to the left of toWin
        fromWin.setBounds({ x: toB.x - fromB.width, y: toB.y, width: fromB.width, height: toB.height })
        break
      }
      case 'right': {
        // fromWin snaps to the right of toWin
        fromWin.setBounds({ x: toB.x + toB.width, y: toB.y, width: fromB.width, height: toB.height })
        break
      }
      case 'top': {
        fromWin.setBounds({ x: toB.x, y: toB.y - fromB.height, width: toB.width, height: fromB.height })
        break
      }
      case 'bottom': {
        fromWin.setBounds({ x: toB.x, y: toB.y + toB.height, width: toB.width, height: fromB.height })
        break
      }
    }
  }
}

export const windowManager = new WindowManager()
