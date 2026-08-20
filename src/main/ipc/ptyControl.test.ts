import { describe, expect, it, vi } from 'vitest'
import { killPtyIfAllowed, senderMayControlPty } from './ptyControl'

describe('pty ownership control', () => {
  it('allows the owner and an unrouted pty, but denies another renderer', () => {
    expect(senderMayControlPty(7, 7)).toBe(true)
    expect(senderMayControlPty(undefined, 7)).toBe(true)
    expect(senderMayControlPty(8, 7)).toBe(false)
  })

  it('allows cross-window teardown while input ownership remains denied', async () => {
    const unroute = vi.fn()
    const release = vi.fn()
    const kill = vi.fn(() => true)
    await expect(killPtyIfAllowed({ getOwner: () => 8, unroute, release, kill }, 'pty-1', 7)).resolves.toBe(true)
    expect(unroute).toHaveBeenCalledWith('pty-1')
    expect(release).toHaveBeenCalledWith('pty-1')
    expect(kill).toHaveBeenCalledWith('pty-1')
  })

  it('unroutes and releases before killing for owner and unrouted teardown', async () => {
    for (const owner of [7, undefined]) {
      const calls: string[] = []
      await expect(killPtyIfAllowed({
        getOwner: () => owner,
        unroute: () => { calls.push('unroute') },
        release: () => { calls.push('release') },
        kill: () => { calls.push('kill'); return true },
      }, 'pty-1', 7)).resolves.toBe(true)
      expect(calls).toEqual(['unroute', 'release', 'kill'])
    }
  })
})
