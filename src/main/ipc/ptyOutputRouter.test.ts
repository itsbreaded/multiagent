import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPtyOutputRouter, PTY_ROUTE_RETRY_MS } from './ptyOutputRouter'

describe('pty output router', () => {
  beforeEach(() => vi.useFakeTimers())
  it('buffers only while unroutable and flushes in order with O(1) length metadata', async () => {
    const pty = new EventEmitter()
    const sent: unknown[][] = []
    let routable = false
    const wm = { sendToWindowForPty: vi.fn((...args: unknown[]) => { sent.push(args); return routable }), unroutePty: vi.fn() }
    const router = createPtyOutputRouter({ ptyManager: pty as never, windowManager: wm })
    pty.emit('data', 'p', 'a'); pty.emit('data', 'p', '😀')
    routable = true; await vi.advanceTimersByTimeAsync(PTY_ROUTE_RETRY_MS)
    expect(sent.at(-1)).toEqual(['p', 'pty:data', 'p', 'a😀', 0, 3])
    router.dispose()
  })
  it('unroutes and releases state on exit', () => {
    const pty = new EventEmitter(), wm = { sendToWindowForPty: vi.fn(() => true), unroutePty: vi.fn() }
    createPtyOutputRouter({ ptyManager: pty as never, windowManager: wm })
    pty.emit('exit', 'p', 1)
    expect(wm.unroutePty).toHaveBeenCalledWith('p')
    expect(wm.sendToWindowForPty).toHaveBeenCalledWith('p', 'pty:exit', 'p', 1, undefined)
  })
})
