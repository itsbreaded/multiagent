import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => 'C:\\test-user-data' } }))

import { McpManager } from './McpManager'

describe('McpManager built-in browser status', () => {
  it('keeps the built-in browser stopped by default', () => {
    const manager = new McpManager()
    const status = manager.getStatus()
    expect(status).toMatchObject({ port: null, running: false, tools: [] })
    expect(manager.getSettings().builtinBrowserEnabled).toBe(false)
  })
})
