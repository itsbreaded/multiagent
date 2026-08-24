import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openExternal } = vi.hoisted(() => ({
  openExternal: vi.fn<(url: string) => Promise<void>>(() => Promise.resolve()),
}))

vi.mock('electron', () => ({ shell: { openExternal } }))

import { openExternalUrl } from './external'

describe('openExternalUrl', () => {
  beforeEach(() => openExternal.mockClear())

  it('allows the existing external protocols', () => {
    openExternalUrl('https://example.com/path')
    openExternalUrl('http://example.com')
    openExternalUrl('mailto:user@example.com')

    expect(openExternal.mock.calls.map(([url]) => url)).toEqual([
      'https://example.com/path',
      'http://example.com/',
      'mailto:user@example.com',
    ])
  })

  it('rejects malformed and unsupported protocols without opening them', () => {
    openExternalUrl('not a URL')
    openExternalUrl('file:///C:/secret.txt')
    openExternalUrl('data:text/html,<h1>secret</h1>')
    openExternalUrl('javascript:alert(1)')

    expect(openExternal).not.toHaveBeenCalled()
  })
})
