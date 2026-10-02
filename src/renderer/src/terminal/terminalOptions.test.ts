import { describe, expect, it } from 'vitest'
import { mouseEventsRequireAltForPane, scrollOnEraseInDisplayForPane } from './terminalOptions'

describe('scrollOnEraseInDisplayForPane', () => {
  it('uses viewport-only erase for every inline agent pane', () => {
    expect(scrollOnEraseInDisplayForPane('agent')).toBe(false)
  })

  it('preserves erase-to-scrollback behavior for shells and other agents', () => {
    expect(scrollOnEraseInDisplayForPane('shell')).toBe(true)
  })
})

describe('mouseEventsRequireAltForPane', () => {
  it('keeps normal selection and context menus available in Codex fullscreen panes', () => {
    expect(mouseEventsRequireAltForPane('agent', 'codex')).toBe(true)
  })

  it('does not change shell or non-Codex agent mouse behavior', () => {
    expect(mouseEventsRequireAltForPane('shell')).toBe(false)
    expect(mouseEventsRequireAltForPane('agent', 'claude')).toBe(false)
    expect(mouseEventsRequireAltForPane('agent', 'opencode')).toBe(false)
  })
})
