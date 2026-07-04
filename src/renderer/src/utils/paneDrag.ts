import type React from 'react'
import type { PaneLeaf, Tab } from '../../../shared/types'

export const PANE_DRAG_MIME = 'application/x-multiagent-pane'
export const TAB_DRAG_MIME = 'application/x-multiagent-tab'
const PANE_DRAG_SOURCE_MIME_PREFIX = 'application/x-multiagent-pane-source-'

export interface PaneDragPayload {
  pane: PaneLeaf
  sourceTabId: string
  sourceWindowId: number
}

export function encodePaneDragPayload(payload: PaneDragPayload): string {
  return JSON.stringify(payload)
}

export function absorbDroppedTab(
  e: React.DragEvent,
  windowId: number | null,
  deps: { receiveTab: (tab: Tab, atIndex?: number) => void; removeTabLocally: (tabId: string) => void },
  dropIndex?: number,
): boolean {
  const raw = e.dataTransfer.getData(TAB_DRAG_MIME)
  if (!raw) return false
  try {
    const { tab, ptyIds, sourceWindowId } = JSON.parse(raw) as { tab: Tab; ptyIds: string[]; sourceWindowId: number | null }
    if (!tab || sourceWindowId === windowId) return false
    e.preventDefault(); e.stopPropagation()
    deps.receiveTab(tab, dropIndex)
    void window.ipc.invoke('tab:absorb', JSON.stringify(tab), ptyIds, sourceWindowId ?? -1)
      .then((ok) => { if (!ok) deps.removeTabLocally(tab.id) })
      .catch((err) => { console.error('tab:absorb failed', err); deps.removeTabLocally(tab.id) })
    return true
  } catch { return false }
}

export function transferDroppedPane(
  e: React.DragEvent,
  targetTabId: string,
  windowId: number | null,
  deps: { movePaneToTab: (paneId: string, tabId: string) => void },
): boolean {
  const payload = decodePaneDragPayload(e.dataTransfer)
  if (!payload || windowId === null) return false
  e.preventDefault(); e.stopPropagation()
  if (payload.sourceWindowId === windowId) deps.movePaneToTab(payload.pane.id, targetTabId)
  else void window.ipc.invoke('pane:transfer', { ...payload, targetTabId, targetWindowId: windowId })
    .catch((err) => { console.error('pane:transfer failed', err) })
  return true
}

export function setPaneDragData(dataTransfer: DataTransfer, payload: PaneDragPayload): void {
  dataTransfer.setData('text/plain', payload.pane.id)
  dataTransfer.setData(PANE_DRAG_MIME, encodePaneDragPayload(payload))
  dataTransfer.setData(`${PANE_DRAG_SOURCE_MIME_PREFIX}${payload.pane.id}`, '1')
}

export function paneDragSourceId(dataTransfer: DataTransfer): string | null {
  const sourceType = Array.from(dataTransfer.types).find((type) => type.startsWith(PANE_DRAG_SOURCE_MIME_PREFIX))
  if (!sourceType) return null
  return sourceType.slice(PANE_DRAG_SOURCE_MIME_PREFIX.length) || null
}

export function decodePaneDragPayload(dataTransfer: DataTransfer): PaneDragPayload | null {
  const raw = dataTransfer.getData(PANE_DRAG_MIME)
  if (!raw) return null
  try {
    const payload = JSON.parse(raw) as Partial<PaneDragPayload>
    if (
      !payload ||
      !payload.pane ||
      payload.pane.type !== 'leaf' ||
      typeof payload.sourceTabId !== 'string' ||
      typeof payload.sourceWindowId !== 'number'
    ) return null
    return payload as PaneDragPayload
  } catch {
    return null
  }
}
