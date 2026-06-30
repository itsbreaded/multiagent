import type { IpcBridge } from './types'

declare global {
  interface Window {
    ipc: IpcBridge
    homeDir: string
    osRelease: string
    /** Present only in isolated Playwright profiles. Never exposed in production. */
    e2ePtyTrace?: {
      snapshot(): {
        preloadChunks: Array<{ ptyId: string; data: string }>
        terminalChunks: Array<{ ptyId: string; data: string }>
        invokes: Array<{ channel: string; args: unknown[] }>
        sends: Array<{ channel: string; args: unknown[] }>
      }
      reset(): void
      terminalWrite(ptyId: string, data: string): void
    }
  }
}

export {}
