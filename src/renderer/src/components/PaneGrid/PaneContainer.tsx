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
  const focusedPaneId = usePanesStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.focusedPaneId ?? ''
  })
  const focusPane = usePanesStore((s) => s.focusPane)
  const isFocused = focusedPaneId === pane.id

  return (
    <div
      onClick={() => { console.log('[T]', 'click', pane.id.slice(0, 8)); focusPane(pane.id) }}
      style={{
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
    </div>
  )
}
