// Tool handler for browser_get_content
// Used when BrowserMcpServer is run as a subprocess
import type { BrowserViewManager } from '../../browser/BrowserViewManager'

export async function getContentTool(browser: BrowserViewManager): Promise<string> {
  return browser.getContent()
}
