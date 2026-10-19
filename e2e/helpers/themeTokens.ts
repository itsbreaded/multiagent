import type { Page } from '@playwright/test'
import { defaultTheme, themeToCssVariables, type ThemeDefinition } from '../../src/renderer/src/styles/theme'

type ThemeOverrides = {
  color?: Partial<ThemeDefinition['color']>
  nativeColorScheme?: ThemeDefinition['nativeColorScheme']
}

export async function installTestTheme(page: Page, overrides: ThemeOverrides = {}): Promise<void> {
  const theme: ThemeDefinition = {
    ...defaultTheme,
    ...overrides,
    color: { ...defaultTheme.color, ...overrides.color },
  }
  await page.evaluate((variables) => {
    for (const [name, value] of Object.entries(variables)) document.documentElement.style.setProperty(name, value)
    document.documentElement.dispatchEvent(new Event('ui-theme-change'))
  }, themeToCssVariables(theme))
}
