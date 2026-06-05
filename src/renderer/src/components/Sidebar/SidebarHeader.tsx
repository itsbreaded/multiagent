import React from 'react'
import { usePanesStore } from '../../store/panes'

export function SidebarHeader(): JSX.Element {
  const toggleSidebar = usePanesStore((s) => s.toggleSidebar)

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 12px 8px',
        borderBottom: '1px solid #2a2b2e',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: '#8b8d91',
          userSelect: 'none',
          letterSpacing: '0.02em',
        }}
      >
        MultiAgent
      </span>
      <button
        onClick={toggleSidebar}
        title="Collapse sidebar (Ctrl+B)"
        style={{
          background: 'none',
          border: 'none',
          color: '#5a5c61',
          cursor: 'pointer',
          padding: '2px 4px',
          borderRadius: 3,
          fontSize: 14,
          lineHeight: 1,
        }}
      >
        {'<'}
      </button>
    </div>
  )
}
