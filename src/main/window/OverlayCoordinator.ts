import type {
  OverlayCloseReason,
  OverlayKind,
  OverlayRequest,
  OverlayRequestResult,
} from '../../shared/types'

export interface OverlayWindowLike {
  id: number
  webContents: { send: (channel: string, ...args: unknown[]) => void }
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  focus(): void
}

export interface OverlayOwner {
  kind: OverlayKind
  ownerWindowId: number
  generation: number
  requestToken: number
  settingsSection?: string | null
}

interface CloseWaiter {
  owner: OverlayOwner
  resolve: (acknowledged: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

export interface OverlayCoordinatorDeps {
  getWindowById: (windowId: number) => OverlayWindowLike | null
}

const OVERLAY_KINDS: readonly OverlayKind[] = ['settings', 'session-browser', 'search', 'command-palette']

function isOverlayKind(value: unknown): value is OverlayKind {
  return typeof value === 'string' && OVERLAY_KINDS.includes(value as OverlayKind)
}

function sameOwner(a: OverlayOwner, b: OverlayOwner): boolean {
  return a.kind === b.kind && a.ownerWindowId === b.ownerWindowId && a.generation === b.generation
}

/**
 * Main-process authority for the mutually-exclusive workspace overlays.
 *
 * Renderer state is only a projection of this record. Handoffs wait for the
 * old renderer to acknowledge that it cleared its instance before a new
 * generation is approved, so a delayed renderer message cannot create or
 * remove a second owner.
 */
export class OverlayCoordinator {
  private activeOwner: OverlayOwner | null = null
  private generation = 0
  private requestToken = 0
  private requestQueue: Promise<unknown> = Promise.resolve()
  private closeWaiters = new Map<string, CloseWaiter>()

  constructor(
    private readonly deps: OverlayCoordinatorDeps,
    private readonly closeTimeoutMs = 2000,
  ) {}

  request(windowId: number | null, request: OverlayRequest): Promise<OverlayRequestResult> {
    return this.enqueue(() => this.requestNow(windowId, request))
  }

  release(windowId: number | null, kind: OverlayKind, generation: number): Promise<boolean> {
    return this.enqueue(async () => {
      const owner = this.activeOwner
      if (!owner || windowId === null || !sameOwner(owner, { kind, ownerWindowId: windowId, generation, requestToken: owner.requestToken })) {
        return false
      }
      this.activeOwner = null
      return true
    })
  }

  acknowledgeClose(windowId: number | null, kind: OverlayKind, generation: number): boolean {
    if (windowId === null) return false
    const owner = this.activeOwner
    if (!owner || !sameOwner(owner, { kind, ownerWindowId: windowId, generation, requestToken: owner.requestToken })) return false
    const key = this.closeKey(owner)
    const waiter = this.closeWaiters.get(key)
    if (!waiter || waiter.owner.ownerWindowId !== windowId) return false
    clearTimeout(waiter.timer)
    this.closeWaiters.delete(key)
    waiter.resolve(true)
    return true
  }

  /** Release all overlay state attributable to a native renderer window. */
  releaseWindow(windowId: number): void {
    const owner = this.activeOwner
    if (!owner || owner.ownerWindowId !== windowId) return
    this.activeOwner = null
    const waiter = this.closeWaiters.get(this.closeKey(owner))
    if (waiter) {
      clearTimeout(waiter.timer)
      this.closeWaiters.delete(this.closeKey(owner))
      // A native close proves the old instance can no longer be visible.
      waiter.resolve(true)
    }
  }

  getOwner(): Readonly<OverlayOwner> | null {
    return this.activeOwner ? { ...this.activeOwner } : null
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.requestQueue.then(task, task)
    this.requestQueue = next.then(() => undefined, () => undefined)
    return next
  }

  private async requestNow(windowId: number | null, request: OverlayRequest): Promise<OverlayRequestResult> {
    if (windowId === null) return { status: 'rejected', reason: 'invalid-window' }
    if (!request || !isOverlayKind(request.kind) || (request.action !== 'open' && request.action !== 'toggle')) {
      return { status: 'rejected', reason: 'invalid-request' }
    }

    const invokingWindow = this.deps.getWindowById(windowId)
    if (!this.isUsableWindow(invokingWindow)) return { status: 'rejected', reason: 'invalid-window' }

    let current = this.activeOwner
    if (current && !this.isUsableWindow(this.deps.getWindowById(current.ownerWindowId))) {
      this.activeOwner = null
      current = null
    }

    if (current && current.kind === request.kind) {
      if (request.action === 'toggle' && current.ownerWindowId === windowId) {
        const closed = await this.closeOwner(current, 'release')
        if (!closed) return { status: 'rejected', reason: 'owner-close-timeout' }
        if (this.activeOwner && sameOwner(this.activeOwner, current)) this.activeOwner = null
        return {
          status: 'closed',
          kind: current.kind,
          ownerWindowId: current.ownerWindowId,
          generation: current.generation,
          requestToken: current.requestToken,
        }
      }

      const ownerWindow = this.deps.getWindowById(current.ownerWindowId)
      if (!this.focusWindow(ownerWindow)) {
        this.activeOwner = null
        return { status: 'rejected', reason: 'owner-unavailable' }
      }
      this.send(ownerWindow, 'overlay:focus', current.kind, current.generation)
      return {
        status: 'focused',
        kind: current.kind,
        ownerWindowId: current.ownerWindowId,
        generation: current.generation,
        requestToken: current.requestToken,
      }
    }

    if (current) {
      const closed = await this.closeOwner(current, 'handoff')
      if (!closed) return { status: 'rejected', reason: 'owner-close-timeout' }
      if (this.activeOwner && sameOwner(this.activeOwner, current)) this.activeOwner = null
    }

    const owner: OverlayOwner = {
      kind: request.kind,
      ownerWindowId: windowId,
      generation: ++this.generation,
      requestToken: ++this.requestToken,
      ...(request.kind === 'settings' ? { settingsSection: request.settingsSection ?? null } : {}),
    }
    this.activeOwner = owner
    return {
      status: 'opened',
      kind: owner.kind,
      ownerWindowId: owner.ownerWindowId,
      generation: owner.generation,
      requestToken: owner.requestToken,
      ...(owner.kind === 'settings' ? { settingsSection: owner.settingsSection } : {}),
    }
  }

  private async closeOwner(owner: OverlayOwner, reason: OverlayCloseReason): Promise<boolean> {
    const win = this.deps.getWindowById(owner.ownerWindowId)
    if (!this.isUsableWindow(win)) {
      this.activeOwner = null
      return true
    }

    const key = this.closeKey(owner)
    const acknowledged = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.closeWaiters.delete(key)
        resolve(false)
      }, this.closeTimeoutMs)
      this.closeWaiters.set(key, { owner, resolve, timer })
    })
    if (!this.send(win, 'overlay:close', owner.kind, owner.generation, reason)) {
      const waiter = this.closeWaiters.get(key)
      if (waiter) {
        clearTimeout(waiter.timer)
        this.closeWaiters.delete(key)
        waiter.resolve(false)
      }
    }
    return acknowledged
  }

  private closeKey(owner: OverlayOwner): string {
    return `${owner.kind}:${owner.ownerWindowId}:${owner.generation}`
  }

  private isUsableWindow(win: OverlayWindowLike | null): win is OverlayWindowLike {
    try {
      return !!win && !win.isDestroyed()
    } catch {
      return false
    }
  }

  private focusWindow(win: OverlayWindowLike | null): boolean {
    if (!this.isUsableWindow(win)) return false
    try {
      // Electron E2E windows are intentionally minimized and backgrounded. The
      // renderer still receives overlay:focus below, while this harness-only
      // branch prevents an assertion/helper from stealing the desktop focus.
      if (process.env.MULTIAGENT_E2E_MINIMIZED === '1') return true
      if (win.isMinimized()) win.restore()
      win.focus()
      return true
    } catch {
      return false
    }
  }

  private send(win: OverlayWindowLike | null, channel: string, ...args: unknown[]): boolean {
    if (!this.isUsableWindow(win)) return false
    try {
      win.webContents.send(channel, ...args)
      return true
    } catch {
      return false
    }
  }
}
