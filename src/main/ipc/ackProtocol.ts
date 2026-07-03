export interface AckEventSource {
  on(channel: string, listener: (...args: any[]) => void): void
  removeListener(channel: string, listener: (...args: any[]) => void): void
  senderWindowId(event: unknown): number | undefined
}

export function createAckProtocol(source: AckEventSource) {
  function waitForAck(windowId: number, channel: string, id: string, trigger: () => void, ms = 1000): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true; clearTimeout(timer); source.removeListener(channel, onAck); resolve(value)
      }
      const onAck = (event: unknown, ackId: unknown): void => {
        if (ackId === id && source.senderWindowId(event) === windowId) finish(true)
      }
      source.on(channel, onAck)
      const timer = setTimeout(() => finish(false), ms)
      trigger()
    })
  }
  function waitForAckWithResult(windowId: number, channel: string, id: string, trigger: () => void, ms = 1000): Promise<{ acked: boolean; ok: boolean }> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: { acked: boolean; ok: boolean }): void => {
        if (settled) return
        settled = true; clearTimeout(timer); source.removeListener(channel, onAck); resolve(value)
      }
      const onAck = (event: unknown, ackId: unknown, ok: unknown): void => {
        if (ackId === id && source.senderWindowId(event) === windowId) finish({ acked: true, ok: ok !== false })
      }
      source.on(channel, onAck)
      const timer = setTimeout(() => finish({ acked: false, ok: false }), ms)
      trigger()
    })
  }
  return { waitForAck, waitForAckWithResult }
}
