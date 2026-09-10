import { describe, expect, it } from 'vitest'
import { scrollOnEraseInDisplayForPane } from './terminalOptions'

describe('scrollOnEraseInDisplayForPane', () => {
  it('uses viewport-only erase for every inline agent pane', () => {
    expect(scrollOnEraseInDisplayForPane('agent')).toBe(false)
  })

  it('preserves erase-to-scrollback behavior for shells and other agents', () => {
    expect(scrollOnEraseInDisplayForPane('shell')).toBe(true)
  })
})
