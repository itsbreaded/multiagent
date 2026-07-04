import { describe, it, expect } from 'vitest'
import {
  defaultTerminalKeyBindings,
  TERMINAL_BINDING_ORDER,
  isWellKnownId,
  isCustomBindingId,
  defaultTrigger,
  defaultLabel,
  triggersEqual,
  bindingKey,
  bindingDisplay,
  isValidTrigger,
  findClaimant,
  buildTerminalKeyMap,
  getTerminalKeyMap,
  mergeBindings,
  type TerminalKeyBinding,
  type Trigger,
} from './terminalKeyBindings'

describe('getTerminalKeyMap', () => {
  it('reuses the map for one bindings reference and rebuilds for a replacement', () => {
    const bindings = defaultTerminalKeyBindings()
    expect(getTerminalKeyMap(bindings)).toBe(getTerminalKeyMap(bindings))
    const replacement = bindings.map((binding, index) => index === 0
      ? { ...binding, trigger: { ...binding.trigger, code: 'KeyZ' } }
      : binding)
    expect(getTerminalKeyMap(replacement)).not.toBe(getTerminalKeyMap(bindings))
    expect(getTerminalKeyMap(replacement).get(bindingKey(replacement[0].trigger))?.kind).toBe('action')
  })
})

describe('defaultTerminalKeyBindings', () => {
  it('returns a row for every well-known id in canonical order', () => {
    const defaults = defaultTerminalKeyBindings()
    expect(defaults.map((b) => b.id)).toEqual(TERMINAL_BINDING_ORDER)
  })

  it('returns fresh copies (mutation does not bleed across calls)', () => {
    const a = defaultTerminalKeyBindings()
    a[0].trigger.code = 'Mutated'
    const b = defaultTerminalKeyBindings()
    expect(b[0].trigger.code).not.toBe('Mutated')
  })
})

describe('id classification', () => {
  it('isWellKnownId', () => {
    expect(isWellKnownId('copy')).toBe(true)
    expect(isWellKnownId('custom-deadbeef')).toBe(false)
  })
  it('isCustomBindingId', () => {
    expect(isCustomBindingId('custom-1')).toBe(true)
    expect(isCustomBindingId('copy')).toBe(false)
  })
})

describe('trigger helpers', () => {
  it('defaultTrigger / defaultLabel resolve for well-known ids', () => {
    expect(defaultTrigger('copy')).toEqual({ code: 'KeyC', ctrl: true, shift: false, alt: false, meta: false })
    expect(defaultLabel('copy')).toBe('Copy selection')
    expect(defaultTrigger('custom-1')).toBeUndefined()
    expect(defaultLabel('custom-1')).toBeUndefined()
  })

  it('triggersEqual compares all modifier flags + code', () => {
    const base: Trigger = { code: 'KeyC', ctrl: true, shift: false, alt: false, meta: false }
    expect(triggersEqual(base, { ...base })).toBe(true)
    expect(triggersEqual(base, { ...base, shift: true })).toBe(false)
    expect(triggersEqual(base, { ...base, alt: true })).toBe(false)
    expect(triggersEqual(base, { ...base, code: 'KeyV' })).toBe(false)
  })

  it('bindingKey is a deterministic ctrl:shift:alt:meta:code fingerprint', () => {
    expect(bindingKey({ code: 'KeyC', ctrl: true, shift: false, alt: false, meta: false })).toBe('1:0:0:0:KeyC')
  })

  it('bindingDisplay renders modifier order then key', () => {
    expect(bindingDisplay({ code: 'KeyC', ctrl: true, shift: true, alt: false, meta: false })).toBe('Ctrl+Shift+C')
    expect(bindingDisplay({ code: 'KeyC', ctrl: false, shift: false, alt: true, meta: false })).toBe('Alt+C')
  })

  it('isValidTrigger requires a code plus ctrl/alt/meta', () => {
    expect(isValidTrigger({ code: 'KeyC', ctrl: true, shift: false, alt: false, meta: false })).toBe(true)
    expect(isValidTrigger({ code: '', ctrl: true, shift: false, alt: false, meta: false })).toBe(false)
    expect(isValidTrigger({ code: 'KeyM', ctrl: false, shift: true, alt: false, meta: false })).toBe(false)
    expect(isValidTrigger({ code: 'KeyM', ctrl: false, shift: true, alt: true, meta: false })).toBe(true)
  })
})

describe('findClaimant', () => {
  const bindings = defaultTerminalKeyBindings()

  it('returns the first binding whose fingerprint matches', () => {
    const copyKey = bindingKey({ code: 'KeyC', ctrl: true, shift: false, alt: false, meta: false })
    expect(findClaimant(bindings, copyKey)?.id).toBe('copy')
  })
  it('skips an excluded id', () => {
    const copyKey = bindingKey({ code: 'KeyC', ctrl: true, shift: false, alt: false, meta: false })
    expect(findClaimant(bindings, copyKey, 'copy')).toBeUndefined()
  })
  it('returns undefined when nothing matches', () => {
    expect(findClaimant(bindings, '9:9:9:9:KeyZ')).toBeUndefined()
  })
})

describe('buildTerminalKeyMap', () => {
  it('maps every active default binding to its key', () => {
    const map = buildTerminalKeyMap(defaultTerminalKeyBindings())
    const copyKey = bindingKey({ code: 'KeyC', ctrl: true, shift: false, alt: false, meta: false })
    expect(map.get(copyKey)?.kind).toBe('action')
  })

  it('inserts a suppress entry for a rebound pty-sequence default trigger', () => {
    const bindings = defaultTerminalKeyBindings().map((b) =>
      b.id === 'eof'
        ? { ...b, trigger: { code: 'KeyQ', ctrl: true, shift: false, alt: false, meta: false } }
        : b,
    )
    const map = buildTerminalKeyMap(bindings)
    // New binding claimant at KeyQ.
    expect(map.get(bindingKey({ code: 'KeyQ', ctrl: true, shift: false, alt: false, meta: false }))?.kind).toBe('action')
    // Vacated default Ctrl+D is suppressed so it doesn't fall through to native xterm.
    expect(map.get(bindingKey({ code: 'KeyD', ctrl: true, shift: false, alt: false, meta: false }))).toEqual({ kind: 'suppress' })
  })
})

describe('mergeBindings', () => {
  it('backfills missing well-known ids with defaults', () => {
    const merged = mergeBindings([])
    expect(merged.map((b) => b.id)).toEqual(TERMINAL_BINDING_ORDER)
  })

  it('keeps a stored customized trigger on a well-known id', () => {
    const stored: TerminalKeyBinding[] = [
      { id: 'eof', label: 'Send EOF', trigger: { code: 'KeyQ', ctrl: true, shift: false, alt: false, meta: false }, action: { type: 'pty-sequence', sequence: '\x04' } },
    ]
    const merged = mergeBindings(stored)
    const eof = merged.find((b) => b.id === 'eof')
    expect(eof?.trigger.code).toBe('KeyQ')
  })

  it('appends sanitized custom text-macro bindings after well-known rows', () => {
    const stored: TerminalKeyBinding[] = [
      { id: 'custom-1', label: 'Greet', trigger: { code: 'KeyG', ctrl: true, shift: false, alt: false, meta: false }, action: { type: 'text-macro', text: 'hi' } },
    ]
    const merged = mergeBindings(stored)
    expect(merged[merged.length - 1].id).toBe('custom-1')
  })

  it('drops custom bindings with an invalid (shift-only) trigger', () => {
    const stored = [
      { id: 'custom-bad', label: 'Bad', trigger: { code: 'KeyG', ctrl: false, shift: true, alt: false, meta: false }, action: { type: 'text-macro', text: 'hi' } },
    ] as unknown as TerminalKeyBinding[]
    const merged = mergeBindings(stored)
    expect(merged.find((b) => b.id === 'custom-bad')).toBeUndefined()
  })

  it('migrates the legacy kill-word default (KeyW) to Backspace when requested', () => {
    const stored: TerminalKeyBinding[] = [
      { id: 'kill-word', label: 'Kill word', trigger: { code: 'KeyW', ctrl: true, shift: false, alt: false, meta: false }, action: { type: 'pty-sequence', sequence: '\x17' } },
    ]
    const migrated = mergeBindings(stored, { migrateOldKillWordDefault: true })
    const kw = migrated.find((b) => b.id === 'kill-word')
    expect(kw?.trigger.code).toBe('Backspace')

    const notMigrated = mergeBindings(stored, { migrateOldKillWordDefault: false })
    expect(notMigrated.find((b) => b.id === 'kill-word')?.trigger.code).toBe('KeyW')
  })
})
