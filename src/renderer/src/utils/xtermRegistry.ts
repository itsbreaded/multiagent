import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

export interface TerminalEntry {
  xterm: XTerm
  fitAddon: FitAddon
  wrapper: HTMLDivElement
  opened: boolean
  // Set to true once the PTY data subscription is active.
  // Used to skip the "connecting" overlay on remounts caused by layout changes.
  connected: boolean
}

const registry = new Map<string, TerminalEntry>()
let offscreen: HTMLDivElement | null = null

// A tiny off-screen container that holds xterm wrappers while their React
// component is unmounted (e.g. during pane drag-drop tree restructuring).
// Keeping the wrapper in the DOM prevents xterm from losing its canvas/buffer.
function getOffscreen(): HTMLDivElement {
  if (!offscreen) {
    offscreen = document.createElement('div')
    offscreen.style.cssText =
      'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;overflow:hidden;pointer-events:none;opacity:0'
    document.body.appendChild(offscreen)
  }
  return offscreen
}

export function getEntry(paneId: string): TerminalEntry | undefined {
  return registry.get(paneId)
}

/** Get the existing entry for paneId, or create one via factory and open xterm into a wrapper div. */
export function getOrCreate(
  paneId: string,
  factory: () => { xterm: XTerm; fitAddon: FitAddon },
): TerminalEntry {
  const existing = registry.get(paneId)
  if (existing) return existing

  const { xterm, fitAddon } = factory()
  const wrapper = document.createElement('div')
  wrapper.style.cssText = 'position:absolute;inset:0'
  getOffscreen().appendChild(wrapper)

  const entry: TerminalEntry = { xterm, fitAddon, wrapper, opened: false, connected: false }
  registry.set(paneId, entry)
  return entry
}

/** Move the xterm wrapper from off-screen into the given container element. */
export function attach(paneId: string, container: HTMLElement): void {
  const entry = registry.get(paneId)
  if (!entry) return
  container.appendChild(entry.wrapper)
  if (!entry.opened) {
    entry.xterm.open(entry.wrapper)
    entry.opened = true
  }
}

/** Move the xterm wrapper back to the off-screen holder without disposing it. */
export function detach(paneId: string): void {
  const entry = registry.get(paneId)
  if (!entry) return
  getOffscreen().appendChild(entry.wrapper)
}

/** Record that this terminal has an active PTY connection. */
export function markConnected(paneId: string): void {
  const entry = registry.get(paneId)
  if (entry) entry.connected = true
}

/** Focus the xterm input for a pane if its terminal has mounted. */
export function focus(paneId: string): boolean {
  const entry = registry.get(paneId)
  if (!entry?.opened) return false
  try {
    entry.xterm.focus()
    return true
  } catch {
    return false
  }
}

/** Apply a scrollback limit to every existing xterm instance. */
export function setScrollbackLines(lines: number): void {
  for (const entry of registry.values()) {
    entry.xterm.options.scrollback = lines
  }
}

/** Permanently dispose the xterm instance and remove it from the registry. */
export function dispose(paneId: string): void {
  const entry = registry.get(paneId)
  if (!entry) return
  registry.delete(paneId)
  try { entry.xterm.dispose() } catch { /* ignore */ }
  entry.wrapper.remove()
}
