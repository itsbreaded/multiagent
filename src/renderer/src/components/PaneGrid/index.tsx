import React, { useState, useEffect } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import type { PaneNode, PaneLeaf, PaneSplit } from '../../../../shared/types'
import { usePanesStore } from '../../store/panes'
import { PaneContainer } from './PaneContainer'
import { PaneSplitDropTarget } from './PaneSplitDropTarget'

function renderNode(node: PaneNode, updateRatio: (splitId: string, ratio: number) => void): React.ReactNode {
  if (node.type === 'leaf') {
    const pane = node as PaneLeaf
    return (
      <PaneSplitDropTarget key={pane.id} pane={pane}>
        <PaneContainer pane={pane} />
      </PaneSplitDropTarget>
    )
  }

  const split = node as PaneSplit
  const isVertical = split.direction === 'vertical'

  return (
    <Allotment
      key={split.id}
      vertical={!isVertical}
      defaultSizes={[split.ratio * 100, (1 - split.ratio) * 100]}
      onChange={(sizes) => {
        const total = sizes[0] + sizes[1]
        if (total > 0) updateRatio(split.id, sizes[0] / total)
      }}
    >
      <Allotment.Pane>
        {renderNode(split.first, updateRatio)}
      </Allotment.Pane>
      <Allotment.Pane>
        {renderNode(split.second, updateRatio)}
      </Allotment.Pane>
    </Allotment>
  )
}

const DEFAULT_CWD = window.homeDir ?? (navigator.userAgent.includes('Windows') ? 'C:\\' : '/')

export function PaneGrid(): JSX.Element {
  const tabs = usePanesStore((s) => s.tabs)
  const activeTabId = usePanesStore((s) => s.activeTabId)
  const zoomedPaneId = usePanesStore((s) => s.zoomedPaneId)
  const updatePaneRatio = usePanesStore((s) => s.updatePaneRatio)
  const newSession = usePanesStore((s) => s.newSession)
  const addShellPane = usePanesStore((s) => s.addShellPane)
  const unzoom = usePanesStore((s) => s.unzoom)
  const findPane = usePanesStore((s) => s.findPane)

  const [isSashDragging, setIsSashDragging] = useState(false)

  useEffect(() => {
    const elements = document.querySelectorAll<HTMLElement>('.xterm-screen')
    elements.forEach((el) => { el.style.pointerEvents = isSashDragging ? 'none' : '' })
  }, [isSashDragging])

  const activeTab = tabs.find((t) => t.id === activeTabId)

  // Empty state: no tabs or active tab has no panes yet
  if (!activeTab || !activeTab.rootNode) {
    return (
      <div
        style={{
          flex: 1,
          backgroundColor: '#0e1011',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        <div style={{ textAlign: 'center', userSelect: 'none' }}>
          <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.2 }}>[]</div>
          <div style={{ fontSize: 14, color: '#4a4b4e', marginBottom: 16 }}>No sessions open</div>
          <button
            onClick={() => newSession(DEFAULT_CWD)}
            style={{
              display: 'block',
              width: '100%',
              marginBottom: 8,
              padding: '8px 20px',
              backgroundColor: '#1e2022',
              border: '1px solid #2a2b2e',
              borderRadius: 6,
              color: '#c9cdd1',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            + New Claude Session
          </button>
          <button
            onClick={() => addShellPane(DEFAULT_CWD)}
            style={{
              display: 'block',
              width: '100%',
              padding: '8px 20px',
              backgroundColor: 'transparent',
              border: '1px solid #2a2b2e',
              borderRadius: 6,
              color: '#6b7280',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Open Shell
          </button>
        </div>
      </div>
    )
  }

  // Zoomed pane view
  if (zoomedPaneId) {
    const zoomedPane = findPane(zoomedPaneId)
    if (zoomedPane) {
      return (
        <div
          style={{
            flex: 1,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
          }}
        >
          <button
            onClick={unzoom}
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              zIndex: 10,
              background: '#1e2022',
              border: '1px solid #2a2b2e',
              color: '#6b7280',
              borderRadius: 4,
              padding: '2px 8px',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            Unzoom
          </button>
          <PaneContainer pane={zoomedPane} />
        </div>
      )
    }
  }

  return (
    <div
      style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
      onMouseDownCapture={(e) => {
        const target = e.target as HTMLElement
        if (target.closest('[class*="sash-module_sash"]')) {
          setIsSashDragging(true)
          const onUp = (): void => {
            setIsSashDragging(false)
            window.removeEventListener('mouseup', onUp)
          }
          window.addEventListener('mouseup', onUp)
        }
      }}
    >
      {renderNode(activeTab.rootNode, updatePaneRatio)}
    </div>
  )
}
