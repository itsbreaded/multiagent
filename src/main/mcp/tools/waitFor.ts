// Tool handler for browser_wait_for
// Used when BrowserMcpServer is run as a subprocess
import type { BrowserViewManager } from '../../browser/BrowserViewManager'

export async function waitForTool(
  browser: BrowserViewManager,
  selector: string,
  timeoutMs = 5000
): Promise<string> {
  await browser.waitFor(selector, timeoutMs)
  return `Element found: ${selector}`
}
