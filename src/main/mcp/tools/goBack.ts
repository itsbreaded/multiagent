import type { BrowserViewManager } from '../../browser/BrowserViewManager'

export async function goBackTool(browser: BrowserViewManager): Promise<string> {
  await browser.goBack()
  return `Navigated back to ${browser.getCurrentUrl()}`
}
