/**
 * Effect 2 helper for shell panes (spec 034).
 *
 * Extracted from Terminal/index.tsx so the cancel-kill and retry-unblock
 * behavior is unit-testable without dragging xterm into the test setup.
 *
 * Returns a `cancel()` that guarantees any ptyId the invoke resolves with after
 * cancellation is killed immediately — otherwise the spawned PowerShell process
 * would outlive the pane that will never own it. A rejected invoke releases the
 * re-entry guard (via `releaseGuard`) so a later effect run for the same pane
 * can retry instead of being permanently bricked.
 */

export interface CreateShellPtyDeps {
  /** The IPC invoke surface — narrowed so tests can pass a plain stub. */
  ipc: Pick<Window['ipc'], 'invoke'>
  getInitialSize: () => { cols: number; rows: number }
  onPtyId: (ptyId: string) => void
  onError: (message: string) => void
  /** Releases the parent component's re-entry guard for this pane. */
  releaseGuard: () => void
}

export interface CreateShellPtyHandle {
  /** Detach: any ptyId that resolves after this is killed immediately. */
  cancel: () => void
}

export function createShellPty(cwd: string, deps: CreateShellPtyDeps): CreateShellPtyHandle {
  const { ipc, getInitialSize, onPtyId, onError, releaseGuard } = deps
  let cancelled = false
  const initialSize = getInitialSize()

  void ipc
    .invoke('pty:create', cwd, initialSize.cols, initialSize.rows)
    .then((result) => {
      const ptyId = (result as { ptyId?: unknown } | null)?.ptyId
      if (cancelled) {
        // The pane unmounted while pty:create was in flight; nothing will ever
        // own this PTY, so kill it immediately. Swallow errors — best effort.
        if (typeof ptyId === 'string') {
          ipc.invoke('pty:kill', ptyId).catch(() => {})
        }
        return
      }
      if (typeof ptyId !== 'string') throw new Error('pty:create did not return a ptyId')
      onPtyId(ptyId)
    })
    .catch((err: unknown) => {
      // Reset the guard *before* the cancelled early-return so a cancelled-then-
      // failed create also unblocks a future mount of the same pane id. The
      // parent's releaseGuard is responsible for the same-pane-id check
      // (`shellCreatePaneRef.current === pane.id`), so calling it from the
      // cancelled path is safe.
      releaseGuard()
      if (cancelled) return
      onError(err instanceof Error ? err.message : 'Failed to create terminal')
    })

  return {
    cancel: () => {
      cancelled = true
    },
  }
}
