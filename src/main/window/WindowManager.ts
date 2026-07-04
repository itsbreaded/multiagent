import { BrowserWindow } from 'electron'

export interface WindowInitData {
  mode: 'detached'
  tab: object
  ptyIds: string[]
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
  private ptyToWebContentsId = new Map<string, number>()
  public pendingInitData = new Map<number, WindowInitData>()
  private pendingDetachedWindowTabs = new Map<number, string[]>()
  /** Maps detached window id → tab ids it owns (for tab:return on close) */
  private detachedWindowTabs = new Map<number, string[]>()
  /** Maps tab id → detached window id (for window:focus-for-tab) */
  private tabToWindowId = new Map<string, number>()
  private tabOwnershipGeneration = new Map<string, number>()
  private tabSyncTombstones = new Map<string, number>()
  private syncVersionByWindow = new Map<number, number>()
  private detachedWindowIds = new Set<number>()

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

  register(win: BrowserWindow): void {
    this.windows.set(win.id, win)
    win.once('closed', () => this.unregister(win.id))
  }

  unregister(id: number): void {
    // If a detached window is closing, tell the primary window to return its tabs.
    const tabIds = Array.from(new Set([
      ...(this.detachedWindowTabs.get(id) ?? []),
      ...(this.pendingDetachedWindowTabs.get(id) ?? []),
    ]))
    if (tabIds && tabIds.length > 0) {
      // The primary window is the first registered window that is NOT this one.
      const primaryWin = this._getPrimaryWindow(id)
      if (primaryWin && !primaryWin.isDestroyed()) {
        for (const tabId of tabIds) {
          primaryWin.webContents.send('tab:return', tabId)
          this.tabToWindowId.delete(tabId)
          this.tabSyncTombstones.set(tabId, id)
          this.bumpTabOwnershipGeneration(tabId)
        }
      }
      this.detachedWindowTabs.delete(id)
      this.pendingDetachedWindowTabs.delete(id)
    }
    this.detachedWindowIds.delete(id)

    this.windows.delete(id)
    for (const [ptyId, wcId] of this.ptyToWebContentsId) {
      const win = this.getWindowByWebContentsId(wcId)
      if (!win || win.id === id) {
        this.ptyToWebContentsId.delete(ptyId)
      }
    }
  }

  /** Record that a detached window owns the given tab IDs (appends; used on tear-off). */
  recordDetachedTab(windowId: number, tabIds: string[]): void {
    const existing = this.detachedWindowTabs.get(windowId) ?? []
    this.detachedWindowTabs.set(windowId, [...existing, ...tabIds])
    for (const tabId of tabIds) {
      this.tabToWindowId.set(tabId, windowId)
      if (this.tabSyncTombstones.get(tabId) === windowId) this.tabSyncTombstones.delete(tabId)
      this.bumpTabOwnershipGeneration(tabId)
    }
  }

  prepareDetachedTab(windowId: number, tabIds: string[]): void {
    const existing = this.pendingDetachedWindowTabs.get(windowId) ?? []
    this.pendingDetachedWindowTabs.set(windowId, Array.from(new Set([...existing, ...tabIds])))
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

  broadcastExcept(excludeId: number, channel: string, ...args: unknown[]): void {
    for (const [id, win] of this.windows) {
      if (id !== excludeId && !win.isDestroyed()) {
        win.webContents.send(channel, ...args)
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

  /** Returns the first registered window that is NOT the given window id (i.e. the primary). */
  private _getPrimaryWindow(excludeId: number): BrowserWindow | null {
    for (const [id, win] of this.windows) {
      if (id !== excludeId && !win.isDestroyed()) return win
    }
    return null
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
  }

  transferPty(ptyId: string, toWin: BrowserWindow): void {
    this.ptyToWebContentsId.set(ptyId, toWin.webContents.id)
  }

  unroutePty(ptyId: string): void {
    this.ptyToWebContentsId.delete(ptyId)
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
    win.webContents.send(channel, ...args)
    return true
  }

  broadcastAll(channel: string, ...args: unknown[]): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args)
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
      },
    })

    win.once('ready-to-show', () => win.show())

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
