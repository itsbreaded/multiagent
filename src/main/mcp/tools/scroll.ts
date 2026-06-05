// Tool handler for browser_scroll
// Used when BrowserMcpServer is run as a subprocess
import type { BrowserViewManager } from '../../browser/BrowserViewManager'

export async function scrollTool(
  browser: BrowserViewManager,
  x: number,
  y: number
): Promise<string> {
  await browser.scroll(x, y)
  return 'Scrolled'
}
