import type { BrowserViewManager } from '../../browser/BrowserViewManager'

export async function goForwardTool(browser: BrowserViewManager): Promise<string> {
  await browser.goForward()
  return `Navigated forward to ${browser.getCurrentUrl()}`
}
