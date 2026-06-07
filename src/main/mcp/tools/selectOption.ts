import type { BrowserViewManager } from '../../browser/BrowserViewManager'

export async function selectOptionTool(
  browser: BrowserViewManager,
  selector: string,
  value: string
): Promise<string> {
  await browser.selectOption(selector, value)
  return `Selected "${value}" in ${selector}`
}
