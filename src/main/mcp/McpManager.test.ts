import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => 'C:\\test-user-data' } }))

import { McpManager } from './McpManager'

describe('McpManager built-in browser status', () => {
  it('advertises every observability tool while the built-in browser is enabled', () => {
    const tools = new McpManager().getStatus().tools
    expect(tools).toEqual(expect.arrayContaining([
      'browser_get_console',
      'browser_get_network',
      'browser_get_cookies',
      'browser_delete_cookie',
    ]))
  })
})
