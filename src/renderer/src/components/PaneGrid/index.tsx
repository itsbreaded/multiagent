import React, { useState } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import type { AgentKind, PaneNode, PaneLeaf, PaneSplit } from '../../../../shared/types'
import { usePanesStore } from '../../store/panes'
import { PaneContainer } from './PaneContainer'
import { PaneSplitDropTarget } from './PaneSplitDropTarget'
import { DirPicker } from '../DirPicker'
import { agentLabel } from '../../utils/agents'

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
  const lastAgentKind = usePanesStore((s) => s.lastAgentKind)
  const unzoom = usePanesStore((s) => s.unzoom)
  const findPane = usePanesStore((s) => s.findPane)

  const [isSashDragging, setIsSashDragging] = useState(false)
  const [dirPickerFor, setDirPickerFor] = useState<AgentKind | 'shell' | null>(null)

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const cwdForNew = activeTab?.defaultCwd ?? DEFAULT_CWD

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

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 8, width: 300 }}>
            <button
              onClick={() => newSession(cwdForNew, 'vertical', 'claude')}
              style={{
                flex: 1,
                padding: '7px 14px',
                backgroundColor: 'transparent',
                border: '1px solid #2a2b2e',
                borderRadius: 6,
                color: '#6b7280',
                fontSize: 12,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              Claude Code
            </button>
            <button
              onClick={() => newSession(cwdForNew, 'vertical', 'codex')}
              style={{
                flex: 1,
                padding: '7px 14px',
                backgroundColor: 'transparent',
                border: '1px solid #2a2b2e',
                borderRadius: 6,
                color: '#6b7280',
                fontSize: 12,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              Codex CLI
            </button>
            <button
              onClick={() => setDirPickerFor('claude')}
              style={{
                flex: 1,
                padding: '7px 14px',
                backgroundColor: 'transparent',
                border: '1px solid #2a2b2e',
                borderRadius: 6,
                color: '#6b7280',
                fontSize: 12,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              Claude in...
            </button>
            <button
              onClick={() => setDirPickerFor('codex')}
              style={{
                flex: 1,
                padding: '7px 14px',
                backgroundColor: 'transparent',
                border: '1px solid #2a2b2e',
                borderRadius: 6,
                color: '#6b7280',
                fontSize: 12,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              Codex in...
            </button>
          </div>

          {/* Open Shell row */}
          <div style={{ display: 'flex', gap: 4, width: 300 }}>
            <button
              onClick={() => addShellPane(cwdForNew)}
              style={{
                flex: 1,
                padding: '8px 20px',
                backgroundColor: 'transparent',
                border: '1px solid #2a2b2e',
                borderRadius: 6,
                color: '#6b7280',
                fontSize: 13,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              Open Shell
            </button>
            <button
              onClick={() => setDirPickerFor('shell')}
              title="Start shell in a different directory"
              style={{
                padding: '8px 10px',
                backgroundColor: 'transparent',
                border: '1px solid #2a2b2e',
                borderRadius: 6,
                color: '#4a4b4e',
                fontSize: 12,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#6b7280' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#4a4b4e' }}
            >
              ...
            </button>
          </div>

          {/* Optional hint when tab has a default dir */}
          {activeTab?.defaultCwd && (
            <div style={{ marginTop: 10, fontSize: 11, color: '#3a3b3e' }}>
              default: {activeTab.defaultCwd}
            </div>
          )}
        </div>

        {dirPickerFor && (
          <DirPicker
            title={dirPickerFor === 'shell' ? 'Start shell in...' : `Start ${agentLabel(dirPickerFor)} session in...`}
            initial={cwdForNew}
            confirmLabel="Start"
            skipLabel="Cancel"
            onConfirm={(dir) => {
              if (dirPickerFor !== 'shell') newSession(dir, 'vertical', dirPickerFor)
              else addShellPane(dir)
              setDirPickerFor(null)
            }}
            onSkip={() => setDirPickerFor(null)}
          />
        )}
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
            minHeight: 0,
            minWidth: 0,
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
      className={isSashDragging ? 'sash-dragging' : undefined}
      style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
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
