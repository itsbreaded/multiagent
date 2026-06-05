// Tool handler for browser_evaluate
// Used when BrowserMcpServer is run as a subprocess
import type { BrowserViewManager } from '../../browser/BrowserViewManager'

export async function evaluateTool(browser: BrowserViewManager, js: string): Promise<string> {
  const result = await browser.evaluate(js)
  return JSON.stringify(result)
}
