import React, { useState } from 'react'
import type { PaneLeaf, Session, Tab } from '../../../../shared/types'
import { usePanesStore } from '../../store/panes'
import { useSessionsStore } from '../../store/sessions'
import { SidebarSection } from './SidebarSection'
import { computeLabels, collectLeaves, paneLabelText } from '../../utils/tabLabels'

export function TabSections(): JSX.Element {
  const tabs = usePanesStore((s) => s.tabs)
  const activeTabId = usePanesStore((s) => s.activeTabId)
  const sessions = useSessionsStore((s) => s.sessions)
  const closeTab = usePanesStore((s) => s.closeTab)

  const tabLabels = computeLabels(tabs, sessions)

  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)

  if (tabs.length === 0) return <></>

  return (
    <>
      {tabs.map((tab) => {
        const label = tabLabels.get(tab.id) ?? 'Tab'
        const leaves = tab.rootNode ? collectLeaves(tab.rootNode) : []
        const isActive = tab.id === activeTabId

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
          x={tabMenu.x}
          y={tabMenu.y}
          onClose={() => setTabMenu(null)}
          onCloseTab={(id) => { closeTab(id); setTabMenu(null) }}
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

  const setActiveTab = usePanesStore((s) => s.setActiveTab)
  const focusPane = usePanesStore((s) => s.focusPane)
  const closePane = usePanesStore((s) => s.closePane)
  const movePaneToNewTab = usePanesStore((s) => s.movePaneToNewTab)

  const name = paneLabelText(pane, sessions)
  const isOnlyPane = !tab.rootNode || collectLeaves(tab.rootNode).length <= 1

  return (
    <>
      <div
        onClick={() => { setActiveTab(tab.id); focusPane(pane.id) }}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }) }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={pane.cwd}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 12px 5px 16px',
          margin: '1px 4px',
          borderRadius: 4,
          cursor: 'pointer',
          backgroundColor: isFocused ? '#242528' : hovered ? '#1e2022' : 'transparent',
          transition: 'background-color 0.1s',
        }}
      >
        {pane.paneType === 'claude' ? (
          <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: '#4ade80', flexShrink: 0, display: 'inline-block' }} />
        ) : (
          <span style={{ width: 8, height: 8, borderRadius: '50%', border: '1.5px solid #6b7280', flexShrink: 0, display: 'inline-block', opacity: 0.8 }} />
        )}
        <span style={{ flex: 1, fontSize: 12, color: isFocused ? '#c9cdd1' : '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {name}
        </span>
      </div>

      {menu && (
        <PaneContextMenu
          pane={pane}
          x={menu.x}
          y={menu.y}
          canMoveToNewTab={!isOnlyPane}
          onClose={() => setMenu(null)}
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
  onClosePane,
  onMoveToNewTab,
}: {
  pane: PaneLeaf
  x: number
  y: number
  canMoveToNewTab: boolean
  onClose: () => void
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
    ...(canMoveToNewTab ? [{ label: 'Open in new tab', action: onMoveToNewTab }] : []),
    ...(canMoveToNewTab ? [null] : []),
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
  x,
  y,
  onClose,
  onCloseTab,
}: {
  tabId: string
  x: number
  y: number
  onClose: () => void
  onCloseTab: (id: string) => void
}): JSX.Element {
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 100 }} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div style={{ position: 'fixed', left: x, top: y, zIndex: 101, backgroundColor: '#1e2022', border: '1px solid #2a2b2e', borderRadius: 6, padding: '4px 0', minWidth: 160, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
        <button
          onClick={() => onCloseTab(tabId)}
          style={{ display: 'block', width: '100%', padding: '6px 12px', background: 'none', border: 'none', textAlign: 'left', fontSize: 12, color: '#f87171', cursor: 'pointer' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#2a2b2e' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent' }}
        >
          Close tab
        </button>
      </div>
    </>
  )
}
