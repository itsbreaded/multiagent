import React, { useRef, useState } from 'react'
import { usePanesStore } from '../../store/panes'
import { useSessionsStore } from '../../store/sessions'
import type { Tab } from '../../../../shared/types'

function getTabLabel(tab: Tab, sessions: ReturnType<typeof useSessionsStore.getState>['sessions']): string {
  // Try to get the session name from the focused pane
  if (tab.rootNode.type === 'leaf') {
    const leaf = tab.rootNode
    if (leaf.sessionId) {
      const session = sessions.find((s) => s.sessionId === leaf.sessionId)
      if (session) return session.projectName.split('/').pop() ?? session.projectName
    }
    // Use the last segment of cwd
    return leaf.cwd.replace(/\\/g, '/').split('/').pop() ?? leaf.cwd
  }
  return 'Tab'
}

function hasLiveSession(tab: Tab, sessions: ReturnType<typeof useSessionsStore.getState>['sessions']): boolean {
  if (tab.rootNode.type === 'leaf' && tab.rootNode.sessionId) {
    const session = sessions.find((s) => s.sessionId === tab.rootNode.sessionId)
    return session?.status === 'live-attached' || session?.status === 'live-detached'
  }
  return false
}

export function TabBar(): JSX.Element {
  const tabs = usePanesStore((s) => s.tabs)
  const activeTabId = usePanesStore((s) => s.activeTabId)
  const setActiveTab = usePanesStore((s) => s.setActiveTab)
  const closeTab = usePanesStore((s) => s.closeTab)
  const addTab = usePanesStore((s) => s.addTab)
  const sessions = useSessionsStore((s) => s.sessions)

  // Drag reorder state
  const dragIndex = useRef<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const tabsArr = usePanesStore((s) => s.tabs)

  return (
    <div
      style={{
        height: 36,
        backgroundColor: '#141517',
        borderBottom: '1px solid #2a2b2e',
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 8,
        paddingRight: 8,
        flexShrink: 0,
        gap: 2,
        overflow: 'hidden',
      }}
    >
      {tabs.map((tab, idx) => {
        const isActive = tab.id === activeTabId
        const label = getTabLabel(tab, sessions)
        const live = hasLiveSession(tab, sessions)

        return (
          <div
            key={tab.id}
            draggable
            onDragStart={() => { dragIndex.current = idx }}
            onDragOver={(e) => { e.preventDefault(); setDragOverIndex(idx) }}
            onDragLeave={() => setDragOverIndex(null)}
            onDrop={() => {
              if (dragIndex.current !== null && dragIndex.current !== idx) {
                // Reorder tabs
                usePanesStore.setState((s) => {
                  const next = [...s.tabs]
                  const [moved] = next.splice(dragIndex.current!, 1)
                  next.splice(idx, 0, moved)
                  return { tabs: next }
                })
              }
              dragIndex.current = null
              setDragOverIndex(null)
            }}
            onClick={() => setActiveTab(tab.id)}
            onAuxClick={(e) => { if (e.button === 1) closeTab(tab.id) }}
            style={{
              height: 28,
              padding: '0 10px',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              borderRadius: '4px 4px 0 0',
              backgroundColor: isActive ? '#1e2022' : 'transparent',
              borderBottom: isActive ? '2px solid #4ade80' : '2px solid transparent',
              border: isActive ? '1px solid #2a2b2e' : '1px solid transparent',
              borderBottomColor: isActive ? '#4ade80' : 'transparent',
              fontSize: 12,
              color: isActive ? '#e2e4e6' : '#6b7280',
              cursor: 'pointer',
              userSelect: 'none',
              flexShrink: 0,
              outline: dragOverIndex === idx ? '1px dashed #4ade80' : 'none',
              transition: 'color 0.1s',
              position: 'relative',
            }}
          >
            {live && (
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  backgroundColor: '#4ade80',
                  flexShrink: 0,
                }}
              />
            )}
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 120,
              }}
            >
              {label}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
              style={{
                background: 'none',
                border: 'none',
                color: '#5a5c61',
                cursor: 'pointer',
                padding: 0,
                fontSize: 14,
                lineHeight: 1,
                display: 'flex',
                alignItems: 'center',
                marginLeft: 2,
              }}
              title="Close tab"
            >
              ×
            </button>
          </div>
        )
      })}

      <button
        onClick={() => addTab()}
        title="New tab (Ctrl+T)"
        style={{
          marginLeft: 4,
          width: 24,
          height: 24,
          borderRadius: 4,
          border: '1px dashed #2a2b2e',
          backgroundColor: 'transparent',
          color: '#5a5c61',
          cursor: 'pointer',
          fontSize: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.color = '#c9cdd1'
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.color = '#5a5c61'
        }}
      >
        +
      </button>
    </div>
  )
}
