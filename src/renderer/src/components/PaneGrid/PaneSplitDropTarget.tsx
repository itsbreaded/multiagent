import React, { useState } from 'react'
import type { PaneLeaf, SplitDirection } from '../../../../shared/types'
import { usePanesStore } from '../../store/panes'
import { decodePaneDragPayload, PANE_DRAG_MIME } from '../../utils/paneDrag'

type DropZone = 'up' | 'down' | 'left' | 'right' | null

function zoneStyle(zone: DropZone): React.CSSProperties {
  switch (zone) {
    case 'up':    return { top: 0,   left: 0,   width: '100%', height: '50%' }
    case 'down':  return { bottom: 0, left: 0,  width: '100%', height: '50%' }
    case 'left':  return { top: 0,   left: 0,   width: '50%',  height: '100%' }
    case 'right': return { top: 0,   right: 0,  width: '50%',  height: '100%' }
    default:      return {}
  }
}

function computeZone(e: React.DragEvent<HTMLDivElement>): DropZone {
  const rect = e.currentTarget.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  const w3 = rect.width / 3
  const h3 = rect.height / 3
  if (x < w3) return 'left'
  if (x > w3 * 2) return 'right'
  if (y < h3) return 'up'
  if (y > h3 * 2) return 'down'
  return null
}

interface Props {
  pane: PaneLeaf
  children?: React.ReactNode
  overlayMode?: boolean
  targetWindowId?: number
}

export function PaneSplitDropTarget({ pane, children, overlayMode, targetWindowId }: Props): JSX.Element {
  const draggedPaneId = usePanesStore((s) => s.draggedPaneId)
  const paneDragActive = usePanesStore((s) => s.paneDragActive)
  const movePaneToSplit = usePanesStore((s) => s.movePaneToSplit)
  const windowId = usePanesStore((s) => s.windowId)
  const [dropZone, setDropZone] = useState<DropZone>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  const isDropTarget = (draggedPaneId !== null && draggedPaneId !== pane.id) || isDragOver

  function onDragEnter(e: React.DragEvent<HTMLDivElement>): void {
    if (e.dataTransfer.types.includes(PANE_DRAG_MIME)) setIsDragOver(true)
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>): void {
    if (!isDropTarget) return
    e.preventDefault()
    e.stopPropagation()
    setDropZone(computeZone(e))
  }

  function onDragLeave(e: React.DragEvent<HTMLDivElement>): void {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropZone(null)
      setIsDragOver(false)
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>): void {
    if (!isDropTarget) return
    e.preventDefault()
    e.stopPropagation()
    const zone = computeZone(e)
    setDropZone(null)
    setIsDragOver(false)
    if (!zone) return

    const direction: SplitDirection = zone === 'left' || zone === 'right' ? 'vertical' : 'horizontal'
    const sourceBefore = zone === 'left' || zone === 'up'

    const payload = decodePaneDragPayload(e.dataTransfer)
    const tgtWin = targetWindowId ?? windowId

    // Self-drop is a no-op. The local movePaneToSplit guards this, but the cross-window IPC path
    // does not — and for a cross-window drag onto the pane's OWN row, isDropTarget does not exclude
    // it (draggedPaneId is null, isDragOver is true). Without this guard the split-transfer removes
    // the source pane after a no-op insert and the pane is lost.
    const sourcePaneId = payload?.pane.id ?? draggedPaneId
    if (sourcePaneId === pane.id) return

    if (payload && (payload.sourceWindowId !== windowId || tgtWin !== windowId)) {
      // Cross-window: delegate to main via pane:split-transfer
      if (tgtWin !== null) {
        window.ipc?.invoke('pane:split-transfer', {
          ...payload,
          targetPaneId: pane.id,
          direction,
          sourceBefore,
          targetWindowId: tgtWin,
        }).catch(console.error)
      }
    } else if (draggedPaneId) {
      // Same-window: use local store action
      movePaneToSplit(draggedPaneId, pane.id, direction, sourceBefore)
    } else if (payload) {
      // Same-window drag with payload (cross-tab)
      movePaneToSplit(payload.pane.id, pane.id, direction, sourceBefore)
    }
  }

  // In overlay mode the target sits on top of clickable row content, so it must be click-through
  // (pointerEvents:none) when idle. Enable it whenever a pane drag is active in this window —
  // including cross-window drags where draggedPaneId is null — so onDragEnter can fire and the
  // directional zones appear. (Gating only on isDropTarget deadlocks cross-window: none → no
  // dragenter → isDragOver never set → stays none.)
  const overlayInteractive = isDropTarget || paneDragActive
  const outerStyle: React.CSSProperties = overlayMode
    ? { position: 'absolute', inset: 0, pointerEvents: overlayInteractive ? 'auto' : 'none' }
    : { position: 'relative', height: '100%', width: '100%', minHeight: 0, minWidth: 0, overflow: 'hidden' }

  return (
    <div
      style={outerStyle}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}
      {isDropTarget && dropZone && (
        <div
          style={{
            position: 'absolute',
            pointerEvents: 'none',
            backgroundColor: 'rgba(74, 222, 128, 0.12)',
            border: '2px solid #4ade80',
            zIndex: 50,
            ...zoneStyle(dropZone),
          }}
        />
      )}
    </div>
  )
}
