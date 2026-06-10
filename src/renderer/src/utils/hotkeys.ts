// Single source of truth for all keyboard shortcuts.
// Consumers read display strings for tooltips/labels, and use matches() for handling.

export interface Hotkey {
  code: string    // KeyboardEvent.code (layout-independent physical key)
  shift: boolean
  label: string   // action description shown in settings
  display: string // human-readable key combo shown in tooltips and menus
}

export type HotkeyOverride = { code: string; shift: boolean }

export const DEFAULT_HOTKEYS = {
  newTab:          { code: 'KeyT',   shift: false, label: 'New tab',           display: 'Ctrl+T'           },
  closeTab:        { code: 'KeyW',   shift: false, label: 'Close tab',         display: 'Ctrl+W'           },
  splitVertical:   { code: 'KeyE',   shift: true,  label: 'Split vertical',    display: 'Ctrl+Shift+E'     },
  splitHorizontal: { code: 'KeyD',   shift: true,  label: 'Split horizontal',  display: 'Ctrl+Shift+D'     },
  closePane:       { code: 'KeyW',   shift: true,  label: 'Close pane',        display: 'Ctrl+Shift+W'     },
  zoomPane:        { code: 'Enter',  shift: true,  label: 'Zoom pane',         display: 'Ctrl+Shift+Enter' },
  toggleSidebar:   { code: 'KeyB',   shift: false, label: 'Toggle sidebar',    display: 'Ctrl+B'           },
  commandPalette:  { code: 'KeyP',   shift: true,  label: 'Command palette',   display: 'Ctrl+Shift+P'     },
  sessionBrowser:  { code: 'KeyO',   shift: true,  label: 'Session browser',   display: 'Ctrl+Shift+O'     },
} satisfies Record<string, Hotkey>

// Kept for consumers that don't need dynamic hotkeys
export const HOTKEYS = DEFAULT_HOTKEYS

export type HotkeyId = keyof typeof DEFAULT_HOTKEYS

export function codeToDisplayKey(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  return code
}

export function hotkeyDisplay(code: string, shift: boolean): string {
  const key = codeToDisplayKey(code)
  return shift ? `Ctrl+Shift+${key}` : `Ctrl+${key}`
}

export function buildHotkeys(overrides: Partial<Record<HotkeyId, HotkeyOverride>>): Record<HotkeyId, Hotkey> {
  const result: Record<string, Hotkey> = {}
  for (const [id, def] of Object.entries(DEFAULT_HOTKEYS) as [HotkeyId, Hotkey][]) {
    const override = overrides[id]
    if (override) {
      result[id] = { ...def, code: override.code, shift: override.shift, display: hotkeyDisplay(override.code, override.shift) }
    } else {
      result[id] = def
    }
  }
  return result as Record<HotkeyId, Hotkey>
}

export function matches(e: KeyboardEvent, hotkey: Hotkey): boolean {
  return (
    e.code === hotkey.code &&
    e.shiftKey === hotkey.shift &&
    (e.ctrlKey || e.metaKey)
  )
}

// Returns a lookup key for a hotkey — use with eventKey() to build O(1) dispatch tables.
export function hotkeyKey(h: { code: string; shift: boolean }): string {
  return `${h.code}:${h.shift}`
}

// Returns the lookup key for a keyboard event.
export function eventKey(e: KeyboardEvent): string {
  return `${e.code}:${e.shiftKey}`
}
