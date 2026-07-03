import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAckProtocol } from './ackProtocol'

describe('ack protocol', () => {
  beforeEach(() => vi.useFakeTimers())
  it('registers before trigger, matches id/window, and clears timeout', async () => {
    const listeners = new Map<string, (...a: any[]) => void>()
    const source = { on: vi.fn((ch: string, fn: (...a: any[]) => void) => listeners.set(ch, fn)), removeListener: vi.fn((ch: string) => listeners.delete(ch)), senderWindowId: (e: unknown) => (e as { id: number }).id }
    const ack = createAckProtocol(source)
    const promise = ack.waitForAck(2, 'ack', 'x', () => listeners.get('ack')?.({ id: 2 }, 'x'))
    await expect(promise).resolves.toBe(true); expect(vi.getTimerCount()).toBe(0)
  })
  it('ignores mismatches and preserves ok !== false semantics', async () => {
    const listeners = new Map<string, (...a: any[]) => void>()
    const source = { on: (ch: string, fn: (...a: any[]) => void) => listeners.set(ch, fn), removeListener: (ch: string) => { listeners.delete(ch) }, senderWindowId: (e: unknown) => (e as { id: number }).id }
    const ack = createAckProtocol(source)
    const promise = ack.waitForAckWithResult(2, 'ack', 'x', () => {})
    listeners.get('ack')?.({ id: 1 }, 'x', true); listeners.get('ack')?.({ id: 2 }, 'bad', true); listeners.get('ack')?.({ id: 2 }, 'x', undefined)
    await expect(promise).resolves.toEqual({ acked: true, ok: true })
  })
  it('times out at the explicit duration and removes listener', async () => {
    const source = { on: vi.fn(), removeListener: vi.fn(), senderWindowId: () => undefined }
    const promise = createAckProtocol(source).waitForAck(1, 'ack', 'x', () => {}, 3000)
    await vi.advanceTimersByTimeAsync(2999); expect(source.removeListener).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); await expect(promise).resolves.toBe(false)
  })
})
