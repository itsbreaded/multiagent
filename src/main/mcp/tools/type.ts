// Tool handler for browser_type
// Used when BrowserMcpServer is run as a subprocess
import type { BrowserViewManager } from '../../browser/BrowserViewManager'

export async function typeTool(
  browser: BrowserViewManager,
  selector: string,
  text: string
): Promise<string> {
  await browser.type(selector, text)
  return 'Typed text'
}
