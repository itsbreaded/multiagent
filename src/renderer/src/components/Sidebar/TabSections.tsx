import React, { useState } from 'react'
import { usePanesStore } from '../../store/panes'
import { useSessionsStore } from '../../store/sessions'
import { SidebarSection } from './SidebarSection'
import { computeLabels, collectLeaves, paneLabelText } from '../../utils/tabLabels'

export function TabSections(): JSX.Element {
  const tabs = usePanesStore((s) => s.tabs)
  const activeTabId = usePanesStore((s) => s.activeTabId)
  const setActiveTab = usePanesStore((s) => s.setActiveTab)
  const focusPane = usePanesStore((s) => s.focusPane)
  const sessions = useSessionsStore((s) => s.sessions)

  const tabLabels = computeLabels(tabs, sessions)

  if (tabs.length === 0) return <></>

  return (
    <>
      {tabs.map((tab) => {
        const label = tabLabels.get(tab.id) ?? 'Shell'
        const leaves = collectLeaves(tab.rootNode)
        const isActive = tab.id === activeTabId

        return (
          <SidebarSection
            key={tab.id}
            title={label}
            count={leaves.length > 1 ? leaves.length : undefined}
            defaultOpen={isActive}
          >
            {leaves.map((pane) => {
              const isClaude = pane.paneType === 'claude'
              const isFocused = isActive && pane.id === tab.focusedPaneId
              const name = paneLabelText(pane, sessions)

              return (
                <PaneRow
                  key={pane.id}
                  name={name}
                  isClaude={isClaude}
                  isFocused={isFocused}
                  cwd={pane.cwd}
                  onClick={() => { setActiveTab(tab.id); focusPane(pane.id) }}
                />
              )
            })}
          </SidebarSection>
        )
      })}
    </>
  )
}

function PaneRow({
  name,
  isClaude,
  isFocused,
  cwd,
  onClick,
}: {
  name: string
  isClaude: boolean
  isFocused: boolean
  cwd: string
  onClick: () => void
}): JSX.Element {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={cwd}
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
      {isClaude ? (
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            backgroundColor: '#4ade80',
            flexShrink: 0,
            display: 'inline-block',
          }}
        />
      ) : (
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            border: '1.5px solid #6b7280',
            flexShrink: 0,
            display: 'inline-block',
            opacity: 0.8,
          }}
        />
      )}
      <span
        style={{
          flex: 1,
          fontSize: 12,
          color: isFocused ? '#c9cdd1' : '#6b7280',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {name}
      </span>
    </div>
  )
}
