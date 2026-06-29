import { vi } from 'vitest'

/**
 * Stub for `window.ipc` in renderer tests.
 *
 * A no-op instance is installed globally in `tests/setup.renderer.ts` so renderer
 * modules that wire IPC listeners at module load (e.g. the updater store's
 * unguarded `window.ipc.on`) import cleanly. `on`/`send`/`invoke` are vi.fn
 * no-ops: inbound listeners register against the mock but never fire, and store
 * transition tests stay deterministic (they don't emit events).
 *
 * Component tests that assert outbound `invoke`/`send` calls install a FRESH
 * mock per-test via `installMockIpc()` and assert against the returned handle.
 * `invoke` resolves to `undefined` by default; override per-call with
 * `ipc.invoke.mockResolvedValue(...)`.
 */

export interface MockIpc {
  invoke: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
}

export function createMockIpc(): MockIpc {
  return {
    invoke: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  }
}

export function installMockIpc(ipc: MockIpc = createMockIpc()): MockIpc {
  ;(window as unknown as { ipc: unknown }).ipc = ipc
  return ipc
}

export function clearMockIpc(): void {
  delete (window as unknown as { ipc?: unknown }).ipc
}
