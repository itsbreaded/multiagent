import { describe, expect, it } from 'vitest'
import { traceInvokeArgs } from './ipcTrace'

describe('IPC trace privacy', () => {
  it('omits Jira credential saves from E2E traces', () => {
    expect(traceInvokeArgs('jira:save-settings', [{ email: 'chris@example.com', apiToken: 'secret' }])).toBeNull()
    expect(traceInvokeArgs('jira:test-connection', [{ email: 'chris@example.com', apiToken: 'secret' }])).toBeNull()
  })

  it('omits Jira reply bodies and structured recipients from E2E traces', () => {
    expect(traceInvokeArgs('jira-mentions:post-reply', [{
      issueId: '100', sourceCommentId: 'comment-1',
      tokens: [{ kind: 'text', id: 'draft-1', text: 'Confidential reply' }, { kind: 'mention', id: 'mention-1', accountId: 'private-account', displayName: 'Private User' }],
    }])).toBeNull()
  })

  it('continues tracing non-credential IPC calls', () => {
    const args = ['GLD-1955']
    expect(traceInvokeArgs('jira:fetch-status', args)).toEqual(args)
  })
})
