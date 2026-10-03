import { describe, expect, it, vi } from 'vitest'
import type { OverlayKind } from '../../shared/types'
import { OverlayCoordinator, type OverlayWindowLike } from './OverlayCoordinator'

type FakeWindow = OverlayWindowLike & {
  destroyed: boolean
  focused: boolean
  sent: Array<{ channel: string; args: unknown[] }>
  onSend?: (channel: string, ...args: unknown[]) => void
}

function fakeWindow(id: number): FakeWindow {
  const win: FakeWindow = {
    id,
    destroyed: false,
    focused: false,
    sent: [],
    webContents: {
      send: (channel, ...args) => {
        win.sent.push({ channel, args })
        win.onSend?.(channel, ...args)
      },
    },
    isDestroyed: () => win.destroyed,
    isMinimized: () => false,
    restore: vi.fn(),
    focus: () => { win.focused = true },
  }
  return win
}

function ackClose(win: FakeWindow, coordinator: OverlayCoordinator, kind: OverlayKind, generation: number): void {
  expect(win.sent.at(-1)).toMatchObject({ channel: 'overlay:close' })
  expect(win.sent.at(-1)?.args.slice(0, 2)).toEqual([kind, generation])
  expect(coordinator.acknowledgeClose(win.id, kind, generation)).toBe(true)
}

describe('OverlayCoordinator', () => {
  it('keeps an already-open overlay in its owner window and focuses that owner', async () => {
    const primary = fakeWindow(1)
    const detached = fakeWindow(2)
    const coordinator = new OverlayCoordinator({ getWindowById: (id) => id === 1 ? primary : id === 2 ? detached : null })

    const opened = await coordinator.request(1, { action: 'open', kind: 'settings' })
    const focused = await coordinator.request(2, { action: 'open', kind: 'settings' })

    expect(opened).toMatchObject({ status: 'opened', ownerWindowId: 1, generation: 1 })
    expect(focused).toMatchObject({ status: 'focused', ownerWindowId: 1, generation: 1 })
    expect(primary.focused).toBe(true)
    expect(primary.sent).toContainEqual({ channel: 'overlay:focus', args: ['settings', 1] })
    expect(detached.sent).toEqual([])
  })

  it('allows the detached window to become the owner when it opens first', async () => {
    const primary = fakeWindow(1)
    const detached = fakeWindow(2)
    const coordinator = new OverlayCoordinator({ getWindowById: (id) => id === 1 ? primary : id === 2 ? detached : null })

    const opened = await coordinator.request(2, { action: 'open', kind: 'command-palette' })
    const focused = await coordinator.request(1, { action: 'toggle', kind: 'command-palette' })

    expect(opened).toMatchObject({ status: 'opened', ownerWindowId: 2 })
    expect(focused).toMatchObject({ status: 'focused', ownerWindowId: 2 })
    expect(detached.focused).toBe(true)
    expect(primary.sent).toEqual([])
  })

  it('makes repeated same-owner toggles idempotent and advances generations after close', async () => {
    const primary = fakeWindow(1)
    const coordinator = new OverlayCoordinator({ getWindowById: (id) => id === 1 ? primary : null }, 100)

    const opened = await coordinator.request(1, { action: 'open', kind: 'session-browser' })
    expect(opened).toMatchObject({ status: 'opened', generation: 1 })
    const closing = coordinator.request(1, { action: 'toggle', kind: 'session-browser' })
    await Promise.resolve()
    ackClose(primary, coordinator, 'session-browser', 1)
    expect(await closing).toMatchObject({ status: 'closed', generation: 1 })
    expect(await coordinator.request(1, { action: 'toggle', kind: 'session-browser' })).toMatchObject({ status: 'opened', generation: 2 })
  })

  it('waits for the old owner to close before approving an exclusive handoff', async () => {
    const primary = fakeWindow(1)
    const detached = fakeWindow(2)
    const coordinator = new OverlayCoordinator({ getWindowById: (id) => id === 1 ? primary : id === 2 ? detached : null }, 100)

    await coordinator.request(1, { action: 'open', kind: 'settings' })
    const handoff = coordinator.request(2, { action: 'open', kind: 'command-palette' })
    let settled = false
    void handoff.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(detached.sent).toEqual([])
    ackClose(primary, coordinator, 'settings', 1)
    expect(await handoff).toMatchObject({ status: 'opened', kind: 'command-palette', ownerWindowId: 2, generation: 2 })
  })

  it('rejects stale close and release messages after a newer generation owns the kind', async () => {
    const primary = fakeWindow(1)
    const coordinator = new OverlayCoordinator({ getWindowById: (id) => id === 1 ? primary : null }, 100)

    await coordinator.request(1, { action: 'open', kind: 'settings' })
    const firstClose = coordinator.request(1, { action: 'toggle', kind: 'settings' })
    await Promise.resolve()
    ackClose(primary, coordinator, 'settings', 1)
    await firstClose
    await coordinator.request(1, { action: 'open', kind: 'settings' })

    expect(coordinator.acknowledgeClose(1, 'settings', 1)).toBe(false)
    expect(await coordinator.release(1, 'settings', 1)).toBe(false)
    expect(coordinator.getOwner()).toMatchObject({ kind: 'settings', generation: 2, ownerWindowId: 1 })
  })

  it('releases ownership on native window close so the next request can open', async () => {
    const primary = fakeWindow(1)
    const detached = fakeWindow(2)
    const coordinator = new OverlayCoordinator({ getWindowById: (id) => id === 1 ? primary : id === 2 ? detached : null })

    await coordinator.request(2, { action: 'open', kind: 'search' })
    detached.destroyed = true
    coordinator.releaseWindow(2)

    expect(await coordinator.request(1, { action: 'open', kind: 'search' })).toMatchObject({ status: 'opened', ownerWindowId: 1, generation: 2 })
  })
})
