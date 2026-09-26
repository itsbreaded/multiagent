import { describe, expect, it } from 'vitest'
import { traceInvokeArgs } from './ipcTrace'

describe('IPC trace privacy', () => {
  it('omits Jira credential saves from E2E traces', () => {
    expect(traceInvokeArgs('jira:save-settings', [{ email: 'chris@example.com', apiToken: 'secret' }])).toBeNull()
    expect(traceInvokeArgs('jira:test-connection', [{ email: 'chris@example.com', apiToken: 'secret' }])).toBeNull()
  })

  it('continues tracing non-credential IPC calls', () => {
    const args = ['GLD-1955']
    expect(traceInvokeArgs('jira:fetch-status', args)).toEqual(args)
  })
})
