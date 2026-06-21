import React, { useState } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import type { AgentKind, PaneNode, PaneLeaf, PaneSplit } from '../../../../shared/types'
import { usePanesStore } from '../../store/panes'
import { PaneContainer } from './PaneContainer'
import { PaneSplitDropTarget } from './PaneSplitDropTarget'
import { DirPicker } from '../DirPicker'
import { agentLabel } from '../../utils/agents'
import { ShellIcon } from '../AgentIcon'

function renderNode(node: PaneNode, updateRatio: (splitId: string, ratio: number) => void, layoutPath = 'root'): React.ReactNode {
  if (node.type === 'leaf') {
    const pane = node as PaneLeaf
    return (
      <PaneSplitDropTarget key={pane.id} pane={pane}>
        <PaneContainer pane={pane} layoutKey={layoutPath} />
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
        {renderNode(split.first, updateRatio, `${layoutPath}/${split.id}:first`)}
      </Allotment.Pane>
      <Allotment.Pane>
        {renderNode(split.second, updateRatio, `${layoutPath}/${split.id}:second`)}
      </Allotment.Pane>
    </Allotment>
  )
}

const DEFAULT_CWD = window.homeDir ?? (navigator.userAgent.includes('Windows') ? 'C:\\' : '/')

export function PaneGrid(): JSX.Element {
  const tabs = usePanesStore((s) => s.tabs)
  const activeTabId = usePanesStore((s) => s.activeTabId)
  const hydratedTabIds = usePanesStore((s) => s.hydratedTabIds)
  const zoomedPaneId = usePanesStore((s) => s.zoomedPaneId)
  const updatePaneRatio = usePanesStore((s) => s.updatePaneRatio)
  const newSession = usePanesStore((s) => s.newSession)
  const addShellPane = usePanesStore((s) => s.addShellPane)
  const findPane = usePanesStore((s) => s.findPane)
  const draggedPaneId = usePanesStore((s) => s.draggedPaneId)
  const movePaneToTab = usePanesStore((s) => s.movePaneToTab)

  const [isSashDragging, setIsSashDragging] = useState(false)
  const [dirPickerFor, setDirPickerFor] = useState<AgentKind | 'shell' | null>(null)
  const [emptyDropActive, setEmptyDropActive] = useState(false)

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const activeTabHydrated = activeTabId ? hydratedTabIds[activeTabId] === true : false
  const cwdForNew = activeTab?.defaultCwd ?? DEFAULT_CWD
  const zoomedPane = zoomedPaneId ? findPane(zoomedPaneId) : null

  // Outer container is position:relative so all hydrated tab layers stack via position:absolute.
  // Restored inactive tabs are not mounted until first focus. Once hydrated, inactive tabs
  // stay mounted with visibility:hidden to preserve xterm scrollback and PTY/session state.
  return (
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', position: 'relative' }}>

      {/* Empty state — only when active tab has no panes */}
      {activeTab?.rootNode && !activeTabHydrated && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundColor: '#0e1011',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#4a4b4e',
            fontSize: 12,
          }}
        >
          Restoring session...
        </div>
      )}

      {(!activeTab || !activeTab.rootNode) && (
        <div
          onDragOver={(e) => {
            if (!draggedPaneId || !activeTab) return
            e.preventDefault()
            e.stopPropagation()
            setEmptyDropActive(true)
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setEmptyDropActive(false)
          }}
          onDrop={(e) => {
            if (!draggedPaneId || !activeTab) return
            e.preventDefault()
            e.stopPropagation()
            movePaneToTab(draggedPaneId, activeTab.id)
            setEmptyDropActive(false)
          }}
          style={{
            position: 'absolute',
            inset: 0,
            backgroundColor: emptyDropActive ? '#111815' : '#0e1011',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            outline: emptyDropActive ? '2px solid #4ade80' : 'none',
            outlineOffset: -2,
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
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  textAlign: 'left',
                }}
              >
                <ShellIcon size={16} />
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
                <ShellIcon size={16} />
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
      )}

      {/* Zoomed pane — overlays the active tab's normal grid when a pane is zoomed */}
      {activeTab?.rootNode && activeTabHydrated && zoomedPaneId && zoomedPane && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <PaneContainer pane={zoomedPane} layoutKey={`zoom:${zoomedPane.id}`} />
        </div>
      )}

      {/* All tab pane grids — active is visible, inactive are hidden but kept mounted.
          Keeping terminals mounted preserves xterm's scrollback buffer and avoids the
          scrollbar disappearing bug that occurs when xterm is disposed and recreated. */}
      {tabs.map((tab) => {
        if (!tab.rootNode) return null
        const isActive = tab.id === activeTabId
        const hydrated = hydratedTabIds[tab.id] === true
        if (!hydrated) return null
        // When active tab is zoomed, the normal grid is covered by the zoomed overlay above.
        // Skip rendering it so the zoomed pane isn't duplicated in the tree.
        if (isActive && zoomedPaneId && zoomedPane) return null

        return (
          <div
            key={tab.id}
            className={isActive && isSashDragging ? 'sash-dragging' : undefined}
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              visibility: isActive ? 'visible' : 'hidden',
              pointerEvents: isActive ? 'auto' : 'none',
            }}
            onMouseDownCapture={isActive ? (e) => {
              const target = e.target as HTMLElement
              if (target.closest('[class*="sash-module_sash"]')) {
                setIsSashDragging(true)
                const onUp = (): void => {
                  setIsSashDragging(false)
                  window.removeEventListener('mouseup', onUp)
                }
                window.addEventListener('mouseup', onUp)
              }
            } : undefined}
          >
            {renderNode(tab.rootNode, updatePaneRatio)}
          </div>
        )
      })}
    </div>
  )
}
