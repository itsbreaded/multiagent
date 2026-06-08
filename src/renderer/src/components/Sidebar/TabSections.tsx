import React, { useState } from 'react'
import type { PaneLeaf, Session, Tab } from '../../../../shared/types'
import { usePanesStore } from '../../store/panes'
import { useSessionsStore } from '../../store/sessions'
import { SidebarSection } from './SidebarSection'
import { computeLabels, collectLeaves, paneLabelText } from '../../utils/tabLabels'
import { DirPicker } from '../DirPicker'

export function TabSections(): JSX.Element {
  const tabs = usePanesStore((s) => s.tabs)
  const activeTabId = usePanesStore((s) => s.activeTabId)
  const sessions = useSessionsStore((s) => s.sessions)
  const closeTab = usePanesStore((s) => s.closeTab)
  const renameTab = usePanesStore((s) => s.renameTab)
  const setTabDefaultCwd = usePanesStore((s) => s.setTabDefaultCwd)

  const tabLabels = computeLabels(tabs, sessions)

  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const [dirPickerTabId, setDirPickerTabId] = useState<string | null>(null)
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const dirPickerTab = dirPickerTabId ? tabs.find((t) => t.id === dirPickerTabId) : null

  function startRename(tabId: string) {
    setRenameValue(tabLabels.get(tabId) ?? '')
    setRenamingTabId(tabId)
  }

  function commitRename() {
    if (renamingTabId) renameTab(renamingTabId, renameValue)
    setRenamingTabId(null)
  }

  if (tabs.length === 0) return <></>

  return (
    <>
      {tabs.map((tab) => {
        const label = tabLabels.get(tab.id) ?? 'Tab'
        const leaves = tab.rootNode ? collectLeaves(tab.rootNode) : []
        const isActive = tab.id === activeTabId
        const isRenaming = renamingTabId === tab.id

        return (
          <SidebarSection
            key={tab.id}
            title={label}
            count={leaves.length > 1 ? leaves.length : undefined}
            defaultOpen={isActive}
            onContextMenu={(e) => {
              e.preventDefault()
              setTabMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
            }}
            renaming={isRenaming}
            renameValue={isRenaming ? renameValue : undefined}
            onRenameChange={setRenameValue}
            onRenameCommit={commitRename}
            onRenameCancel={() => setRenamingTabId(null)}
          >
            {leaves.map((pane) => (
              <PaneRow
                key={pane.id}
                pane={pane}
                tab={tab}
                isFocused={isActive && pane.id === tab.focusedPaneId}
                sessions={sessions}
              />
            ))}
          </SidebarSection>
        )
      })}

      {tabMenu && (
        <TabContextMenu
          tabId={tabMenu.tabId}
          tabs={tabs}
          x={tabMenu.x}
          y={tabMenu.y}
          onClose={() => setTabMenu(null)}
          onRename={(id) => { startRename(id); setTabMenu(null) }}
          onCloseTab={(id) => { closeTab(id); setTabMenu(null) }}
          onChangeDefaultDir={(id) => { setDirPickerTabId(id); setTabMenu(null) }}
        />
      )}

      {dirPickerTabId && (
        <DirPicker
          title="Change default directory"
          description="New sessions and shells in this tab will start here by default."
          initial={dirPickerTab?.defaultCwd ?? ''}
          confirmLabel="Change"
          skipLabel="Cancel"
          onConfirm={(dir) => { setTabDefaultCwd(dirPickerTabId, dir); setDirPickerTabId(null) }}
          onSkip={() => setDirPickerTabId(null)}
        />
      )}
    </>
  )
}

// --- Pane row ---

function PaneRow({
  pane,
  tab,
  isFocused,
  sessions,
}: {
  pane: PaneLeaf
  tab: Tab
  isFocused: boolean
  sessions: Session[]
}): JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = React.useRef<HTMLInputElement>(null)

  const setActiveTab = usePanesStore((s) => s.setActiveTab)
  const focusPane = usePanesStore((s) => s.focusPane)
  const closePane = usePanesStore((s) => s.closePane)
  const movePaneToNewTab = usePanesStore((s) => s.movePaneToNewTab)
  const setPaneCustomName = usePanesStore((s) => s.setPaneCustomName)

  const name = paneLabelText(pane, sessions)
  const isOnlyPane = !tab.rootNode || collectLeaves(tab.rootNode).length <= 1

  React.useEffect(() => {
    if (renaming) renameInputRef.current?.select()
  }, [renaming])

  function startRename() {
    setRenameValue(pane.customName ?? '')
    setRenaming(true)
  }

  function commitRename() {
    setPaneCustomName(pane.id, renameValue)
    setRenaming(false)
  }

  return (
    <>
      <div
        onClick={() => { if (!renaming) { setActiveTab(tab.id); focusPane(pane.id) } }}
        onDoubleClick={() => startRename()}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }) }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={renaming ? undefined : pane.cwd}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 12px 5px 16px',
          margin: '1px 4px',
          borderRadius: 4,
          cursor: renaming ? 'default' : 'pointer',
          backgroundColor: isFocused ? '#242528' : hovered ? '#1e2022' : 'transparent',
          transition: 'background-color 0.1s',
        }}
      >
        {pane.paneType === 'claude' ? (
          <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: '#4ade80', flexShrink: 0, display: 'inline-block' }} />
        ) : (
          <span style={{ width: 8, height: 8, borderRadius: '50%', border: '1.5px solid #6b7280', flexShrink: 0, display: 'inline-block', opacity: 0.8 }} />
        )}
        {renaming ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitRename() }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenaming(false) }
            }}
            onClick={(e) => e.stopPropagation()}
            placeholder="Label (optional)"
            style={{
              flex: 1,
              background: '#141517',
              border: '1px solid #4ade80',
              borderRadius: 3,
              color: '#c9cdd1',
              fontSize: 12,
              padding: '1px 4px',
              outline: 'none',
              minWidth: 0,
            }}
          />
        ) : (
          <span style={{ flex: 1, fontSize: 12, color: isFocused ? '#c9cdd1' : '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {name}
          </span>
        )}
      </div>

      {menu && (
        <PaneContextMenu
          pane={pane}
          x={menu.x}
          y={menu.y}
          canMoveToNewTab={!isOnlyPane}
          onClose={() => setMenu(null)}
          onRename={() => { startRename(); setMenu(null) }}
          onClosePane={() => { closePane(pane.id); setMenu(null) }}
          onMoveToNewTab={() => { movePaneToNewTab(pane.id); setMenu(null) }}
        />
      )}
    </>
  )
}

// --- Pane context menu ---

function PaneContextMenu({
  pane,
  x,
  y,
  canMoveToNewTab,
  onClose,
  onRename,
  onClosePane,
  onMoveToNewTab,
}: {
  pane: PaneLeaf
  x: number
  y: number
  canMoveToNewTab: boolean
  onClose: () => void
  onRename: () => void
  onClosePane: () => void
  onMoveToNewTab: () => void
}): JSX.Element {
  function copyToClipboard(text: string) {
    if (window.ipc) {
      window.ipc.invoke('shell:copy-to-clipboard', text).catch(() => {})
    } else {
      navigator.clipboard.writeText(text).catch(() => {})
    }
  }

  const items: Array<{ label: string; action: () => void; danger?: boolean } | null> = [
    { label: 'Rename', action: onRename },
    ...(canMoveToNewTab ? [{ label: 'Open in new tab', action: onMoveToNewTab }] : []),
    null,
    { label: 'Close pane', action: onClosePane, danger: true },
    null,
    { label: 'Open folder', action: () => window.ipc?.invoke('shell:open-folder', pane.cwd).catch(() => {}) },
    { label: 'Copy path', action: () => copyToClipboard(pane.cwd) },
    ...(pane.sessionId
      ? [{ label: 'Copy session ID', action: () => copyToClipboard(pane.sessionId!) }]
      : []
    ),
  ]

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 100 }} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div style={{ position: 'fixed', left: x, top: y, zIndex: 101, backgroundColor: '#1e2022', border: '1px solid #2a2b2e', borderRadius: 6, padding: '4px 0', minWidth: 180, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
        {items.map((item, i) =>
          item === null ? (
            <div key={i} style={{ height: 1, backgroundColor: '#2a2b2e', margin: '4px 0' }} />
          ) : (
            <button
              key={i}
              onClick={() => { item.action(); onClose() }}
              style={{ display: 'block', width: '100%', padding: '6px 12px', background: 'none', border: 'none', textAlign: 'left', fontSize: 12, color: item.danger ? '#f87171' : '#c9cdd1', cursor: 'pointer' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#2a2b2e' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent' }}
            >
              {item.label}
            </button>
          )
        )}
      </div>
    </>
  )
}

// --- Tab context menu (right-click on section header) ---

function TabContextMenu({
  tabId,
  tabs,
  x,
  y,
  onClose,
  onRename,
  onCloseTab,
  onChangeDefaultDir,
}: {
  tabId: string
  tabs: Tab[]
  x: number
  y: number
  onClose: () => void
  onRename: (id: string) => void
  onCloseTab: (id: string) => void
  onChangeDefaultDir: (id: string) => void
}): JSX.Element {
  const tab = tabs.find((t) => t.id === tabId)
  const defaultDirLabel = tab?.defaultCwd
    ? `Change Default Directory  (${tab.defaultCwd.split(/[\\/]/).pop()})`
    : 'Set Default Directory'

  function btn(label: string, onClick: () => void, danger = false): JSX.Element {
    return (
      <button
        onClick={onClick}
        style={{ display: 'block', width: '100%', padding: '6px 12px', background: 'none', border: 'none', textAlign: 'left', fontSize: 12, color: danger ? '#f87171' : '#c9cdd1', cursor: 'pointer' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#2a2b2e' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent' }}
      >
        {label}
      </button>
    )
  }

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 100 }} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div style={{ position: 'fixed', left: x, top: y, zIndex: 101, backgroundColor: '#1e2022', border: '1px solid #2a2b2e', borderRadius: 6, padding: '4px 0', minWidth: 200, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
        {btn('Rename', () => { onRename(tabId); onClose() })}
        {btn(defaultDirLabel, () => { onChangeDefaultDir(tabId); onClose() })}
        <div style={{ height: 1, backgroundColor: '#2a2b2e', margin: '4px 0' }} />
        {btn('Close tab', () => onCloseTab(tabId), true)}
      </div>
    </>
  )
}
