// Tool handler for browser_click
// Used when BrowserMcpServer is run as a subprocess
import type { BrowserViewManager } from '../../browser/BrowserViewManager'

export async function clickTool(browser: BrowserViewManager, selector: string): Promise<string> {
  await browser.click(selector)
  return `Clicked ${selector}`
}
