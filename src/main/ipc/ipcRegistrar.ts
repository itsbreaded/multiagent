export interface IpcLike {
  handle(channel: string, fn: (...args: any[]) => any): void
  on(channel: string, fn: (...args: any[]) => void): void
  removeHandler(channel: string): void
  removeAllListeners(channel: string): void
}

export function createIpcRegistrar(ipc: IpcLike) {
  const handled = new Set<string>()
  const listened = new Set<string>()
  return {
    handle(channel: string, fn: (...args: any[]) => any): void { ipc.handle(channel, fn); handled.add(channel) },
    on(channel: string, fn: (...args: any[]) => void): void { ipc.on(channel, fn); listened.add(channel) },
    disposeAll(): void {
      for (const channel of handled) ipc.removeHandler(channel)
      for (const channel of listened) ipc.removeAllListeners(channel)
      handled.clear(); listened.clear()
    },
  }
}
export type IpcRegistrar = ReturnType<typeof createIpcRegistrar>
