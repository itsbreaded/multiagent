import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class BrowserWindow {} }))

import { WindowManager } from './WindowManager'

type FakeWindow = {
  id: number
  webContents: { id: number; send: ReturnType<typeof vi.fn> }
  isDestroyed: () => boolean
  once: (event: string, listener: () => void) => void
  close: () => void
  emitClosed: () => void
}

function fakeWindow(id: number, webContentsId: number): FakeWindow {
  let destroyed = false
  let closedListener: (() => void) | null = null
  return {
    id,
    webContents: { id: webContentsId, send: vi.fn() },
    isDestroyed: () => destroyed,
    once: (_event, listener) => { closedListener = listener },
    close: () => {
      if (destroyed) return
      destroyed = true
      closedListener?.()
    },
    emitClosed: () => {
      if (destroyed) return
      destroyed = true
      closedListener?.()
    },
  }
}

describe('WindowManager detached ownership lifecycle', () => {
  let manager: WindowManager

  beforeEach(() => {
    manager = new WindowManager()
  })

  it('closes owned detached tabs instead of returning them and rejects late sync', () => {
    const primary = fakeWindow(1, 11)
    const detached = fakeWindow(2, 22)
    manager.register(primary as never)
    manager.register(detached as never)
    ;(manager as unknown as { detachedWindowIds: Set<number> }).detachedWindowIds.add(detached.id)
    manager.recordDetachedTab(detached.id, ['tab-1', 'tab-2'])
    manager.routePty('pty-1', detached.webContents.id)
    const cleanup = vi.fn()
    manager.configureDetachedWindowCloseCleanup(cleanup)

    detached.emitClosed()

    expect(primary.webContents.send).toHaveBeenCalledWith('tab:closed', 'tab-1', detached.id)
    expect(primary.webContents.send).toHaveBeenCalledWith('tab:closed', 'tab-2', detached.id)
    expect(primary.webContents.send).not.toHaveBeenCalledWith('tab:return', 'tab-1')
    expect(primary.webContents.send).not.toHaveBeenCalledWith('tab:return', 'tab-2')
    expect(manager.getWindowIdForTab('tab-1')).toBeNull()
    expect(manager.getPtyOwner('pty-1')).toBeUndefined()
    expect(cleanup).toHaveBeenCalledWith(['pty-1'])
    expect(manager.recordDetachedTabsForWindow(detached.id, ['tab-1'], 1)).toEqual([])
  })

  it('restores a target-routed pending tear-off to its source without overwriting newer ownership', () => {
    const source = fakeWindow(1, 11)
    const target = fakeWindow(2, 22)
    manager.register(source as never)
    manager.register(target as never)
    ;(manager as unknown as { detachedWindowIds: Set<number> }).detachedWindowIds.add(target.id)
    manager.routePty('pty-1', source.webContents.id)
    expect(manager.prepareTabTearOff('transfer-1', source.id, target.id, 'tab-1', ['pty-1'])).toBe(true)
    expect(manager.markTabTransferReady('transfer-1')).not.toBeNull()
    manager.transferPty('pty-1', target as never)

    expect(manager.cancelPendingTabTransfer('transfer-1')).not.toBeNull()
    expect(manager.getPtyOwner('pty-1')).toBe(source.webContents.id)
    expect(target.webContents.send).toHaveBeenCalledWith('tab:tear-off-rolled-back', 'tab-1', 'transfer-1')
  })

  it('does not throw if the primary renderer is destroyed during close notification', () => {
    const primary = fakeWindow(1, 11)
    const detached = fakeWindow(2, 22)
    manager.register(primary as never)
    manager.register(detached as never)
    ;(manager as unknown as { detachedWindowIds: Set<number> }).detachedWindowIds.add(detached.id)
    manager.recordDetachedTab(detached.id, ['tab-1'])
    primary.webContents.send.mockImplementation(() => {
      throw new Error('Object has been destroyed')
    })

    expect(() => detached.emitClosed()).not.toThrow()
  })
})
