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

  it('skips overlapping scans and carries a skipped force to the next tick', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const scanAll = vi.fn(async () => { await gate; return [] })
    const broadcast = vi.fn()
    const poller = createSessionPoller({ scanAll, index: { upsertMany: () => ({ changed: 0 }), getAll: () => [session()] }, broadcast })
    const first = poller.poll()
    await poller.poll(true)
    expect(scanAll).toHaveBeenCalledTimes(1)
    release()
    await first
    await poller.poll()
    expect(broadcast).toHaveBeenCalledTimes(2)
  })
})
