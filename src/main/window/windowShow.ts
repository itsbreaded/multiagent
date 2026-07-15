/**
 * WindowShowCoordinator — show a BrowserWindow exactly once, with a bounded fallback for
 * environments where the `ready-to-show` event never fires.
 *
 * Background: `createWindow()` creates the main window with `show: false` and shows it from
 * the `ready-to-show` handler to avoid a blank/flashy first paint. On some Linux/Wayland +
 * virtual-GPU stacks (e.g. VirtualBox) the renderer loads fine — `did-finish-load` fires —
 * but `ready-to-show` never emits, so the window stays hidden indefinitely. This coordinator
 * adds a bounded fallback: once the renderer has finished loading, if the window has still not
 * been shown a short delay later, show it. Both paths funnel through one idempotent `doShow`,
 * so there is never a duplicate `show()` and the fallback timer is always cleared on show,
 * close, or destroy.
 *
 * Pure (no Electron import) so it can be unit-tested with fake timers and a spy show action.
 */
export class WindowShowCoordinator {
  private shown = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    /** The actual show action (caller handles maximize + show). */
    private readonly show: () => void,
    /** True once the underlying window is destroyed — never call show on a destroyed window. */
    private readonly isDestroyed: () => boolean,
    /** How long after `onDidLoad` to wait before the fallback shows. */
    private readonly timeoutMs = 1000,
  ) {}

  /** Invoke from the window's `ready-to-show` event. */
  onReadyToShow(): void {
    this.doShow()
  }

  /**
   * Invoke from `webContents.once('did-finish-load', …)`. Starts the bounded fallback timer
   * unless the window is already shown (e.g. `ready-to-show` already fired, which is the
   * normal case and avoids the flash).
   */
  onDidLoad(): void {
    if (this.shown) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.doShow()
    }, this.timeoutMs)
  }

  /** Invoke from the window's `close`/`closed` event to release the fallback timer. */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Whether the show action has already run. */
  get isShown(): boolean {
    return this.shown
  }

  private doShow(): void {
    if (this.shown || this.isDestroyed()) return
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.shown = true
    this.show()
  }
}