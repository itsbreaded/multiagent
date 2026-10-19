import type { ElectronApplication } from '@playwright/test'

/** Assert every E2E BrowserWindow uses an invisible, unfocused offscreen renderer. */
export async function assertDesktopIsolation(app: ElectronApplication): Promise<void> {
  try {
    const state = await app.evaluate(({ BrowserWindow }) => ({
      windows: BrowserWindow.getAllWindows()
        .filter((window) => !window.isDestroyed())
        .map((window) => ({
          visible: window.isVisible(),
          focused: window.isFocused(),
          offscreen: window.webContents.getType() === 'offscreen',
        })),
      diagnostics: (globalThis as typeof globalThis & {
        __multiagentE2EDiagnostics?: { externalOpenAttempts: string[]; blockedNetworkRequests: string[] }
      }).__multiagentE2EDiagnostics,
    }))
    if (state.windows.some((window) => window.visible || window.focused || !window.offscreen)) {
      throw new Error(`E2E created a visible, focused, or non-offscreen Electron window: ${JSON.stringify(state.windows)}`)
    }
    if (!state.diagnostics) throw new Error('E2E desktop/network isolation was not initialized')
  } catch (error) {
    // Some E2E cases intentionally close the process before Playwright teardown.
    let process: ReturnType<ElectronApplication['process']>
    try {
      process = app.process()
    } catch { return }
    if (process.exitCode === null) throw error
  }
}
