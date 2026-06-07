import type { BrowserViewManager } from '../../browser/BrowserViewManager'

export async function keyboardTool(
  browser: BrowserViewManager,
  key: string,
  modifiers: string[] = []
): Promise<string> {
  await browser.keyboard(key, modifiers)
  return `Sent key: ${key}`
}
