export interface TerminalWriter {
  write(data: string): void
}

/**
 * Build the direct PTY-output callback installed on window.ipc.
 *
 * Deliberately synchronous and intentionally has no IPC sender dependency:
 * output is written before the callback returns, with no ack/pause/resume path.
 */
export function createDirectPtyDataHandler(
  expectedPtyId: string,
  terminal: TerminalWriter,
  isCancelled: () => boolean
): (receivedId: unknown, data: unknown) => void {
  return (receivedId, data) => {
    if (receivedId !== expectedPtyId || typeof data !== 'string' || isCancelled()) return
    terminal.write(data)
  }
}
