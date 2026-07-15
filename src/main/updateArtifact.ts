export interface UpdateFileReference {
  url: string
}

interface GitHubReleaseAsset {
  name?: unknown
  state?: unknown
  size?: unknown
}

interface GitHubReleaseResponse {
  assets?: unknown
}

export function windowsInstallerName(files: UpdateFileReference[] | undefined): string | null {
  for (const file of files ?? []) {
    if (!file || typeof file.url !== 'string') continue
    try {
      const pathname = new URL(file.url, 'https://updates.invalid/').pathname
      const name = decodeURIComponent(pathname.split('/').pop() ?? '')
      if (name.toLowerCase().endsWith('.exe')) return name
    } catch {
      // Ignore malformed metadata and continue looking for a valid installer.
    }
  }
  return null
}

export function releaseContainsUploadedAsset(payload: unknown, expectedName: string): boolean {
  if (!payload || typeof payload !== 'object') return false
  const assets = (payload as GitHubReleaseResponse).assets
  if (!Array.isArray(assets)) return false
  return assets.some((value) => {
    if (!value || typeof value !== 'object') return false
    const asset = value as GitHubReleaseAsset
    return asset.name === expectedName && asset.state === 'uploaded' &&
      typeof asset.size === 'number' && asset.size > 0
  })
}

export async function publishedInstallerExists(
  version: string,
  expectedName: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetcher(
      `https://api.github.com/repos/itsbreaded/multiagent/releases/tags/v${encodeURIComponent(version)}`,
      {
        // Public repo: releases/assets are readable without auth. No Authorization header.
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'MultiAgent-Updater',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!response.ok) return false
    return releaseContainsUploadedAsset(await response.json(), expectedName)
  } catch {
    return false
  }
}
