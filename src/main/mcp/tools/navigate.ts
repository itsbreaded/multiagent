// Tool handler for browser_navigate
// Used when BrowserMcpServer is run as a subprocess
import type { BrowserViewManager } from '../../browser/BrowserViewManager'

export async function navigateTool(browser: BrowserViewManager, url: string): Promise<string> {
  await browser.navigate(url)
  return `Navigated to ${url}`
}
