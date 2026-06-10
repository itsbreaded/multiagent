import React, { useState } from 'react'
import type { PaneLeaf, Session, Tab } from '../../../../shared/types'
import { tabSidebarSectionId, usePanesStore } from '../../store/panes'
import { useSessionsStore } from '../../store/sessions'
import { SidebarSection } from './SidebarSection'
import { computeLabels, collectLeaves, paneLabelText } from '../../utils/tabLabels'
import { agentAccent, agentBadge, agentLabel } from '../../utils/agents'
import { displayGitBranch } from '../../utils/git'
import { DirPicker } from '../DirPicker'
import { useGitBranch } from '../../hooks/useGitBranch'
import { useSettingsStore } from '../../store/settings'
import { border, menuStyles, ui } from '../../styles/theme'

export function TabSections(): JSX.Element {
  const tabs = usePanesStore((s) => s.tabs)
  const activeTabId = usePanesStore((s) => s.activeTabId)
  const sidebarSectionOpen = usePanesStore((s) => s.sidebarSectionOpen)
  const sessions = useSessionsStore((s) => s.sessions)
  const closeTab = usePanesStore((s) => s.closeTab)
  const renameTab = usePanesStore((s) => s.renameTab)
  const setTabDefaultCwd = usePanesStore((s) => s.setTabDefaultCwd)
  const setSidebarSectionOpen = usePanesStore((s) => s.setSidebarSectionOpen)
  const draggedPaneId = usePanesStore((s) => s.draggedPaneId)
  const movePaneToTab = usePanesStore((s) => s.movePaneToTab)

  const tabLabels = computeLabels(tabs, sessions)

  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const [dirPickerTabId, setDirPickerTabId] = useState<string | null>(null)
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [dropTabId, setDropTabId] = useState<string | null>(null)

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
        const sectionId = tabSidebarSectionId(tab.id)
        const open = sidebarSectionOpen[sectionId] ?? sidebarSectionOpen[tab.id] ?? isActive

        return (
          <SidebarSection
            key={tab.id}
            title={label}
            count={leaves.length > 1 ? leaves.length : undefined}
            open={open}
            onOpenChange={(next) => setSidebarSectionOpen(sectionId, next)}
            onContextMenu={(e) => {
              e.preventDefault()
              setTabMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
            }}
            renaming={isRenaming}
            renameValue={isRenaming ? renameValue : undefined}
            onRenameChange={setRenameValue}
            onRenameCommit={commitRename}
            onRenameCancel={() => setRenamingTabId(null)}
            headerDropActive={dropTabId === tab.id}
            onHeaderDragOver={(e) => {
              if (!draggedPaneId) return
              e.preventDefault()
              e.stopPropagation()
              setDropTabId(tab.id)
            }}
            onHeaderDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTabId(null)
            }}
            onHeaderDrop={(e) => {
              if (!draggedPaneId) return
              e.preventDefault()
              e.stopPropagation()
              movePaneToTab(draggedPaneId, tab.id)
              setDropTabId(null)
            }}
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
  const draggedPaneId = usePanesStore((s) => s.draggedPaneId)
  const setDraggedPane = usePanesStore((s) => s.setDraggedPane)
  const movePaneToSplit = usePanesStore((s) => s.movePaneToSplit)
  const showGitBranchBadges = useSettingsStore((s) => s.showGitBranchBadges)

  const name = paneLabelText(pane, sessions)
  const session = pane.agentKind && pane.sessionId
    ? sessions.find((s) => s.agentKind === pane.agentKind && s.sessionId === pane.sessionId)
    : null
  const cwdBranch = useGitBranch(pane.cwd, showGitBranchBadges)
  const branch = showGitBranchBadges ? displayGitBranch(session?.gitBranch) ?? displayGitBranch(cwdBranch) : null
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
        draggable={!renaming}
        onDragStart={(e) => {
          if (renaming) return
          e.stopPropagation()
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', pane.id)
          setDraggedPane(pane.id)
        }}
        onDragEnd={() => setDraggedPane(null)}
        onDragOver={(e) => {
          if (!draggedPaneId || draggedPaneId === pane.id) return
          e.preventDefault()
          e.stopPropagation()
          setHovered(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setHovered(false)
        }}
        onDrop={(e) => {
          if (!draggedPaneId || draggedPaneId === pane.id) return
          e.preventDefault()
          e.stopPropagation()
          movePaneToSplit(draggedPaneId, pane.id, 'vertical', false)
          setHovered(false)
        }}
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
          backgroundColor: isFocused ? ui.color.control : hovered ? ui.color.panelRaised : 'transparent',
          transition: 'background-color 0.1s',
        }}
      >
        {pane.paneType === 'agent' && pane.agentKind ? (
          <span
            title={agentLabel(pane.agentKind)}
            style={{
              width: 14,
              height: 14,
              borderRadius: 3,
              border: `1px solid ${agentAccent(pane.agentKind)}`,
              color: agentAccent(pane.agentKind),
              fontSize: 9,
              fontWeight: 700,
              fontFamily: 'monospace',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            {agentBadge(pane.agentKind)}
          </span>
        ) : (
          <span style={{ width: 8, height: 8, borderRadius: '50%', border: `1.5px solid ${ui.color.textMuted}`, flexShrink: 0, display: 'inline-block', opacity: 0.8 }} />
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
              background: ui.color.input,
              border: border.accent,
              borderRadius: 3,
              color: ui.color.text,
              fontSize: 12,
              padding: '1px 4px',
              outline: 'none',
              minWidth: 0,
            }}
          />
        ) : (
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: isFocused ? ui.color.text : ui.color.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {name}
            </div>
            {branch && (
              <div style={{ display: 'flex', marginTop: 2 }}>
                <span
                  style={{
                    fontSize: 10,
                    color: ui.color.textDim,
                    backgroundColor: ui.color.badge,
                    border: border.default,
                    borderRadius: 3,
                    padding: '0 4px',
                    lineHeight: '14px',
                    maxWidth: 88,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {branch}
                </span>
              </div>
            )}
          </div>
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
      <div style={menuStyles.backdrop} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div style={{ ...menuStyles.panel, left: x, top: y, minWidth: 180 }}>
        {items.map((item, i) =>
          item === null ? (
            <div key={i} style={{ ...menuStyles.separator, margin: '4px 0' }} />
          ) : (
            <button
              key={i}
              onClick={() => { item.action(); onClose() }}
              style={{ ...menuStyles.item, display: 'block', color: item.danger ? ui.color.danger : ui.color.text, cursor: 'pointer' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = ui.color.border }}
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
        style={{ ...menuStyles.item, display: 'block', color: danger ? ui.color.danger : ui.color.text, cursor: 'pointer' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = ui.color.border }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent' }}
      >
        {label}
      </button>
    )
  }

  return (
    <>
      <div style={menuStyles.backdrop} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div style={{ ...menuStyles.panel, left: x, top: y, minWidth: 200 }}>
        {btn('Rename', () => { onRename(tabId); onClose() })}
        {btn(defaultDirLabel, () => { onChangeDefaultDir(tabId); onClose() })}
        <div style={{ ...menuStyles.separator, margin: '4px 0' }} />
        {btn('Close tab', () => onCloseTab(tabId), true)}
      </div>
    </>
  )
}
