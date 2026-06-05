import React from 'react'
import type { PaneLeaf } from '../../../../shared/types'
import { usePanesStore } from '../../store/panes'
import { PaneHeader } from '../PaneHeader'
import { Terminal } from '../Terminal'

interface PaneContainerProps {
  pane: PaneLeaf
}

export function PaneContainer({ pane }: PaneContainerProps): JSX.Element {
  const focusedPaneId = usePanesStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.focusedPaneId ?? ''
  })
  const focusPane = usePanesStore((s) => s.focusPane)
  const isFocused = focusedPaneId === pane.id

  return (
    <div
      onClick={() => focusPane(pane.id)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        overflow: 'hidden',
        outline: isFocused ? '1px solid #4ade8033' : 'none',
      }}
    >
      <PaneHeader pane={pane} isFocused={isFocused} />
      <Terminal pane={pane} />
    </div>
  )
}
