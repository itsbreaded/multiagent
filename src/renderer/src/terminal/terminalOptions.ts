import type { AgentKind, PaneType } from '../../../shared/types'

/**
 * Agent TUIs repaint their inline viewport with ED2. Letting xterm move erased
 * rows into scrollback turns that repaint into extra history work. Normal line
 * scrolling remains enabled when this is false.
 */
export function scrollOnEraseInDisplayForPane(paneType: PaneType): boolean {
  return paneType !== 'agent'
}

/**
 * Codex's fullscreen transcript enables terminal mouse reporting. Keep normal
 * selection and the host context menu available for an unmodified mouse
 * gesture; Codex can still receive mouse events when Alt is held.
 */
export function mouseEventsRequireAltForPane(paneType: PaneType, agentKind?: AgentKind): boolean {
  return paneType === 'agent' && agentKind === 'codex'
}
