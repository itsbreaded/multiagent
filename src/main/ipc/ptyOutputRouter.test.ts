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

  it('parses a split cwd sequence without carrying a completed cwd forward', () => {
    const pty = new EventEmitter()
    const wm = { sendToWindowForPty: vi.fn(() => true), unroutePty: vi.fn() }
    createPtyOutputRouter({ ptyManager: pty as never, windowManager: wm })
    pty.emit('data', 'p', '\x1b]633;P;Cwd=C:\\pro')
    pty.emit('data', 'p', 'ject\x07')
    pty.emit('data', 'p', 'plain output')
    expect(wm.sendToWindowForPty).toHaveBeenCalledTimes(4)
    expect(wm.sendToWindowForPty).toHaveBeenCalledWith('p', 'pty:cwd', 'p', 'C:\\project')
  })

  it('fires command completion once when a split sequence is followed by ordinary output', () => {
    const pty = new EventEmitter()
    const wm = { sendToWindowForPty: vi.fn(() => true), unroutePty: vi.fn() }
    const onCommandComplete = vi.fn()
    createPtyOutputRouter({ ptyManager: pty as never, windowManager: wm, onCommandComplete })
    pty.emit('ready', { id: 'p', pid: 1, cwd: 'C:\\repo', windowsPty: true })
    pty.emit('data', 'p', '\x1b]633;')
    pty.emit('data', 'p', 'D\x07')
    pty.emit('data', 'p', 'keystroke')
    expect(onCommandComplete).toHaveBeenCalledOnce()
    expect(onCommandComplete).toHaveBeenCalledWith('C:\\repo')
  })
})
