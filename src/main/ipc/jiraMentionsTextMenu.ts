export interface JiraMentionsTextMenuCapabilities {
  target: 'editable' | 'selection'
  canCut: boolean
  canCopy: boolean
  canPaste: boolean
  canSelectAll: boolean
}

export type JiraMentionsTextMenuItem =
  | { role: 'cut' | 'copy' | 'paste' | 'selectAll'; enabled: boolean }
  | { type: 'separator' }

export function buildJiraMentionsTextMenu(capabilities: JiraMentionsTextMenuCapabilities): JiraMentionsTextMenuItem[] {
  if (capabilities.target === 'selection') {
    return capabilities.canCopy ? [{ role: 'copy', enabled: true }] : []
  }

  return [
    { role: 'cut', enabled: capabilities.canCut },
    { role: 'copy', enabled: capabilities.canCopy },
    { role: 'paste', enabled: capabilities.canPaste },
    { type: 'separator' },
    { role: 'selectAll', enabled: capabilities.canSelectAll },
  ]
}

export interface NativeMenuPopup<TWindow> {
  popup(options: { window: TWindow; x: number; y: number }): void
}

export function popupJiraMentionsTextMenu<TWindow>(
  menu: NativeMenuPopup<TWindow>,
  window: TWindow,
  point: { x: number; y: number },
): void {
  menu.popup({ window, x: point.x, y: point.y })
}
