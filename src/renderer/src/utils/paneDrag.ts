import type { PaneLeaf } from '../../../shared/types'

export const PANE_DRAG_MIME = 'application/x-multiagent-pane'

export interface PaneDragPayload {
  pane: PaneLeaf
  sourceTabId: string
  sourceWindowId: number
}

export function encodePaneDragPayload(payload: PaneDragPayload): string {
  return JSON.stringify(payload)
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
