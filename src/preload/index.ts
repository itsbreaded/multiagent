import { contextBridge, ipcRenderer } from 'electron'
import * as os from 'os'
import type { IPCChannels, InvokeChannels, EventChannels, SendChannels, IpcBridge } from '../shared/types'

type TraceRecord = { channel: string; args: unknown[] }
const e2eTraceEnabled = !!process.env['MULTIAGENT_E2E_USER_DATA_DIR']
const preloadChunks: Array<{ ptyId: string; data: string }> = []
const terminalChunks: Array<{ ptyId: string; data: string }> = []
const invokes: TraceRecord[] = []
const sends: TraceRecord[] = []
const TRACE_LIMIT = 100_000

function pushBounded<T>(items: T[], item: T): void {
  items.push(item)
  if (items.length > TRACE_LIMIT) items.splice(0, items.length - TRACE_LIMIT)
}

if (e2eTraceEnabled) {
  ipcRenderer.on('pty:data', (_event, ptyId: unknown, data: unknown) => {
    if (typeof ptyId === 'string' && typeof data === 'string') {
      pushBounded(preloadChunks, { ptyId, data })
    }
  })
}

// Expose typed IPC bridge to renderer
const bridge: IpcBridge = {
  invoke<C extends InvokeChannels>(channel: C, ...args: Parameters<IPCChannels[C]>): Promise<ReturnType<IPCChannels[C]>> {
    if (e2eTraceEnabled) pushBounded(invokes, { channel, args })
    return ipcRenderer.invoke(channel, ...args) as Promise<ReturnType<IPCChannels[C]>>
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

  send<C extends SendChannels>(channel: C, ...args: Parameters<IPCChannels[C]>): void {
    if (e2eTraceEnabled) pushBounded(sends, { channel, args })
    ipcRenderer.send(channel, ...args)
  }
}
contextBridge.exposeInMainWorld('ipc', bridge)

if (e2eTraceEnabled) {
  contextBridge.exposeInMainWorld('e2ePtyTrace', {
    snapshot: () => ({
      preloadChunks: preloadChunks.slice(),
      terminalChunks: terminalChunks.slice(),
      invokes: invokes.slice(),
      sends: sends.slice(),
    }),
    reset: () => {
      preloadChunks.length = 0
      terminalChunks.length = 0
      invokes.length = 0
      sends.length = 0
    },
    terminalWrite: (ptyId: string, data: string) => {
      if (typeof ptyId === 'string' && typeof data === 'string') {
        pushBounded(terminalChunks, { ptyId, data })
      }
    },
  })
}

// Expose home directory so renderer can use it without process.env (which
// is not available in contextIsolation mode)
contextBridge.exposeInMainWorld('homeDir', os.homedir())

// Expose OS release string (e.g. "10.0.22621") so the renderer can extract
// the Windows build number for xterm's windowsPty ConPTY workaround selection.
contextBridge.exposeInMainWorld('osRelease', os.release())
