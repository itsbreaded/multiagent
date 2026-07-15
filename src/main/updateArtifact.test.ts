import { describe, expect, it, vi } from 'vitest'
import {
  publishedInstallerExists,
  releaseContainsUploadedAsset,
  windowsInstallerName,
} from './updateArtifact'

describe('update artifact validation', () => {
  it('extracts the Windows installer named by updater metadata', () => {
    expect(windowsInstallerName([
      { url: 'MultiAgent%20Setup%200.3.10.exe' },
      { url: 'MultiAgent Setup 0.3.10.exe.blockmap' },
    ])).toBe('MultiAgent Setup 0.3.10.exe')
    expect(windowsInstallerName([{ url: 'latest.yml' }])).toBeNull()
  })

  it('requires an uploaded, non-empty asset with the exact expected name', () => {
    expect(releaseContainsUploadedAsset({
      assets: [{ name: 'MultiAgent Setup 0.3.10.exe', state: 'uploaded', size: 42 }],
    }, 'MultiAgent Setup 0.3.10.exe')).toBe(true)
    expect(releaseContainsUploadedAsset({
      assets: [{ name: 'MultiAgent Setup 0.3.10.exe.blockmap', state: 'uploaded', size: 42 }],
    }, 'MultiAgent Setup 0.3.10.exe')).toBe(false)
    expect(releaseContainsUploadedAsset({
      assets: [{ name: 'MultiAgent Setup 0.3.10.exe', state: 'new', size: 42 }],
    }, 'MultiAgent Setup 0.3.10.exe')).toBe(false)
    expect(releaseContainsUploadedAsset({
      assets: [{ name: 'MultiAgent Setup 0.3.10.exe', state: 'uploaded', size: 0 }],
    }, 'MultiAgent Setup 0.3.10.exe')).toBe(false)
  })

  it('fails closed when GitHub does not return the installer', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ assets: [] }), { status: 200 }))
    await expect(publishedInstallerExists('0.3.10', 'MultiAgent Setup 0.3.10.exe', fetcher))
      .resolves.toBe(false)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('does not send an Authorization header (public repo, no auth needed)', async () => {
    const fetcher: typeof fetch = vi.fn(async () => new Response(JSON.stringify({ assets: [] }), { status: 200 }))
    await publishedInstallerExists('0.3.10', 'MultiAgent Setup 0.3.10.exe', fetcher)
    const [, init] = vi.mocked(fetcher).mock.calls[0]
    expect(Object.keys(init?.headers ?? {})).not.toContain('Authorization')
  })
})
