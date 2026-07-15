import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WindowShowCoordinator } from './windowShow'

// WindowShowCoordinator shows a window exactly once, preferring the `ready-to-show` path
// (no flash) and falling back to a bounded timer after `did-finish-load` for environments
// where `ready-to-show` never fires (Linux/Wayland + virtual GPU). Fake timers drive the
// timing deterministically; a spy stands in for the real `show()` action.

describe('WindowShowCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows once on ready-to-show and ignores further ready-to-show', () => {
    const show = vi.fn()
    const c = new WindowShowCoordinator(show, () => false)
    c.onReadyToShow()
    c.onReadyToShow()
    expect(show).toHaveBeenCalledTimes(1)
    expect(c.isShown).toBe(true)
  })

  it('does not show a destroyed window', () => {
    const show = vi.fn()
    const c = new WindowShowCoordinator(show, () => true)
    c.onReadyToShow()
    expect(show).not.toHaveBeenCalled()
    expect(c.isShown).toBe(false)
  })

  it('falls back to showing after did-finish-load when ready-to-show never fires', () => {
    const show = vi.fn()
    const c = new WindowShowCoordinator(show, () => false, 1000)
    c.onDidLoad()
    // Not shown before the delay elapses.
    vi.advanceTimersByTime(999)
    expect(show).not.toHaveBeenCalled()
    expect(c.isShown).toBe(false)
    vi.advanceTimersByTime(1)
    expect(show).toHaveBeenCalledTimes(1)
    expect(c.isShown).toBe(true)
  })

  it('ready-to-show cancels the pending fallback timer (no double show)', () => {
    const show = vi.fn()
    const c = new WindowShowCoordinator(show, () => false, 1000)
    c.onDidLoad()
    vi.advanceTimersByTime(500)
    expect(show).not.toHaveBeenCalled()
    c.onReadyToShow()
    expect(show).toHaveBeenCalledTimes(1)
    // The fallback timer must not fire later.
    vi.advanceTimersByTime(5000)
    expect(show).toHaveBeenCalledTimes(1)
    expect(c.isShown).toBe(true)
  })

  it('onDidLoad is a no-op when ready-to-show already showed (no flash on normal path)', () => {
    const show = vi.fn()
    const c = new WindowShowCoordinator(show, () => false, 1000)
    c.onReadyToShow()
    c.onDidLoad()
    vi.advanceTimersByTime(5000)
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('dispose clears the fallback timer so it never fires', () => {
    const show = vi.fn()
    const c = new WindowShowCoordinator(show, () => false, 1000)
    c.onDidLoad()
    vi.advanceTimersByTime(200)
    c.dispose()
    vi.advanceTimersByTime(5000)
    expect(show).not.toHaveBeenCalled()
  })

  it('dispose after the fallback already fired is harmless', () => {
    const show = vi.fn()
    const c = new WindowShowCoordinator(show, () => false, 1000)
    c.onDidLoad()
    vi.advanceTimersByTime(1000)
    expect(show).toHaveBeenCalledTimes(1)
    c.dispose() // no throw, no extra show
    vi.advanceTimersByTime(5000)
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('the fallback does not show a destroyed window', () => {
    const show = vi.fn()
    const c = new WindowShowCoordinator(show, () => true, 1000)
    c.onDidLoad()
    vi.advanceTimersByTime(1000)
    expect(show).not.toHaveBeenCalled()
    expect(c.isShown).toBe(false)
  })
})