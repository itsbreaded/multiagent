import type { Tab } from '../../../shared/types'

/** Native drag payload for moving one sidebar tab section between windows. */
export const TAB_DRAG_MIME = 'application/x-multiagent-tab'

export interface TabDragPayload {
  tab: Tab
  ptyIds: string[]
  sourceWindowId: number
}

export function encodeTabDragPayload(payload: TabDragPayload): string {
  return JSON.stringify(payload)
}

export function setTabDragData(dataTransfer: DataTransfer, payload: TabDragPayload): void {
  dataTransfer.setData(TAB_DRAG_MIME, encodeTabDragPayload(payload))
  dataTransfer.effectAllowed = 'move'
}

export function decodeTabDragPayload(dataTransfer: DataTransfer): TabDragPayload | null {
  const raw = dataTransfer.getData(TAB_DRAG_MIME)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<TabDragPayload>
    if (
      !parsed ||
      !parsed.tab ||
      typeof parsed.tab.id !== 'string' ||
      !Array.isArray(parsed.ptyIds) ||
      !parsed.ptyIds.every((id) => typeof id === 'string') ||
      typeof parsed.sourceWindowId !== 'number' ||
      !Number.isFinite(parsed.sourceWindowId)
    ) return null
    return parsed as TabDragPayload
  } catch {
    return null
  }
}
