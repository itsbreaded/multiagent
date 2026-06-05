import React, { useState, useRef, useEffect } from 'react'
import { usePanesStore } from '../../store/panes'
import { useSessionsStore } from '../../store/sessions'
import type { PaneLeaf } from '../../../../shared/types'
import { computeLabels, collectLeaves, paneLabelText } from '../../utils/tabLabels'

export function OpenTabs(): JSX.Element {
  const tabs = usePanesStore((s) => s.tabs)
  const activeTabId = usePanesStore((s) => s.activeTabId)
  const focusedPaneId = usePanesStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.focusedPaneId)
  const setActiveTab = usePanesStore((s) => s.setActiveTab)
  const focusPane = usePanesStore((s) => s.focusPane)
  const renameTab = usePanesStore((s) => s.renameTab)
  const setPaneCustomName = usePanesStore((s) => s.setPaneCustomName)
  const sessions = useSessionsStore((s) => s.sessions)

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renamingPaneId, setRenamingPaneId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const tabInputRef = useRef<HTMLInputElement>(null)
  const paneInputRef = useRef<HTMLInputElement>(null)

  const tabLabels = computeLabels(tabs, sessions)

  // Cancel any active pane rename when the focused pane changes externally
  // (e.g. user clicks in the terminal rather than through the sidebar).
  useEffect(() => {
    if (renamingPaneId && renamingPaneId !== focusedPaneId) {
      setRenamingPaneId(null)
    }
  }, [focusedPaneId, renamingPaneId])

  useEffect(() => {
    if (renamingTabId) tabInputRef.current?.select()
  }, [renamingTabId])

  useEffect(() => {
    if (renamingPaneId) paneInputRef.current?.select()
  }, [renamingPaneId])

  function toggleCollapse(tabId: string, e: React.MouseEvent): void {
    e.stopPropagation()
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(tabId)) next.delete(tabId)
      else next.add(tabId)
      return next
    })
  }

  function startTabRename(tabId: string, e: React.MouseEvent): void {
    e.stopPropagation()
    setRenamingPaneId(null)
    setRenameValue(tabLabels.get(tabId) ?? '')
    setRenamingTabId(tabId)
  }

  function commitTabRename(): void {
    if (renamingTabId) renameTab(renamingTabId, renameValue)
    setRenamingTabId(null)
  }

  function startPaneRename(pane: PaneLeaf, e: React.MouseEvent): void {
    e.stopPropagation()
    setRenamingTabId(null)
    setRenameValue(pane.customName ?? '')
    setRenamingPaneId(pane.id)
  }

  function commitPaneRename(): void {
    if (renamingPaneId) setPaneCustomName(renamingPaneId, renameValue)
    setRenamingPaneId(null)
  }

  return (
    <>
      {tabs.map((tab) => {
        const label = tabLabels.get(tab.id) ?? 'Shell'
        const leaves = collectLeaves(tab.rootNode)
        const isActive = tab.id === activeTabId
        const isCollapsed = collapsed.has(tab.id)
        const isRenamingTab = renamingTabId === tab.id

        return (
          <div key={tab.id}>
            {/* Tab header row */}
            <div
              onClick={() => setActiveTab(tab.id)}
              onDoubleClick={(e) => startTabRename(tab.id, e)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 10px 4px 6px',
                cursor: 'pointer',
                backgroundColor: isActive ? '#1e2022' : 'transparent',
                borderLeft: `2px solid ${isActive ? '#4ade80' : 'transparent'}`,
                userSelect: 'none',
              }}
            >
              {/* Collapse toggle */}
              <span
                onClick={(e) => toggleCollapse(tab.id, e)}
                style={{
                  fontSize: 13,
                  color: '#6b7280',
                  flexShrink: 0,
                  width: 18,
                  height: 18,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transform: isCollapsed ? 'rotate(-90deg)' : 'none',
                  transition: 'transform 0.15s',
                  borderRadius: 3,
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#c9cdd1' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#6b7280' }}
              >
                ▾
              </span>

              {isRenamingTab ? (
                <input
                  ref={tabInputRef}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={commitTabRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitTabRename() }
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenamingTabId(null) }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    flex: 1,
                    background: '#141517',
                    border: '1px solid #4ade80',
                    borderRadius: 3,
                    color: '#c9cdd1',
                    fontSize: 12,
                    padding: '1px 4px',
                    outline: 'none',
                    width: '100%',
                  }}
                />
              ) : (
                <span
                  style={{
                    flex: 1,
                    fontSize: 12,
                    fontWeight: isActive ? 500 : 400,
                    color: isActive ? '#c9cdd1' : '#6b7280',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {label}
                </span>
              )}
            </div>

            {/* Pane rows — hidden when collapsed */}
            {!isCollapsed && leaves.map((pane) => {
              const isClaude = pane.paneType === 'claude'
              const isFocused = isActive && pane.id === tab.focusedPaneId
              const isRenamingPane = renamingPaneId === pane.id
              const name = paneLabelText(pane, sessions)

              return (
                <PaneRow
                  key={pane.id}
                  pane={pane}
                  isClaude={isClaude}
                  isFocused={isFocused}
                  isRenaming={isRenamingPane}
                  name={name}
                  renameValue={renameValue}
                  renameInputRef={paneInputRef}
                  onRenameChange={(v) => setRenameValue(v)}
                  onRenameCommit={commitPaneRename}
                  onRenameCancel={() => setRenamingPaneId(null)}
                  onClick={() => { setActiveTab(tab.id); focusPane(pane.id) }}
                  onDoubleClick={(e) => {
                    setActiveTab(tab.id)
                    focusPane(pane.id)
                    startPaneRename(pane, e)
                  }}
                />
              )
            })}
          </div>
        )
      })}
    </>
  )
}

function PaneRow({
  pane,
  isClaude,
  isFocused,
  isRenaming,
  name,
  renameValue,
  renameInputRef,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onClick,
  onDoubleClick,
}: {
  pane: PaneLeaf
  isClaude: boolean
  isFocused: boolean
  isRenaming: boolean
  name: string
  renameValue: string
  renameInputRef: React.RefObject<HTMLInputElement>
  onRenameChange: (v: string) => void
  onRenameCommit: () => void
  onRenameCancel: () => void
  onClick: () => void
  onDoubleClick: (e: React.MouseEvent) => void
}): JSX.Element {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={isRenaming ? undefined : pane.cwd}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 10px 2px 24px',
        cursor: 'pointer',
        backgroundColor: isFocused ? '#242528' : hovered ? '#1a1b20' : 'transparent',
        transition: 'background-color 0.08s',
      }}
    >
      {isClaude ? (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            backgroundColor: '#4ade80',
            flexShrink: 0,
            display: 'inline-block',
          }}
        />
      ) : (
        <span
          style={{
            fontFamily: 'monospace',
            fontSize: 10,
            color: '#4a5568',
            flexShrink: 0,
            lineHeight: 1,
            width: 6,
            textAlign: 'center',
          }}
        >
          $
        </span>
      )}

      {isRenaming ? (
        <input
          ref={renameInputRef}
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={onRenameCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); onRenameCommit() }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onRenameCancel() }
          }}
          onClick={(e) => e.stopPropagation()}
          placeholder="Label (optional)"
          style={{
            flex: 1,
            background: '#141517',
            border: '1px solid #4ade80',
            borderRadius: 3,
            color: '#c9cdd1',
            fontSize: 11,
            padding: '1px 4px',
            outline: 'none',
            minWidth: 0,
          }}
        />
      ) : (
        <span
          style={{
            fontSize: 11,
            color: isFocused ? '#c9cdd1' : '#6b7280',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </span>
      )}
    </div>
  )
}
