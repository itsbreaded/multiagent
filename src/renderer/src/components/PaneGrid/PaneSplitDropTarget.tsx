import React, { useState } from 'react'
import type { PaneLeaf, SplitDirection } from '../../../../shared/types'
import { usePanesStore } from '../../store/panes'

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
  children: React.ReactNode
}

export function PaneSplitDropTarget({ pane, children }: Props): JSX.Element {
  const draggedPaneId = usePanesStore((s) => s.draggedPaneId)
  const movePaneToSplit = usePanesStore((s) => s.movePaneToSplit)
  const [dropZone, setDropZone] = useState<DropZone>(null)

  const isDropTarget = draggedPaneId !== null && draggedPaneId !== pane.id

  function onDragOver(e: React.DragEvent<HTMLDivElement>): void {
    if (!isDropTarget) return
    e.preventDefault()
    e.stopPropagation()
    setDropZone(computeZone(e))
  }

  function onDragLeave(e: React.DragEvent<HTMLDivElement>): void {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropZone(null)
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>): void {
    if (!isDropTarget || !draggedPaneId) return
    e.preventDefault()
    e.stopPropagation()
    const zone = computeZone(e)
    if (zone) {
      const direction: SplitDirection = zone === 'left' || zone === 'right' ? 'vertical' : 'horizontal'
      const sourceBefore = zone === 'left' || zone === 'up'
      movePaneToSplit(draggedPaneId, pane.id, direction, sourceBefore)
    }
    setDropZone(null)
  }

  return (
    <div
      style={{ position: 'relative', height: '100%', width: '100%' }}
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
