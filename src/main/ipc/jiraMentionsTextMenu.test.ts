import { describe, expect, it, vi } from 'vitest'
import { buildJiraMentionsTextMenu, popupJiraMentionsTextMenu } from './jiraMentionsTextMenu'

describe('buildJiraMentionsTextMenu', () => {
  it('creates editable actions with capability-based availability', () => {
    expect(buildJiraMentionsTextMenu({
      target: 'editable',
      canCut: false,
      canCopy: true,
      canPaste: true,
      canSelectAll: true,
    })).toEqual([
      { role: 'cut', enabled: false },
      { role: 'copy', enabled: true },
      { role: 'paste', enabled: true },
      { type: 'separator' },
      { role: 'selectAll', enabled: true },
    ])
  })

  it('offers only Copy for selected read-only text', () => {
    expect(buildJiraMentionsTextMenu({
      target: 'selection',
      canCut: false,
      canCopy: true,
      canPaste: false,
      canSelectAll: false,
    })).toEqual([{ role: 'copy', enabled: true }])
    expect(buildJiraMentionsTextMenu({
      target: 'selection',
      canCut: false,
      canCopy: false,
      canPaste: false,
      canSelectAll: false,
    })).toEqual([])
  })
})

describe('popupJiraMentionsTextMenu', () => {
  it('anchors the native menu to the requesting window and point', () => {
    const window = { id: 7 }
    const menu = { popup: vi.fn() }

    popupJiraMentionsTextMenu(menu, window, { x: 84, y: 129 })

    expect(menu.popup).toHaveBeenCalledWith({ window, x: 84, y: 129 })
  })
})
