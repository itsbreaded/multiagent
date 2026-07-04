import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  delete (window as unknown as { ipc?: unknown }).ipc
  vi.resetModules()
})

describe('updater store IPC wiring', () => {
  it('imports safely without IPC', async () => {
    delete (window as unknown as { ipc?: unknown }).ipc
    await expect(import('./updater')).resolves.toBeDefined()
  })

  it('accepts valid status objects and ignores malformed payloads', async () => {
    let listener: ((value: unknown) => void) | undefined
    ;(window as unknown as { ipc: { on: (_channel: string, handler: (value: unknown) => void) => () => void } }).ipc = {
      on: (_channel, handler) => { listener = handler; return () => {} },
    }
    const { useUpdaterStore } = await import('./updater')
    listener?.({ state: 42 })
    expect(useUpdaterStore.getState().status).toBeNull()
    listener?.({ state: 'ready', version: '1.2.3' })
    expect(useUpdaterStore.getState().status).toMatchObject({ state: 'ready', version: '1.2.3' })
  })
})
