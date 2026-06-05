// Tool handler for browser_screenshot
// Used when BrowserMcpServer is run as a subprocess
import type { BrowserViewManager } from '../../browser/BrowserViewManager'

export async function screenshotTool(browser: BrowserViewManager): Promise<string> {
  const dataUrl = await browser.screenshot()
  // Strip the data URL prefix and return raw base64
  return dataUrl.replace(/^data:image\/\w+;base64,/, '')
}
