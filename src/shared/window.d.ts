import type { IpcBridge } from './types'

declare global {
  interface Window {
    ipc: IpcBridge
    homeDir: string
    osRelease: string
  }
}

export {}
