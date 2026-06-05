import { contextBridge, ipcRenderer } from 'electron'
import * as os from 'os'
import type { InvokeChannels, EventChannels } from '../shared/types'

// Expose typed IPC bridge to renderer
contextBridge.exposeInMainWorld('ipc', {
  invoke(channel: InvokeChannels, ...args: unknown[]): Promise<unknown> {
    return ipcRenderer.invoke(channel, ...args)
  },

  on(channel: EventChannels, handler: (...args: unknown[]) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => {
      handler(...args)
    }
    ipcRenderer.on(channel, listener)
    // Return unsubscribe function
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },

  send(channel: string, ...args: unknown[]): void {
    ipcRenderer.send(channel, ...args)
  }
})

// Expose home directory so renderer can use it without process.env (which
// is not available in contextIsolation mode)
contextBridge.exposeInMainWorld('homeDir', os.homedir())

// Type augmentation for window.ipc — consumed by renderer TypeScript
export interface IpcBridge {
  invoke(channel: InvokeChannels, ...args: unknown[]): Promise<unknown>
  on(channel: EventChannels, handler: (...args: unknown[]) => void): () => void
  send(channel: string, ...args: unknown[]): void
}

declare global {
  interface Window {
    ipc: IpcBridge
    homeDir: string
  }
}
