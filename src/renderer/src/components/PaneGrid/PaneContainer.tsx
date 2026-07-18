import React from 'react'
import type { PaneLeaf } from '../../../../shared/types'
import { usePanesStore } from '../../store/panes'
import { PaneHeader } from '../PaneHeader'
import { Terminal } from '../Terminal'

interface PaneContainerProps {
  pane: PaneLeaf
  layoutKey: string
}

export function PaneContainer({ pane, layoutKey }: PaneContainerProps): JSX.Element {
  const isFocused = usePanesStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.focusedPaneId === pane.id
  })
  const focusPane = usePanesStore((s) => s.focusPane)
  const isSwapTarget = usePanesStore((s) => s.swapDrag?.targetId === pane.id)

  return (
    <div
      data-pane-id={pane.id}
      onMouseDown={(e) => { if (e.button === 0) focusPane(pane.id) }}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
        outline: isFocused ? '1px solid #4ade8033' : 'none',
      }}
    >
      <PaneHeader pane={pane} isFocused={isFocused} />
      <Terminal pane={pane} layoutKey={layoutKey} />
      {isSwapTarget && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            backgroundColor: 'rgba(74, 222, 128, 0.12)',
            border: '2px solid #4ade80',
            zIndex: 60,
          }}
        />
      )}
    </div>
  )
}
