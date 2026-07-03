import { describe, it, expect } from 'vitest'
import {
  DEFAULT_HOTKEYS,
  codeToDisplayKey,
  hotkeyDisplay,
  hotkeyKey,
  eventKey,
  matches,
  buildHotkeys,
  getHotkeys,
} from './hotkeys'

describe('getHotkeys', () => {
  it('reuses results by override reference and rebuilds for replacements', () => {
    const overrides = {}
    expect(getHotkeys(overrides)).toBe(getHotkeys(overrides))
    const replacement = { newTab: { code: 'KeyZ', shift: false } }
    expect(getHotkeys(replacement)).not.toBe(getHotkeys(overrides))
    expect(getHotkeys(replacement).newTab.code).toBe('KeyZ')
  })
})

function ke(code: string, opts: Partial<Pick<KeyboardEvent, 'shiftKey' | 'ctrlKey' | 'metaKey'>>): KeyboardEvent {
  return { code, shiftKey: false, ctrlKey: false, metaKey: false, ...opts } as unknown as KeyboardEvent
}

describe('codeToDisplayKey', () => {
  it('strips the Key prefix', () => {
    expect(codeToDisplayKey('KeyT')).toBe('T')
  })
  it('leaves non-letter codes unchanged', () => {
    expect(codeToDisplayKey('Enter')).toBe('Enter')
    expect(codeToDisplayKey('KeyP')).toBe('P')
  })
})

describe('hotkeyDisplay', () => {
  it('renders Ctrl-only combos', () => {
    expect(hotkeyDisplay('KeyT', false)).toBe('Ctrl+T')
  })
  it('renders Ctrl+Shift combos', () => {
    expect(hotkeyDisplay('KeyE', true)).toBe('Ctrl+Shift+E')
  })
})

describe('matches', () => {
  it('matches on code + shift + a modifier', () => {
    expect(matches(ke('KeyW', { ctrlKey: true }), DEFAULT_HOTKEYS.closeTab)).toBe(true)
  })
  it('matches metaKey as an alternative modifier', () => {
    expect(matches(ke('KeyW', { metaKey: true }), DEFAULT_HOTKEYS.closeTab)).toBe(true)
  })
  it('does not match without ctrl or meta', () => {
    expect(matches(ke('KeyW', {}), DEFAULT_HOTKEYS.closeTab)).toBe(false)
  })
  it('does not match when shift differs', () => {
    expect(matches(ke('KeyW', { ctrlKey: true, shiftKey: true }), DEFAULT_HOTKEYS.closeTab)).toBe(false)
  })
})

describe('lookup keys', () => {
  it('hotkeyKey and eventKey agree for the same combo', () => {
    const h = DEFAULT_HOTKEYS.commandPalette
    expect(eventKey(ke('KeyP', { ctrlKey: true, shiftKey: true }))).toBe(hotkeyKey(h))
  })
})

describe('buildHotkeys', () => {
  it('returns defaults when no overrides given', () => {
    const h = buildHotkeys({})
    expect(h.newTab).toEqual(DEFAULT_HOTKEYS.newTab)
  })
  it('applies an override and recomputes its display string', () => {
    const h = buildHotkeys({ newTab: { code: 'KeyN', shift: true } })
    expect(h.newTab.code).toBe('KeyN')
    expect(h.newTab.shift).toBe(true)
    expect(h.newTab.display).toBe('Ctrl+Shift+N')
  })
  it('leaves non-overridden hotkeys untouched', () => {
    const h = buildHotkeys({ newTab: { code: 'KeyN', shift: false } })
    expect(h.closeTab).toEqual(DEFAULT_HOTKEYS.closeTab)
  })
})
