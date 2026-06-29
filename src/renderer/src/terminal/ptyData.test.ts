import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockIpc, type MockIpc } from '../../../../tests/mockIpc'
import { createDirectPtyDataHandler } from './ptyData'

let ipc: MockIpc

beforeEach(() => {
  ipc = installMockIpc()
})

describe('createDirectPtyDataHandler - no-flow-control contract', () => {
  it('writes synchronously before the IPC callback returns', () => {
    let callbackReturned = false
    const write = vi.fn(() => {
      expect(callbackReturned).toBe(false)
    })
    const handler = createDirectPtyDataHandler('pty-1', { write }, () => false)

    handler('pty-1', 'direct output')
    callbackReturned = true

    expect(write).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledWith('direct output')
  })

  it('emits no ack, pause, or resume IPC after handling output', () => {
    const write = vi.fn()
    const handler = createDirectPtyDataHandler('pty-1', { write }, () => false)

    handler('pty-1', 'direct output')

    expect(write).toHaveBeenCalledOnce()
    expect(ipc.send).not.toHaveBeenCalled()
    expect(ipc.invoke).not.toHaveBeenCalled()
  })

  it('ignores other PTYs, non-string data, and output after cancellation', () => {
    const write = vi.fn()
    let cancelled = false
    const handler = createDirectPtyDataHandler('pty-1', { write }, () => cancelled)

    handler('pty-2', 'other output')
    handler('pty-1', 42)
    cancelled = true
    handler('pty-1', 'late output')

    expect(write).not.toHaveBeenCalled()
  })
})
