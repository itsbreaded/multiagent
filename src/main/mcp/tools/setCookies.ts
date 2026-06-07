import type { BrowserViewManager } from '../../browser/BrowserViewManager'

export async function setCookiesTool(
  browser: BrowserViewManager,
  cookies: Array<{ url: string; name: string; value: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; expirationDate?: number }>
): Promise<string> {
  await browser.setCookies(cookies)
  return `Set ${cookies.length} cookie(s)`
}
