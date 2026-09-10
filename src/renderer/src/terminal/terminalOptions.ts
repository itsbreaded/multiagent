import type { PaneType } from '../../../shared/types'

/**
 * Agent TUIs repaint their inline viewport with ED2. Letting xterm move erased
 * rows into scrollback turns that repaint into extra history work. Normal line
 * scrolling remains enabled when this is false.
 */
export function scrollOnEraseInDisplayForPane(paneType: PaneType): boolean {
  return paneType !== 'agent'
}
