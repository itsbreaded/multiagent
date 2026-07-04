import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { createShellPty, type CreateShellPtyDeps } from './createShellPty'
import type { IPCChannels, InvokeChannels } from '../../../../shared/types'

interface InvokeController {
  invoke: Mock
  resolveInvoke: (result: unknown) => void
  rejectInvoke: (err: unknown) => void
}

function makeDeps(onPtyId: Mock = vi.fn(), onError: Mock = vi.fn(), releaseGuard: Mock = vi.fn()): {
  deps: CreateShellPtyDeps
  invokeCtrl: InvokeController
} {
  let resolve!: (v: unknown) => void
  let reject!: (e: unknown) => void
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  const invokeMock = vi.fn((...call: unknown[]) => call[0] === 'pty:create' ? promise : Promise.resolve(undefined))
  const invoke = <C extends InvokeChannels>(
    _channel: C,
    ..._args: Parameters<IPCChannels[C]>
  ): Promise<ReturnType<IPCChannels[C]>> => invokeMock(_channel, ..._args) as Promise<ReturnType<IPCChannels[C]>>
  const deps: CreateShellPtyDeps = {
    ipc: { invoke },
    getInitialSize: () => ({ cols: 100, rows: 30 }),
    onPtyId,
    onError,
    releaseGuard,
  }
  return {
    deps,
    invokeCtrl: {
      invoke: invokeMock,
      resolveInvoke: resolve,
      rejectInvoke: reject,
    },
  }
}

describe('createShellPty', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('kills the late-resolving ptyId when cancelled before resolve', async () => {
    const onPtyId = vi.fn()
    const { deps, invokeCtrl } = makeDeps(onPtyId)
    const handle = createShellPty('C:\\cwd', deps)
    handle.cancel()
    invokeCtrl.resolveInvoke({ ptyId: 'pty-1' })
    await Promise.resolve()
    await Promise.resolve()

    expect(onPtyId).not.toHaveBeenCalled()
    const killCalls = invokeCtrl.invoke.mock.calls.filter((c) => c[0] === 'pty:kill')
    expect(killCalls).toEqual([['pty:kill', 'pty-1']])
  })

  it('delivers the ptyId when resolved before cancel', async () => {
    const onPtyId = vi.fn()
    const { deps, invokeCtrl } = makeDeps(onPtyId)
    const handle = createShellPty('C:\\cwd', deps)
    invokeCtrl.resolveInvoke({ ptyId: 'pty-7' })
    await Promise.resolve()
    await Promise.resolve()

    handle.cancel() // late cancel after success is a no-op for the id
    expect(onPtyId).toHaveBeenCalledWith('pty-7')
    expect(invokeCtrl.invoke.mock.calls.some((c) => c[0] === 'pty:kill')).toBe(false)
  })

  it('releases guard and reports error when the invoke rejects', async () => {
    const onError = vi.fn()
    const releaseGuard = vi.fn()
    const { deps, invokeCtrl } = makeDeps(vi.fn(), onError, releaseGuard)
    createShellPty('C:\\cwd', deps)
    invokeCtrl.rejectInvoke(new Error('boom'))
    await Promise.resolve()
    await Promise.resolve()

    expect(releaseGuard).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('boom')
  })

  it('releases the guard even when cancelled before rejection', async () => {
    const onError = vi.fn()
    const releaseGuard = vi.fn()
    const { deps, invokeCtrl } = makeDeps(vi.fn(), onError, releaseGuard)
    const handle = createShellPty('C:\\cwd', deps)
    handle.cancel()
    invokeCtrl.rejectInvoke(new Error('late fail'))
    await Promise.resolve()
    await Promise.resolve()

    // Guard is released (so a future remount can retry) but no error surface
    // — the pane is already gone.
    expect(releaseGuard).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('treats a malformed result as an error and releases the guard', async () => {
    const onError = vi.fn()
    const releaseGuard = vi.fn()
    const { deps, invokeCtrl } = makeDeps(vi.fn(), onError, releaseGuard)
    createShellPty('C:\\cwd', deps)
    invokeCtrl.resolveInvoke({}) // no ptyId
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(releaseGuard).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('pty:create did not return a ptyId')
    expect(invokeCtrl.invoke.mock.calls.some((c) => c[0] === 'pty:kill')).toBe(false)
  })

  it('treats a null result as an error', async () => {
    const onError = vi.fn()
    const releaseGuard = vi.fn()
    const { deps, invokeCtrl } = makeDeps(vi.fn(), onError, releaseGuard)
    createShellPty('C:\\cwd', deps)
    invokeCtrl.resolveInvoke(null)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(releaseGuard).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('pty:create did not return a ptyId')
  })
})
