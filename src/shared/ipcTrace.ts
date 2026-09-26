/**
 * E2E IPC traces are diagnostic data, not an authorization channel. Jira
 * credential-bearing invocations omit the whole invocation rather than attempting to
 * partially redact an evolving settings shape.
 */
export function traceInvokeArgs(channel: string, args: readonly unknown[]): unknown[] | null {
  if (channel === 'jira:save-settings' || channel === 'jira:test-connection') return null
  return [...args]
}
