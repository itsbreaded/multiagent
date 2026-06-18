// Tool handler for browser_get_content
// Used when BrowserMcpServer is run as a subprocess
import type { BrowserContentOptions, BrowserViewManager } from '../../browser/BrowserViewManager'

export async function getContentTool(
  browser: BrowserViewManager,
  options: BrowserContentOptions = {}
): Promise<string> {
  return (await browser.getContent(options)).text
}
