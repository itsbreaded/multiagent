// Single source of truth for all keyboard shortcuts.
// Consumers read display strings for tooltips/labels, and use matches() for handling.

export interface Hotkey {
  code: string    // KeyboardEvent.code (layout-independent physical key)
  shift: boolean
  display: string // Human-readable label shown in tooltips and menus
}

export const HOTKEYS = {
  newTab:          { code: 'KeyT',   shift: false, display: 'Ctrl+T'          },
  closeTab:        { code: 'KeyW',   shift: false, display: 'Ctrl+W'          },
  splitVertical:   { code: 'KeyE',   shift: true,  display: 'Ctrl+Shift+E'    },
  splitHorizontal: { code: 'KeyD',   shift: true,  display: 'Ctrl+Shift+D'    },
  closePane:       { code: 'KeyW',   shift: true,  display: 'Ctrl+Shift+W'    },
  zoomPane:        { code: 'Enter',  shift: true,  display: 'Ctrl+Shift+Enter' },
  toggleSidebar:   { code: 'KeyB',   shift: false, display: 'Ctrl+B'          },
  commandPalette:  { code: 'KeyP',   shift: true,  display: 'Ctrl+Shift+P'    },
  sessionBrowser:  { code: 'KeyO',   shift: true,  display: 'Ctrl+Shift+O'    },
} as const satisfies Record<string, Hotkey>

export function matches(e: KeyboardEvent, hotkey: Hotkey): boolean {
  return (
    e.code === hotkey.code &&
    e.shiftKey === hotkey.shift &&
    (e.ctrlKey || e.metaKey)
  )
}

// Returns a lookup key for a hotkey — use with eventKey() to build O(1) dispatch tables.
export function hotkeyKey(h: Hotkey): string {
  return `${h.code}:${h.shift}`
}

// Returns the lookup key for a keyboard event.
export function eventKey(e: KeyboardEvent): string {
  return `${e.code}:${e.shiftKey}`
}
