import { describe, it, expect } from 'vitest'
import { coerceWindowState, DEFAULT_WINDOW_STATE } from './windowState'

describe('coerceWindowState', () => {
  it('returns defaults for non-object inputs', () => {
    for (const bad of [null, undefined, 42, 'x', [], true]) {
      expect(coerceWindowState(bad)).toEqual(DEFAULT_WINDOW_STATE)
    }
  })

  it('passes a fully valid state through unchanged', () => {
    const valid = { x: 100, y: 200, width: 1600, height: 900, isMaximized: true }
    expect(coerceWindowState(valid)).toEqual(valid)
  })

  it('coerces a string width to default while keeping valid siblings', () => {
    const out = coerceWindowState({ x: 100, y: 200, width: 'wide', height: 900, isMaximized: true })
    expect(out).toEqual({ x: 100, y: 200, width: DEFAULT_WINDOW_STATE.width, height: 900, isMaximized: true })
  })

  it('coerces a NaN x to default', () => {
    const out = coerceWindowState({ x: NaN, y: 200, width: 1600, height: 900, isMaximized: false })
    expect(out.x).toBe(DEFAULT_WINDOW_STATE.x)
    expect(out.y).toBe(200)
  })

  it('coerces a negative height to default', () => {
    const out = coerceWindowState({ x: 0, y: 0, width: 1600, height: -5, isMaximized: false })
    expect(out.height).toBe(DEFAULT_WINDOW_STATE.height)
    expect(out.width).toBe(1600)
  })

  it('coerces a truthy-string isMaximized to default', () => {
    const out = coerceWindowState({ x: 0, y: 0, width: 1600, height: 900, isMaximized: 'true' })
    expect(out.isMaximized).toBe(false)
  })

  it('coerces Infinity dimensions to default', () => {
    const out = coerceWindowState({ x: Infinity, y: 0, width: Infinity, height: 900, isMaximized: false })
    expect(out.x).toBe(DEFAULT_WINDOW_STATE.x)
    expect(out.width).toBe(DEFAULT_WINDOW_STATE.width)
  })
})
