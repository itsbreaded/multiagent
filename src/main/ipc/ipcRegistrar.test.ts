import { describe, expect, it, vi } from 'vitest'
import { createIpcRegistrar } from './ipcRegistrar'

describe('createIpcRegistrar', () => {
  it('removes exactly registered long-lived channels and supports a second cycle', () => {
    const active = new Set<string>()
    const fake = { handle: vi.fn((ch: string) => { if (active.has(ch)) throw new Error('duplicate'); active.add(ch) }), on: vi.fn(), removeHandler: vi.fn((ch: string) => active.delete(ch)), removeAllListeners: vi.fn() }
    const first = createIpcRegistrar(fake); first.handle('a', () => {}); first.on('b', () => {}); first.disposeAll()
    expect(fake.removeHandler).toHaveBeenCalledWith('a'); expect(fake.removeAllListeners).toHaveBeenCalledWith('b')
    const second = createIpcRegistrar(fake); expect(() => second.handle('a', () => {})).not.toThrow()
  })
})
