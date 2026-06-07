import type { BrowserViewManager } from '../../browser/BrowserViewManager'

export async function waitForLoadTool(
  browser: BrowserViewManager,
  timeoutMs = 10000
): Promise<string> {
  await browser.waitForLoad(timeoutMs)
  return 'Page finished loading'
}
