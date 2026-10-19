import type { Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

export async function screenshotUi(
  page: Page,
  path: string,
  clip?: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const terminalScreens = page.locator('.xterm-screen')
  const visibility = await terminalScreens.evaluateAll((elements) => elements.map((element) => element.style.visibility))
  await terminalScreens.evaluateAll((elements) => elements.forEach((element) => {
    ;(element as HTMLElement).style.visibility = 'hidden'
  }))
  try {
    // Playwright's high-level screenshot waits for document.fonts.ready. Hidden
    // Electron windows may leave that wait pending despite loaded fonts, so
    // capture the renderer surface directly through CDP without showing it.
    const cdp = await page.context().newCDPSession(page)
    try {
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        ...(clip ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : {}),
      })
      await writeFile(path, Buffer.from(data, 'base64'))
    } finally {
      await cdp.detach()
    }
  } finally {
    await terminalScreens.evaluateAll((elements, previous) => elements.forEach((element, index) => {
      const style = (element as HTMLElement).style
      if (previous[index]) style.visibility = previous[index]
      else style.removeProperty('visibility')
    }), visibility)
  }
}
