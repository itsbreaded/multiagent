import type { PaneLeaf } from '../../../shared/types'

export const PANE_DRAG_MIME = 'application/x-multiagent-pane'
const PANE_DRAG_SOURCE_MIME_PREFIX = 'application/x-multiagent-pane-source-'

export interface PaneDragPayload {
  pane: PaneLeaf
  sourceTabId: string
  sourceWindowId: number
}

export function encodePaneDragPayload(payload: PaneDragPayload): string {
  return JSON.stringify(payload)
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
