import type { BrowserViewManager } from '../../browser/BrowserViewManager'

export async function hoverTool(browser: BrowserViewManager, selector: string): Promise<string> {
  await browser.hover(selector)
  return `Hovered ${selector}`
}
