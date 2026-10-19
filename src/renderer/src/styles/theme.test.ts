import { describe, expect, it } from 'vitest'
import { defaultTheme, installTheme, readThemeColor, themeToCssVariables, type ThemeDefinition } from './theme'

describe('themeToCssVariables', () => {
  it('maps the default theme palette and control settings to the renderer root', () => {
    const variables = themeToCssVariables(defaultTheme)

    expect(variables['--ui-color-app-bg']).toBe('#0e1011')
    expect(variables['--ui-color-accent']).toBe('#4ade80')
    expect(variables['--ui-radius-modal']).toBe('10px')
    expect(variables['--ui-shadow-overlay']).toBe('0 24px 64px rgba(0,0,0,0.6)')
    expect(variables['--ui-native-color-scheme']).toBe('dark')
  })

  it('lets a complete theme replace values without changing component references', () => {
    const alternate: ThemeDefinition = {
      ...defaultTheme,
      color: { ...defaultTheme.color, appBg: '#f8fafc', accent: '#2563eb' },
      nativeColorScheme: 'light',
    }
    const variables = themeToCssVariables(alternate)

    expect(variables['--ui-color-app-bg']).toBe('#f8fafc')
    expect(variables['--ui-color-accent']).toBe('#2563eb')
    expect(variables['--ui-native-color-scheme']).toBe('light')
  })

  it('installs tokens before consumers read them and emits a theme-change signal', () => {
    const values = new Map<string, string>()
    const dispatched: Event[] = []
    const root = {
      style: {
        setProperty: (name: string, value: string) => values.set(name, value),
        getPropertyValue: (name: string) => values.get(name) ?? '',
      },
      dispatchEvent: (event: Event) => { dispatched.push(event); return true },
    } as unknown as HTMLElement
    const alternate: ThemeDefinition = {
      ...defaultTheme,
      color: { ...defaultTheme.color, appBg: '#112233' },
    }

    installTheme(alternate, root)

    expect(readThemeColor('appBg', root)).toBe('#112233')
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.type).toBe('ui-theme-change')
  })
})
