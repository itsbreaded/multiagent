import { describe, expect, it, vi } from 'vitest'
import { createSessionPoller } from './sessionPoll'

const session = (exists = true) => ({ cwd: 'C:\\repo', cwdExists: exists }) as never

describe('createSessionPoller', () => {
  it('broadcasts changes and force, but skips an unchanged fingerprint', async () => {
    const broadcast = vi.fn()
    const index = { upsertMany: vi.fn().mockReturnValueOnce({ changed: 1 }).mockReturnValue({ changed: 0 }), getAll: vi.fn(() => [session()]) }
    const poller = createSessionPoller({ scanAll: async () => [], index, broadcast })
    await poller.poll()
    await poller.poll()
    await poller.poll(true)
    expect(broadcast).toHaveBeenCalledTimes(2)
  })

  it('makes a forced caller await the active scan and a fresh forced pass', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const scanAll = vi.fn().mockImplementationOnce(async () => { await gate; return [] }).mockResolvedValue([])
    const broadcast = vi.fn()
    const poller = createSessionPoller({ scanAll, index: { upsertMany: () => ({ changed: 0 }), getAll: () => [session()] }, broadcast })
    const first = poller.poll()
    let forcedDone = false
    const forced = poller.poll(true).then(() => { forcedDone = true })
    expect(scanAll).toHaveBeenCalledTimes(1)
    expect(forcedDone).toBe(false)
    release()
    await first
    await forced
    expect(scanAll).toHaveBeenCalledTimes(2)
    expect(broadcast).toHaveBeenCalledTimes(2)
  })

  it('broadcasts an externally dirtied unchanged index on the next poll', async () => {
    const broadcast = vi.fn()
    const poller = createSessionPoller({ scanAll: async () => [], index: { upsertMany: () => ({ changed: 0 }), getAll: () => [session()] }, broadcast })
    await poller.poll()
    await poller.poll()
    poller.markDirty()
    await poller.poll()
    expect(broadcast).toHaveBeenCalledTimes(2)
  })
})
