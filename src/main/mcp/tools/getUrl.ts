import type { BrowserViewManager } from '../../browser/BrowserViewManager'

export function getUrlTool(browser: BrowserViewManager): string {
  return browser.getCurrentUrl()
}
